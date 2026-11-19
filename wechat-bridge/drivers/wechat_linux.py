from media_auth import sign as sign_media
import asyncio
import hashlib
import glob
import json
import logging
import os
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from drivers.base import Driver
from msgs import to_text

log = logging.getLogger("wechat_linux")

# 群消息内容形如 "wxid_xxx:\n真正的内容"
_GROUP_PREFIX = __import__("re").compile(r"^([A-Za-z0-9_\-]+):\n")


class WeChatLinuxDriver(Driver):
    """基于官方 Linux 微信客户端：读=解密数据库，发=xdotool 键鼠自动化。"""

    name = "wechat_linux"
    capabilities = {"text": True, "image": True, "emoji": False, "record": False, "receive_image": True, "receive_emoji": True}

    def __init__(self, cfg, idmap):
        c = cfg.get("wechat", {}) or {}
        self.db_dir = c.get("db_dir", "")
        self.keys_file = c.get("keys_file", "all_keys.json")
        self.display = c.get("display", ":0")
        self.poll_sec = float(c.get("poll_sec", 2.0))
        self.self_wxid = c.get("self_wxid", "")
        self.idmap = idmap
        self.keys = {}
        self.on_message = None
        self._task = None
        self._last = {}
        self._usernames = {}
        self._names = {}
        self._md5map = {}
        self._map_ts = 0.0
        self._avatars = {}
        self._aliases = {}
        self._a2w = {}
        self._cid2u = {}
        self._room_members = {}
        self._self_sid = None
        self._mid = 700000
        self._send_lock = asyncio.Lock()
        voice_dir = Path(__file__).resolve().parent.parent / 'voice'
        self.capabilities = dict(type(self).capabilities)
        self.capabilities['record'] = (voice_dir / 'enabled').is_file() and (voice_dir / 'sender.py').is_file()

    # ---------------- 基础 ----------------

    def _load_keys(self):
        with open(self.keys_file, "r", encoding="utf-8") as f:
            self.keys = json.load(f)
        log.info("已加载 %d 个数据库密钥", len(self.keys))

    @staticmethod
    def _decode(content):
        """WCDB 对较长的消息内容会用 zstd 压缩，检测魔数并解压。"""
        if isinstance(content, bytes):
            if content[:4] == b"\x28\xb5\x2f\xfd":
                try:
                    import zstandard
                    return zstandard.ZstdDecompressor().decompress(content).decode("utf-8", "replace")
                except Exception:
                    return "[压缩消息解压失败]"
            return content.decode("utf-8", "replace")
        return str(content)

    # ---- 消息类型渲染 ----
    _TYPE_NAME = {
        3: "图片", 34: "语音", 42: "名片", 43: "视频", 47: "表情",
        48: "位置", 49: "链接", 50: "视频通话", 10000: "系统消息",
    }
    _APPMSG_TYPE = {
        "4": "链接", "5": "链接", "6": "文件", "8": "表情",
        "17": "实时位置", "19": "聊天记录", "24": "收藏",
        "33": "小程序", "36": "小程序", "44": "视频号",
        "51": "视频号直播", "57": "引用回复", "63": "视频号直播",
    }

    def _uid(self, wxid):
        """给 OneBot 用的可读 ID：优先用微信号。"""
        wxid = str(wxid or "")
        if not wxid or wxid.endswith("@chatroom"):
            return wxid
        return self._aliases.get(wxid) or wxid

    def _resolve(self, cid):
        """把 OneBot 传来的 ID 还原成 wxid。"""
        cid = str(cid or "")
        if not cid:
            return cid
        if cid.endswith("@chatroom") or cid in self._usernames or cid in self._names:
            return cid
        return self._a2w.get(cid) or self.idmap.to_ext(cid) or cid

    def _room_display(self, room):
        """群名；没设名字就列出成员昵称（微信就是这么显示的）。"""
        name = (self._names.get(room) or "").strip()
        if name and name != room:
            return name
        members = []
        try:
            con = self._connect("contact.db")
            rid = con.execute("SELECT id FROM contact WHERE username = ?", (room,)).fetchone()
            if rid:
                for (mid,) in con.execute("SELECT member_id FROM chatroom_member WHERE room_id = ?", (rid[0],)).fetchall():
                    un = self._cid2u.get(mid)
                    if un and un != self.self_wxid:
                        members.append(self._names.get(un) or un)
            con.close()
        except Exception:
            pass
        if members:
            return "、".join(members[:4])
        return str(room)

    def _display(self, wxid):
        """昵称(微信号)；群聊无名时用成员名拼出来。"""
        if str(wxid).endswith("@chatroom"):
            return self._room_display(wxid)
        name = self._names.get(wxid) or self._usernames.get(wxid) or wxid
        alias = self._aliases.get(wxid)
        if alias and alias != name:
            return name + "(" + alias + ")"
        return name

    def _fetch_emoji(self, xml):
        """表情包(type=47)：XML 里有明文 cdnurl，直接下载就是图片。"""
        import re as _re
        import urllib.request
        m = _re.search(r'cdnurl\s*=\s*"([^"]+)"', xml)
        if not m:
            return None
        url = m.group(1).replace("&amp;", "&")
        mid = _re.search(r'md5\s*=\s*"([0-9a-f]+)"', xml)
        name = (mid.group(1) if mid else str(int(time.time()))) + ".png"
        path = os.path.join("/tmp/wxemoji", name)
        try:
            if os.path.exists(path) and os.path.getsize(path) > 100:
                return path
            os.makedirs("/tmp/wxemoji", exist_ok=True)
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            data = urllib.request.urlopen(req, timeout=20).read()
            if len(data) < 100:
                return None
            open(path, "wb").write(data)
            log.info("表情包已下载: %s (%d 字节)", name, len(data))
            return path
        except Exception as e:
            log.warning("表情包下载失败: %s", str(e)[:80])
            return None

    # ---------------- 微信图片解密（V4/V2 格式） ----------------
    _IMG_AESKEY = None
    _IMG_XORKEY = 0x37

    def _img_keys(self):
        """AES 密钥从文件读；XOR 密钥按 Go 的做法从 _t.dat 尾部推。"""
        import struct as _st
        if self._IMG_AESKEY is None:
            try:
                self._IMG_AESKEY = bytes.fromhex(open(os.path.join(os.path.dirname(self.keys_file),"imgkey.txt")).read().strip())
                log.info("图片 AES 密钥已加载")
            except Exception as e:
                log.warning("读 imgkey.txt 失败: %s", e)
                return None
            from collections import Counter
            c = Counter()
            for f in glob.glob(os.path.join(self.db_dir, "..", "msg", "attach", "*", "*", "Img", "*_t.dat"))[:40]:
                try:
                    raw = open(f, "rb").read()
                    if raw[:4] != b"\x07\x08V2" or len(raw) < 2:
                        continue
                    xl = _st.unpack_from("<I", raw, 10)[0]
                    if xl == 0:
                        continue
                    seg = raw[len(raw) - xl:]
                    a, b = seg[-2] ^ 0xFF, seg[-1] ^ 0xD9
                    if a == b:
                        c[a] += 1
                except Exception:
                    pass
            if c:
                self._IMG_XORKEY = c.most_common(1)[0][0]
            log.info("图片 XOR 密钥 = 0x%02x", self._IMG_XORKEY)
        return self._IMG_AESKEY

    def _decrypt_dat(self, path):
        """解密一个 .dat，返回图片字节（失败返回 None）。"""
        import struct as _st
        from cryptography.hazmat.primitives.ciphers import Cipher as _C, algorithms as _A, modes as _M
        key = self._img_keys()
        if not key:
            return None
        try:
            raw = open(path, "rb").read()
        except Exception:
            return None
        if raw[:4] != b"\x07\x08V2":
            return None
        aes_len = _st.unpack_from("<I", raw, 6)[0]
        xor_len = _st.unpack_from("<I", raw, 10)[0]
        fd = raw[15:]
        aes0 = (aes_len // 16) * 16 + 16
        if aes0 > len(fd):
            aes0 = len(fd)
        try:
            dec = _C(_A.AES(key), _M.ECB()).decryptor().update(fd[:aes0])
        except Exception:
            return None
        out = bytearray(dec[:aes_len])
        ms, me = aes0, len(fd) - xor_len
        if ms < me:
            out += fd[ms:me]
        if xor_len > 0 and me < len(fd):
            out += bytes(b ^ self._IMG_XORKEY for b in fd[me:])
        out = bytes(out)
        if out[:4] == b"wxgf":
            j = self._wxgf_to_jpg(out)
            if j:
                log.info("wxgf 已转码为 JPG (%d 字节)", len(j))
                return j
            return None
        if not (out[:3] == b"\xff\xd8\xff" or out[:4] in (b"\x89PNG", b"RIFF") or out[:3] == b"GIF"):
            return None
        return out

    def _image_sizes_for(self, local_id, create_time):
        """从 message_resource.db 查这条消息的所有图片尺寸，原图优先。"""
        try:
            con = self._connect("message_resource.db")
            r = con.execute("SELECT message_id FROM MessageResourceInfo WHERE message_local_id = ?",
                            (int(local_id),)).fetchone()
            if not r:
                con.close(); return []
            rows = con.execute("SELECT size, type FROM MessageResourceDetail WHERE message_id = ?",
                               (r[0],)).fetchall()
            con.close()
            big, thumb, other = [], [], []
            for size, typ in rows:
                if not size or int(size) < 100:
                    continue
                t = int(typ or 0)
                if t == 131073:
                    big.append(int(size))
                elif t == 262145:
                    thumb.append(int(size))
                else:
                    other.append(int(size))
            return big + other + thumb
        except Exception as e:
            log.warning("查图片尺寸失败: %s", str(e)[:60])
            return []

    def _fetch_image(self, uname, local_id, ctime):
        """图片：原图(.dat/WXGF) -> ImageTemp(微信已解码) -> 缩略图，逐级降级。"""
        import struct as _st
        sizes = self._image_sizes_for(local_id, ctime)
        base = os.path.join(self.db_dir, "..", "msg", "attach")
        allc = glob.glob(os.path.join(base, "*", "*", "Img", "*.dat"))
        bysize = {}
        for f in allc:
            try:
                bysize.setdefault(os.path.getsize(f), []).append(f)
            except Exception:
                pass

        # 候选文件：原图优先，缩略图最后
        cands = []
        for sz in sizes:
            for f in bysize.get(sz, []):
                cands.append(f)
        if not cands:
            best = None
            for f in allc:
                try:
                    dt = abs(os.path.getmtime(f) - float(ctime or 0))
                except Exception:
                    continue
                if best is None or dt < best[0]:
                    best = (dt, f)
            if best and best[0] < 600:
                cands = [best[1]]
        cands.sort(key=lambda f: f.endswith("_t.dat"))

        data = None
        # ① 原图（.dat）
        for f in [x for x in cands if not x.endswith("_t.dat")]:
            data = self._decrypt_dat(f)
            if data:
                log.info("原图解密成功: %s (%d 字节)", os.path.basename(f), len(data))
                break
        # ② 微信已解码的中间图（明文 wxgf，通常是全分辨率）
        if not data:
            it = self._find_imagetemp(uname, ctime)
            if it:
                try:
                    data = self._wxgf_to_jpg(open(it, "rb").read())
                    if data:
                        log.info("用微信解码缓存成功: %s (%d 字节)", os.path.basename(it), len(data))
                except Exception as e:
                    log.warning("ImageTemp 处理失败: %s", str(e)[:60])
        # ③ 缩略图（低分辨率兜底）
        if not data:
            for f in [x for x in cands if x.endswith("_t.dat")]:
                data = self._decrypt_dat(f)
                if data:
                    log.info("缩略图解密成功: %s (%d 字节)", os.path.basename(f), len(data))
                    break
        if not data:
            log.warning("图片全部方式解不开 (local_id=%s)", local_id)
            return None
        ext = "jpg" if data[:3] == b"\xff\xd8\xff" else ("png" if data[:4] == b"\x89PNG" else "gif")
        os.makedirs("/tmp/wxemoji", exist_ok=True)
        out = "/tmp/wxemoji/" + hashlib.md5(data).hexdigest() + "." + ext
        if not os.path.exists(out):
            open(out, "wb").write(data)
        return out

    @staticmethod
    def _wxgf_to_jpg(data):
        """微信 wxgf = 容器 + HEVC 流，用 ffmpeg 转 JPG。"""
        import struct as _st
        import subprocess as _sp
        if len(data) < 16 or data[:4] != b"wxgf":
            return None
        hlen = data[4]
        for pat in (b"\x00\x00\x00\x01", b"\x00\x00\x01"):
            parts, off = [], 0
            while True:
                if hlen + off > len(data):
                    break
                i = data.find(pat, hlen + off)
                if i < 0:
                    break
                if i >= 4:
                    ln = _st.unpack_from(">I", data, i - 4)[0]
                    if 0 < ln and i + ln <= len(data):
                        parts.append((i, ln, ln / len(data)))
                        off += (i - (hlen + off)) + ln
                        continue
                off += (i - (hlen + off)) + 1
            if parts:
                o, l, _r = max(parts, key=lambda x: x[2])
                try:
                    pr = _sp.run(["ffmpeg", "-hide_banner", "-loglevel", "error",
                                  "-i", "-", "-vframes", "1", "-c:v", "mjpeg",
                                  "-q:v", "3", "-f", "image2", "-"],
                                 input=data[o:o + l], capture_output=True, timeout=90)
                    if pr.returncode == 0 and len(pr.stdout) > 100:
                        return pr.stdout
                except Exception as e:
                    log.warning("wxgf 转码失败: %s", str(e)[:60])
                return None
        return None

    def _find_imagetemp(self, uname, ctime):
        """微信解码图片时会写 cache/.../ImageTemp/*_temp_convert（明文 wxgf，通常全分辨率）。"""
        import re as _re
        cm = hashlib.md5(str(uname).encode()).hexdigest()
        base = os.path.join(self.db_dir, "..", "cache")
        best = None
        for f in glob.glob(os.path.join(base, "*", "Message", cm, "ImageTemp", "*_temp_convert")):
            m = _re.search(r"_(\d{9,11})_", os.path.basename(f))
            if m:
                dt = abs(int(m.group(1)) - int(ctime or 0))
            else:
                try:
                    dt = abs(os.path.getmtime(f) - float(ctime or 0))
                except Exception:
                    continue
            if best is None or dt < best[0]:
                best = (dt, f)
        return best[1] if (best and best[0] < 900) else None

    def _render(self, ltype, txt):
        """把微信的原始消息内容转成可读文本。base 类型 = ltype & 0xFFFF。"""
        try:
            base = int(ltype) & 0xFFFF
        except Exception:
            base = 0
        if base == 1:
            return txt
        raw = txt if isinstance(txt, str) else str(txt)
        if base == 49:
            import re as _re
            title = _re.search(r"<title>(.*?)</title>", raw, _re.S)
            sub = _re.search(r"<type>(\d+)</type>", raw, _re.S)
            name = self._APPMSG_TYPE.get(sub.group(1), "链接") if sub else "链接"
            t = title.group(1).strip() if title else ""
            t = _re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", t).strip()
            return "[" + name + "] " + t if t else ("[" + name + "]")
        if base == 47:
            import re as _re
            m = _re.search(r'md5\s*=\s*"([0-9a-f]+)"', raw)
            return "[表情" + (":" + m.group(1)[:8] if m else "") + "]"
        if base == 3:
            import re as _re
            w = _re.search(r'cdnthumbwidth\s*=\s*"(\d+)"', raw)
            h = _re.search(r'cdnthumbheight\s*=\s*"(\d+)"', raw)
            if w and h:
                return "[图片 " + w.group(1) + "x" + h.group(1) + "]"
            return "[图片]"
        name = self._TYPE_NAME.get(base)
        if name:
            return "[" + name + "]"
        return "[未知消息 type=" + str(ltype) + "]"

    def _dbpath(self, dbname):
        """数据库在子目录里（session/session.db），但也有同名空壳文件，要挑真正的那个。"""
        stem = dbname[:-3] if dbname.endswith(".db") else dbname
        sub = "message" if ("message" in stem) else stem
        cands = [
            os.path.join(self.db_dir, sub, dbname),
            os.path.join(self.db_dir, dbname),
        ]
        for c in cands:
            try:
                if os.path.exists(c) and os.path.getsize(c) > 4096:
                    return c
            except Exception:
                pass
        try:
            for d in os.listdir(self.db_dir):
                c = os.path.join(self.db_dir, d, dbname)
                if os.path.exists(c) and os.path.getsize(c) > 4096:
                    return c
        except Exception:
            pass
        return cands[0]

    def _connect(self, dbname):
        from sqlcipher3 import dbapi2 as sq
        path = self._dbpath(dbname)
        con = sq.connect(path)
        con.execute("PRAGMA key = \"x'" + self.keys[dbname] + "'\"")
        con.execute("PRAGMA cipher_compatibility = 4")
        return con

    def _build_name_maps(self):
        try:
            con = self._connect("contact.db")
            cols = [r[1] for r in con.execute("PRAGMA table_info(contact)").fetchall()]
            ucol = "username" if "username" in cols else cols[0]
            picks = [c for c in ("remark", "nick_name", "alias", "small_head_url", "big_head_url") if c in cols]
            sel = ", ".join([ucol] + picks)
            for row in con.execute("SELECT " + sel + " FROM contact").fetchall():
                u = row[0]
                if not u:
                    continue
                d = dict(zip(picks, row[1:]))
                from urllib.parse import urlparse
                avatar = (d.get("small_head_url") or d.get("big_head_url") or "").strip()
                parsed_avatar = urlparse(avatar)
                if parsed_avatar.scheme == "https" and parsed_avatar.hostname == "wx.qlogo.cn":
                    self._avatars[u] = avatar
                alias = (d.get("alias") or "").strip()
                if alias:
                    self._aliases[u] = alias
                    self._a2w[alias] = u
                name = ""
                for key in ("remark", "nick_name", "alias"):
                    v = d.get(key)
                    if v:
                        name = v
                        break
                self._usernames[u] = name or u
            con.close()
        except Exception as e:
            log.warning("读 contact.db 失败: %s", e)

        try:
            con = self._connect("session.db")
            for row in con.execute("SELECT username FROM SessionTable").fetchall():
                u = row[0]
                if u and u not in self._usernames:
                    self._usernames[u] = u
            con.close()
        except Exception as e:
            log.warning("读 session.db 失败: %s", e)

        try:
            con = self._connect("message_0.db")
            for row in con.execute("SELECT user_name FROM Name2Id").fetchall():
                u = row[0]
                if u and u not in self._usernames:
                    self._usernames[u] = u
            con.close()
        except Exception:
            pass

        # 群成员（用于无名群的显示）
        try:
            con = self._connect("contact.db")
            for cid, un in con.execute("SELECT id, username FROM contact").fetchall():
                self._cid2u[cid] = un
            for rid, mid in con.execute("SELECT room_id, member_id FROM chatroom_member").fetchall():
                self._room_members.setdefault(rid, []).append(mid)
            con.close()
            log.info("群成员: %d 个群", len(self._room_members))
        except Exception as e:
            log.warning("读群成员失败: %s", e)

        for u in list(self._usernames):
            self._names[u] = self._usernames[u]
            self._md5map[hashlib.md5(u.encode()).hexdigest()] = u
        log.info("会话/联系人映射: %d 条", len(self._names))

    # ---------------- 读消息 ----------------

    def _quotes_self(self, con, table, room, raw):
        """Confirm a native WeChat group quote against the original message."""
        if not self._self_sid or not self.self_wxid or "<refermsg" not in raw:
            return False
        try:
            root = ET.fromstring(raw.strip())
            app = root if root.tag == "appmsg" else root.find("./appmsg")
            if app is None or (app.findtext("type") or "").strip() != "57":
                return False
            quote = app.find("refermsg")
            if quote is None:
                return False
            if (quote.findtext("fromusr") or "").strip() != room:
                return False
            if (quote.findtext("chatusr") or "").strip() != self.self_wxid:
                return False
            server_id = int((quote.findtext("svrid") or "").strip())
            if not server_id or not -(2**63) <= server_id < 2**63:
                return False
        except (ET.ParseError, ValueError):
            return False
        return con.execute(
            "SELECT 1 FROM " + table + " WHERE server_id = ? AND real_sender_id = ? LIMIT 1",
            (server_id, self._self_sid),
        ).fetchone() is not None

    def _poll_once(self):
        out = []
        try:
            con = self._connect("message_0.db")
        except Exception as e:
            log.warning("打开 message_0.db 失败: %s", e)
            return out

        try:
            tables = [r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").fetchall()]
            senders = {}
            try:
                for row in con.execute("SELECT rowid, user_name FROM Name2Id").fetchall():
                    senders[row[0]] = row[1]
                if not self._self_sid:
                    r0 = con.execute("SELECT rowid FROM Name2Id WHERE user_name = ?", (self.self_wxid,)).fetchone()
                    self._self_sid = r0[0] if r0 else None
            except Exception:
                pass

            # 先看有没有不认识的表（比如启动后新加的好友/新群）
            unknown = [t for t in tables if t[4:] not in self._md5map]
            if unknown and (time.time() - getattr(self, "_map_ts", 0)) > 20:
                self._map_ts = time.time()
                log.info("发现 %d 个未知会话表，刷新映射表 (如: %s)", len(unknown), unknown[0][:24])
                self._build_name_maps()
                log.info("刷新后映射表: %d 条", len(self._md5map))

            for t in tables:
                suffix = t[4:]
                uname = self._md5map.get(suffix)
                if not uname:
                    log.warning("会话表 %s 仍无法解析用户名，跳过", t[:28])
                    continue
                last = self._last.get(t, 0)
                try:
                    rows = con.execute(
                        "SELECT local_id, create_time, real_sender_id, local_type, message_content "
                        "FROM " + t + " WHERE local_id > ? ORDER BY local_id", (last,)).fetchall()
                except Exception:
                    continue
                for (lid, ctime, sid, ltype, content) in rows:
                    if lid > self._last.get(t, 0):
                        self._last[t] = lid
                    if not content:
                        continue
                    txt = self._decode(content)
                    sender = senders.get(sid, uname)
                    # 群消息带 "wxid_xxx:\n内容" 前缀：剥掉它，并用它确定真实发送者
                    if uname.endswith("@chatroom"):
                        m = _GROUP_PREFIX.match(txt if isinstance(txt, str) else "")
                        if m:
                            who = m.group(1)
                            txt = txt[m.end():]
                            if who:
                                sender = who
                                self._names.setdefault(who, self._usernames.get(who, who))
                    # 自己发的消息必须跳过（否则自我对话死循环）
                    real_sid = senders.get(sid)
                    if self.self_wxid and (sender == self.self_wxid or real_sid == self.self_wxid):
                        continue
                    if self._self_sid is not None and sid == self._self_sid:
                        continue
                    segs = None
                    quotes_self = False
                    try:
                        _bt = int(ltype) & 0xFFFF
                        if _bt == 49 and uname.endswith("@chatroom"):
                            quotes_self = self._quotes_self(con, t, uname, txt)
                        elif _bt == 3:
                            _p = self._fetch_image(uname, lid, ctime)
                            if _p:
                                segs = [{"type": "image", "data": {
                                    "url": "http://wechat-linux:3001/media/" + os.path.basename(_p) + "?" + sign_media(os.path.basename(_p)),
                                }}]
                                log.info("图片已转为 image 消息段: %s", os.path.basename(_p))
                        elif _bt == 47 and isinstance(txt, str):
                            _p = self._fetch_emoji(txt)
                            if _p:
                                _name = os.path.basename(_p)
                                # MaiBot 的适配器只接受 http url 下载，且靠 sub_type 判定是不是表情包
                                # （sub_type 不为 0/4/9 即视为 emoji，会触发"理解表情包情绪"）
                                segs = [{"type": "image", "data": {
                                    "url": "http://wechat-linux:3001/media/" + _name + "?" + sign_media(_name),
                                    "sub_type": 1,
                                }}]
                                log.info("表情包已转为 emoji 消息段: %s", _name)
                    except Exception as _e:
                        log.warning("微信消息段解析失败: %s", str(_e)[:60])
                    txt = self._render(ltype, txt)
                    segs = segs or [{"type": "text", "data": {"text": txt}}]
                    if quotes_self:
                        segs.insert(0, {"type": "at", "data": {"qq": self._uid(self.self_wxid)}})
                    out.append({
                        "chat_type": "group" if uname.endswith("@chatroom") else "private",
                        "chat_id": uname if uname.endswith("@chatroom") else self._uid(uname),
                        "user_id": self._uid(sender),
                        "nickname": self._display(sender),
                        "card": "",
                        "group_name": self._display(uname) if uname.endswith("@chatroom") else "",
                        "segments": segs,
                        "raw": txt,
                        "time": int(ctime) if ctime else int(time.time()),
                        "_username": uname,
                        "_local_id": lid,
                    })
        finally:
            try:
                con.close()
            except Exception:
                pass
        return out

    def _prime(self):
        """记录当前各表的最大 local_id 作为基线，只推送之后的新消息。"""
        try:
            con = self._connect("message_0.db")
            for t in [r[0] for r in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").fetchall()]:
                try:
                    mx = con.execute("SELECT max(local_id) FROM " + t).fetchone()[0] or 0
                    self._last[t] = mx
                except Exception:
                    pass
            con.close()
        except Exception as e:
            log.warning("基线初始化失败: %s", e)

    async def _loop(self):
        while True:
            try:
                msgs = await asyncio.get_event_loop().run_in_executor(None, self._poll_once)
                for m in msgs:
                    log.info("新消息 %s <- %s: %s", m["_username"], m["nickname"], m["raw"][:60])
                    await self.on_message(m)
            except Exception as e:
                log.warning("轮询出错: %s", e)
            await asyncio.sleep(self.poll_sec)

    # ---------------- 发消息 ----------------

    def _session_order(self):
        """从 session.db 读会话列表顺序（和微信界面一致）。"""
        try:
            con = self._connect("session.db")
            rows = con.execute(
                "SELECT username FROM SessionTable ORDER BY sort_timestamp DESC").fetchall()
            con.close()
            return [r[0] for r in rows if r[0]]
        except Exception as e:
            log.warning("读会话顺序失败: %s", e)
            return []

    def _create_chat_window(self, uname, target):
        """尝试双击会话列表创建独立窗口。
        因为最后用「窗口标题」验证，所以点位猜错也不会发错消息（最多多开几个窗口）。
        """
        cands = self._cands(uname, target)
        order = self._session_order()
        if not order or uname not in order:
            return None
        idx = order.index(uname)
        # 实测：第 1 项约在 y=112，每项间距 62~70px（含预览行的高度差异）
        base = 112 + int(round(idx * 66))
        self._activate()
        for dy in (0, -8, 8, -16, 16, -26, 26, -36, 36):
            y = base + dy
            if y < 100 or y > 680:
                continue
            log.info("尝试双击 y=%d 创建 %s 的独立窗口", y, target)
            self._xdo("mousemove", "164", str(y), wait=0.25)
            self._xdo("click", "--repeat", "2", "--delay", "130", "1", wait=2.2)
            w = self._find_chat_window(cands)
            if w:
                log.info("✅ 独立窗口已创建: %s (win=%s)", target, w)
                return w
        log.warning("未能创建 %s 的独立窗口", target)
        return None

    def _cands(self, uname, target):
        """窗口标题的候选名（备注/昵称/微信号/wxid）。"""
        cands = []
        for c in (target, self._names.get(uname), self._aliases.get(uname), uname):
            c = (c or "").strip()
            if c and c not in cands:
                cands.append(c)
                if "(" in c:
                    cands.append(c.split("(")[0].strip())
        return cands

    def _max_local_id(self, uname):
        """读目标会话当前最大 local_id（发送前记录，用于判断新消息）。"""
        t = "Msg_" + hashlib.md5(str(uname).encode()).hexdigest()
        try:
            con = self._connect("message_0.db")
            r = con.execute("SELECT max(local_id) FROM " + t).fetchone()
            con.close()
            return int(r[0] or 0)
        except Exception:
            return 0

    def _verify_async(self, uname, text, before_id, target):
        """后台验证（只记日志，绝不重发）。

        微信写数据库有延迟（实测可达 10 秒以上），如果拿"验证失败"去重发，
        就会产生重复消息。所以发送只做一次，验证仅用于发现/记录问题。
        """
        ok = self._verify_sent(uname, text, timeout=20.0, after_id=before_id)
        if ok:
            log.info("✅ 数据库已确认送达 -> %s", target)
        else:
            log.warning("⚠️ 20 秒内没在数据库里看到这条消息 -> %s（可能只是写入慢，已按已发送处理）", target)

    def _verify_sent(self, uname, text, timeout=6.0, after_id=0):
        """确认消息真的发出去了：只看 local_id > after_id 的新消息。

        关键：不能只看"最新一条" —— 对方可能正在连续发消息，
        最新一条会变成对方的，导致误判失败并重发（会造成重复消息）。
        """
        t = "Msg_" + hashlib.md5(str(uname).encode()).hexdigest()
        want = (text or "").strip()
        end = time.time() + timeout
        while time.time() < end:
            try:
                con = self._connect("message_0.db")
                rows = con.execute(
                    "SELECT message_content FROM " + t + " WHERE local_id > ? ORDER BY local_id",
                    (int(after_id),)).fetchall()
                con.close()
                for r in rows:
                    if r and r[0] and str(self._decode(r[0])).strip() == want:
                        return True
            except Exception:
                pass
            time.sleep(0.35)
        return False

    def _summary(self, uname):
        """读会话列表的预览行（输入框有内容时 = 草稿）。用于确认没走错会话。"""
        try:
            con = self._connect("session.db")
            r = con.execute("SELECT summary FROM SessionTable WHERE username = ?", (uname,)).fetchone()
            con.close()
            return (r[0] or "").strip() if r else ""
        except Exception:
            return ""

    def _navigate_to_chat(self, uname):
        """纯键盘导航：点列表取焦点 -> Up×20 回顶部 -> Down×idx 到目标。"""
        order = self._ui_order()
        if not order or uname not in order:
            return False
        idx = order.index(uname)
        if idx > 12:
            return False
        self._activate()
        self._xdo("mousemove", "164", "300", "click", "1", wait=1.0)
        self._xdo("key", "--repeat", "20", "--delay", "50", "Up", wait=0.5)
        if idx > 0:
            self._xdo("key", "--repeat", str(idx), "--delay", "80", "Down", wait=0.9)
        else:
            time.sleep(0.5)
        return True

    def _ui_order(self):
        """会话列表实际顺序（微信按 sort_timestamp 降序排）。"""
        return self._session_order()

    def _find_chat_window(self, names):
        """按窗口标题查找会话的独立窗口。"""
        env = dict(os.environ)
        env["DISPLAY"] = self.display
        for nm in names:
            if not nm:
                continue
            try:
                r = subprocess.run(["xdotool", "search", "--name", "^" + __import__("re").escape(str(nm)) + "$"],
                                   env=env, capture_output=True, timeout=10)
                ids = [x for x in r.stdout.decode().split() if x.strip()]
                if len(ids)>1:
                    raise RuntimeError("ambiguous chat window title; nothing sent")
                if ids:
                    log.info("按窗口标题找到会话窗口: %s (win=%s)", nm, ids[0])
                    return ids[0]
            except Exception:
                pass
        return None

    def _ensure_chat_window(self, uname, display_name):
        """确保目标会话有独立窗口（没有就在会话列表里双击弹出来）。"""
        cands = []
        for c in (display_name, self._names.get(uname), self._aliases.get(uname), uname):
            c = (c or "").strip()
            if c and c not in cands:
                # 去掉 "备注(微信号)" 里的括号部分作为候选
                cands.append(c)
                if "(" in c:
                    cands.append(c.split("(")[0].strip())
        win = self._find_chat_window(cands)
        if win:
            return win
        order = self._ui_order()
        if not order or uname not in order:
            return None
        idx = order.index(uname)
        if idx > 9:
            log.warning("目标会话在第 %d 项，超出可视范围", idx + 1)
            return None
        y = 112 + 64 * idx
        log.info("会话窗口不存在，双击列表第 %d 项 (y=%d) 弹出", idx + 1, y)
        self._activate()
        self._xdo("mousemove", "164", str(y), wait=0.3)
        self._xdo("click", "--repeat", "2", "--delay", "120", "1", wait=2.5)
        return self._find_chat_window(cands)

    def _open_by_click(self, uname):
        """兼容旧接口：确保会话窗口存在。"""
        return self._ensure_chat_window(uname, self._display(uname)) is not None

    def _xdo(self, *args, wait=0.0):
        env = dict(os.environ)
        env["DISPLAY"] = self.display
        subprocess.run(["xdotool"] + list(args), env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        if wait:
            time.sleep(wait)

    def _clip(self, text):
        env = dict(os.environ)
        env["DISPLAY"] = self.display
        p = subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"),
                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        return p.returncode == 0

    def _activate(self):
        env = dict(os.environ)
        env["DISPLAY"] = self.display
        r = subprocess.run(["xdotool", "search", "--name", "^微信$"], env=env,
                           capture_output=True, timeout=10)
        ids = [x for x in r.stdout.decode().split() if x.strip()]
        if not ids:
            return False
        self._xdo("windowactivate", ids[0], wait=0.6)
        return True

    async def send(self, chat_type, chat_id, segments):
        if not segments:
            raise ValueError("empty message")
        # Validate the complete request before sending its first part.
        for segment in segments:
            if segment.get("type") not in ("text", "at", "image") and not (
                segment.get("type") == "record" and getattr(self, 'capabilities', {}).get("record")
            ):
                raise ValueError("unsupported native WeChat media: " + str(segment.get("type")))
        uname=self._resolve(chat_id)
        if uname not in self._names and uname not in self._usernames and uname not in self._session_order():
            raise ValueError("unknown WeChat destination")
        target=self._display(uname)
        async with self._send_lock:
            for segment in segments:
                data=segment.get("data") or {}
                if segment.get("type")=="image":
                    result=await asyncio.get_running_loop().run_in_executor(None,self._send_image,uname,target,data.get("file") or data.get("url") or "")
                elif segment.get("type") == "record":
                    from voice.sender import send_url
                    result=await asyncio.get_running_loop().run_in_executor(None,send_url,self,uname,target,data.get("file") or data.get("url") or "")
                else:
                    text=to_text([segment])
                    if not text:continue
                    result=await asyncio.get_running_loop().run_in_executor(None,self._do_send,uname,target,text)
                if result is not True:
                    raise RuntimeError("send not confirmed; result unknown; do not retry automatically")
        self._mid+=1
        return self._mid

    def _target_window(self,uname,target):
        win=self._find_chat_window(self._cands(uname,target))
        if not win:win=self._create_chat_window(uname,target)
        if not win:raise RuntimeError("target chat window unavailable; nothing sent")
        self._xdo("windowactivate","--sync",win,wait=0.6)
        return win

    def _verify_outgoing(self,uname,before,kind,text=None,timeout=18):
        table="Msg_"+hashlib.md5(str(uname).encode()).hexdigest()
        end=time.time()+timeout
        while time.time()<end:
            try:
                con=self._connect("message_0.db")
                sid=con.execute("SELECT rowid FROM Name2Id WHERE user_name=?",(self.self_wxid,)).fetchone()
                if not sid:con.close();return False
                rows=con.execute("SELECT local_id,local_type,message_content FROM "+table+" WHERE local_id>? AND real_sender_id=? ORDER BY local_id",(before,sid[0])).fetchall()
                con.close()
                for mid,t,content in rows:
                    if int(t)&0xffff != kind:continue
                    if text is None or str(self._decode(content)).strip()==text.strip():return True
            except Exception:pass
            time.sleep(0.4)
        return False

    def _do_send(self,uname,target,text):
        self._target_window(uname,target)
        before=self._max_local_id(uname)
        if not self._clip(text):raise RuntimeError("clipboard failed; nothing sent")
        self._xdo("key","ctrl+v",wait=0.8)
        self._xdo("key","Return",wait=0.5)
        return self._verify_outgoing(uname,before,1,text)

    def _send_image(self,uname,target,url):
        import urllib.request,urllib.parse
        parsed=urllib.parse.urlparse(url)
        # The agent hosts signed artifacts on its private Docker network.
        if parsed.scheme not in ('http','https') or parsed.hostname not in ('dsh-onebot','127.0.0.1','localhost') or parsed.path!='/api/raw':
            raise ValueError('image URL must be an agent artifact URL')
        with urllib.request.urlopen(url,timeout=15) as response:
            data=response.read(20*1024*1024+1)
        if len(data)>20*1024*1024:raise ValueError('image exceeds 20MB')
        if data.startswith(b'\x89PNG\r\n\x1a\n'):mime='image/png'
        elif data.startswith(b'\xff\xd8\xff'):mime='image/jpeg'
        else:raise ValueError('only PNG/JPEG image sending is available; native GIF stickers and voice are not ready')
        self._target_window(uname,target)
        before=self._max_local_id(uname)
        env=dict(os.environ,DISPLAY=self.display)
        result=subprocess.run(['xclip','-selection','clipboard','-t',mime],input=data,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        if result.returncode:raise RuntimeError('image clipboard failed; nothing sent')
        self._xdo('key','ctrl+v',wait=1.2)
        self._xdo('key','Return',wait=0.5)
        return self._verify_outgoing(uname,before,3)

    async def inject(self, text, group_id=None, user_id=None):
        """调试用：伪造一条入站消息，直接触发 on_message（会走完整的 MaiBot 回复流程）。"""
        if group_id:
            uname = self._resolve(group_id)
            msg = {
                "chat_type": "group",
                "chat_id": uname,
                "user_id": self._uid(self.self_wxid) if not user_id else str(user_id),
                "nickname": "调试注入",
                "card": "",
                "group_name": self._display(uname),
                "segments": [{"type": "text", "data": {"text": text}}],
                "raw": text,
                "time": int(time.time()),
            }
        else:
            uname = self._resolve(user_id) if user_id else self.self_wxid
            msg = {
                "chat_type": "private",
                "chat_id": self._uid(uname),
                "user_id": self._uid(uname),
                "nickname": self._display(uname),
                "card": "",
                "group_name": "",
                "segments": [{"type": "text", "data": {"text": text}}],
                "raw": text,
                "time": int(time.time()),
            }
        log.info("注入调试消息 chat_id=%s user_id=%s: %s", msg["chat_id"], msg["user_id"], text)
        if self.on_message:
            await self.on_message(msg)
        return msg

    async def start(self, on_message):
        self.on_message = on_message
        self._load_keys()
        self._build_name_maps()
        self._prime()
        for u in list(self._names):
            self.idmap.to_int("chat", u)
            self.idmap.to_int("user", u)
        self.idmap._save()
        self._task = asyncio.get_event_loop().create_task(self._loop())
        log.info("微信 Linux 驱动已启动，轮询间隔 %.1fs", self.poll_sec)

    async def stop(self):
        if self._task:
            self._task.cancel()

    def login_info(self):
        """机器人的身份 —— 昵称里带上小号自己的微信号，MaiBot 界面就能认出来。"""
        uid = self._uid(self.self_wxid) if self.self_wxid else "10000"
        nick = self._display(self.self_wxid) if self.self_wxid else ""
        return {"user_id": uid, "nickname": nick or "微信机器人"}

    def groups(self):
        return [{"group_id": u,
                 "group_name": self._display(u),
                 "member_count": 0, "max_member_count": 500, "avatar": self._avatars.get(u, "")}
                for u in self._names if u.endswith("@chatroom")]

    def group_info(self, group_id):
        for g in self.groups():
            if g["group_id"] == group_id:
                return g
        return {}

    def members(self, group_id):
        return []

    def friends(self):
        return [{"user_id": self._uid(u), "legacy_user_id": self.idmap.to_int("user", u), "nickname": self._names.get(u, u), "avatar": self._avatars.get(u, "")}
                for u in self._names if not u.endswith("@chatroom")]
