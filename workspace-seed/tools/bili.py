#!/usr/bin/env python3
# bili.py —— B 站工具（给肥鱼用 · v2.6 升级版：新增 browse 深度刷视频 + 热评抓取）
#
# 用法：
#   bili.py login [--wait 180]        扫码登录（二维码存 /workspace/out/bili-qr.png）
#   bili.py status                    看登录状态
#   bili.py uid <昵称>                按昵称查 UID
#   bili.py search <关键词> [--days 7] [--min-play 10000] [--limit 10] [--order play]
#   bili.py sub <BV号>                取 AI 字幕全文
#   bili.py dm <UID> --text "..."     发私信（≤500 字，会自动截断）
#   bili.py feed <关键词> [--limit 6] 搜索 + 取字幕，输出给模型判断用的精简 JSON
#   bili.py browse [关键词] [--limit 3] 像真人一样刷视频：随机或按话题挑视频，把完整简介、AI字幕精华、高赞神评一并抓回来供她唠嗑吐槽
#
# 只做搜、深度看字幕与热评、发私信。**不发评论、不发动态、不上传**。

import asyncio, json, os, sys, time, random, urllib.parse, urllib.request, argparse, re, subprocess

WORKSPACE = os.environ.get("WORKDIR", "/workspace")
CRED_FILE = os.path.join(WORKSPACE, "bili_credential.json")
OUT_DIR = os.path.join(WORKSPACE, "out")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

from bilibili_api import Credential, search, video, user
from bilibili_api.login_v2 import QrCodeLogin


def load_cred():
    if not os.path.exists(CRED_FILE):
        return None
    d = json.load(open(CRED_FILE, encoding="utf-8"))
    return Credential(
        sessdata=d.get("sessdata", ""),
        bili_jct=d.get("bili_jct", ""),
        buvid3=d.get("buvid3", ""),
        dedeuserid=d.get("dedeuserid", ""),
        ac_time_value=d.get("ac_time_value", ""),
    )


def save_cred(c: Credential):
    os.makedirs(os.path.dirname(CRED_FILE), exist_ok=True)
    data = {
        "sessdata": c.sessdata or "",
        "bili_jct": c.bili_jct or "",
        "buvid3": c.buvid3 or "",
        "dedeuserid": c.dedeuserid or "",
        "ac_time_value": c.ac_time_value or "",
    }
    with open(CRED_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(CRED_FILE, 0o600)
    return data


# ---------------- login（手写官方接口 + cookie jar） ----------------
import http.cookiejar


def _opener(initial=None):
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    op.addheaders = [("User-Agent", UA), ("Referer", "https://www.bilibili.com/"),
                     ("Accept", "application/json, text/plain, */*")]
    if initial:
        jar.set_cookie(http.cookiejar.Cookie(
            0, "buvid3", initial, None, False, ".bilibili.com", True, False,
            "/", True, False, None, True, None, None, {}))
    return op, jar


def get_buvid3():
    try:
        op, _ = _opener()
        body = op.open("https://api.bilibili.com/x/frontend/finger/spi", timeout=12).read().decode("utf-8", "ignore")
        return (json.loads(body).get("data") or {}).get("b_3", "")
    except Exception:
        return ""


def _cookies_from_jar(jar):
    out = {}
    for c in jar:
        if c.name in ("SESSDATA", "bili_jct", "DedeUserID", "buvid3", "ac_time_value"):
            out[c.name] = c.value
    return out


async def cmd_login(wait_sec: int):
    os.makedirs(OUT_DIR, exist_ok=True)
    b3 = get_buvid3()
    op, jar = _opener(b3)
    try:
        body = op.open("https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header",
                       timeout=12).read().decode("utf-8", "ignore")
        d = json.loads(body).get("data") or {}
        qr_url, key = d.get("url"), d.get("qrcode_key")
        if not qr_url:
            print(json.dumps({"ok": False, "error": "取二维码失败", "raw": body[:200]}, ensure_ascii=False)); return
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"取二维码异常：{type(e).__name__} {e}"}, ensure_ascii=False)); return

    import qrcode
    png = os.path.join(OUT_DIR, "bili-qr.png")
    qrcode.make(qr_url).save(png)
    print(json.dumps({"ok": True, "qr": png, "wait": wait_sec,
                      "hint": "手机 B 站扫码，确认时选「记住我/长期」"}, ensure_ascii=False), flush=True)
    if wait_sec <= 0:
        return

    deadline, last = time.time() + wait_sec, None
    poll_url = f"https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={key}&source=main-fe-header"
    while time.time() < deadline:
        try:
            body = op.open(poll_url, timeout=12).read().decode("utf-8", "ignore")
            data = (json.loads(body) or {}).get("data") or {}
            code = data.get("code")
        except Exception:
            await asyncio.sleep(3); continue
        if code != last:
            label = {86101: "wait", 86090: "scan", 86038: "expired", 0: "done"}.get(code, str(code))
            print(json.dumps({"state": label}, ensure_ascii=False), flush=True)
            last = code
        if code == 0:
            ck = _cookies_from_jar(jar)
            if not ck.get("SESSDATA"):
                print(json.dumps({"ok": False, "error": "登录成功但没拿到 SESSDATA"}, ensure_ascii=False)); return
            data_h = {"sessdata": ck.get("SESSDATA", ""), "bili_jct": ck.get("bili_jct", ""),
                      "dedeuserid": ck.get("DedeUserID", ""), "buvid3": ck.get("buvid3", b3),
                      "ac_time_value": ck.get("ac_time_value", "")}
            with open(CRED_FILE, "w", encoding="utf-8") as f:
                json.dump(data_h, f, ensure_ascii=False, indent=2)
            os.chmod(CRED_FILE, 0o600)
            name = await whoami(load_cred())
            print(json.dumps({"ok": True, "logged_in": True, "uid": data_h["dedeuserid"], "name": name}, ensure_ascii=False))
            return
        if code == 86038:
            print(json.dumps({"ok": False, "error": "二维码已过期"}, ensure_ascii=False)); return
        await asyncio.sleep(3)
    print(json.dumps({"ok": False, "error": "超时未确认"}, ensure_ascii=False))


async def whoami(cred):
    try:
        u = user.User(int(cred.dedeuserid), credential=cred)
        info = await u.get_user_info()
        return info.get("name") or info.get("uname") or ""
    except Exception as e:
        return f"(取昵称失败: {e})"


async def cmd_status():
    c = load_cred()
    if not c:
        print(json.dumps({"ok": False, "logged_in": False, "error": "还没登录，先跑 login"}, ensure_ascii=False))
        return
    try:
        ok = await c.check_valid()
    except Exception:
        ok = False
    name = await whoami(c) if ok else ""
    print(json.dumps({"ok": bool(ok), "logged_in": bool(ok), "uid": c.dedeuserid, "name": name}, ensure_ascii=False))


# ---------------- search ----------------
def strip_em(s):
    return re.sub(r"</?em[^>]*>", "", s or "")


def fmt_dur(sec):
    try:
        sec = int(sec)
        return f"{sec // 60}:{sec % 60:02d}"
    except Exception:
        return ""


async def do_search(kw, days=7, min_play=0, limit=10, order="play"):
    order_map = {"play": search.OrderVideo.TOTALRANK, "new": search.OrderVideo.PUBDATE, "dm": search.OrderVideo.DM}
    res = await search.search_by_type(
        kw, search_type=search.SearchObjectType.VIDEO,
        order_type=order_map.get(order, search.OrderVideo.TOTALRANK), page=1,
    )
    items = res.get("result") or []
    now = int(time.time())
    out = []
    for it in items:
        if not it.get("bvid"):
            continue
        play = int(it.get("play") or 0)
        pub = int(it.get("pubdate") or 0)
        if days and pub and (now - pub) > days * 86400:
            continue
        if min_play and play < min_play:
            continue
        out.append({
            "bvid": it.get("bvid"),
            "aid": it.get("aid") or it.get("id"),
            "title": strip_em(it.get("title")),
            "up": it.get("author"),
            "play": play,
            "danmaku": int(it.get("danmaku") or it.get("video_review") or 0),
            "duration": it.get("duration"),
            "days_ago": round((now - pub) / 86400, 1) if pub else None,
            "desc": strip_em(it.get("description") or "")[:140],
        })
        if len(out) >= limit:
            break
    return out


async def cmd_search(args):
    items = await do_search(args.kw, args.days, args.min_play, args.limit, args.order)
    print(json.dumps({"ok": True, "count": len(items), "items": items}, ensure_ascii=False, indent=1))


# ---------------- subtitle & hot comments ----------------
def fetch_json(url):
    if url.startswith("//"):
        url = "https:" + url
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.bilibili.com"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_top_comments(aid, limit=6):
    """抓视频下方高赞神评（帮助肥鱼了解大家都在槽什么、笑什么）"""
    if not aid:
        return []
    try:
        url = f"https://api.bilibili.com/x/v2/reply?type=1&oid={aid}&sort=2&ps={limit}"
        d = fetch_json(url)
        replies = ((d.get("data") or {}).get("replies")) or []
        out = []
        for r in replies[:limit]:
            msg = ((r.get("content") or {}).get("message") or "").strip().replace("\n", " ")
            uname = ((r.get("member") or {}).get("uname") or "网友")
            like = int(r.get("like") or 0)
            if msg:
                out.append({"user": uname, "like": like, "text": msg[:110]})
        return out
    except Exception:
        return []


async def get_subtitle_text(bvid, max_chars=1800):
    v = video.Video(bvid=bvid, credential=load_cred())
    info = await v.get_info()
    cid = info.get("cid")
    sub = await v.get_subtitle(cid)
    subs = (sub or {}).get("subtitles") or []
    if not subs:
        return "", info
    subs.sort(key=lambda s: 0 if str(s.get("lan", "")).startswith("zh") else 1)
    url = subs[0].get("subtitle_url") or ""
    if not url:
        return "", info
    data = fetch_json(url)
    text = " ".join(x.get("content", "") for x in (data.get("body") or []))
    return text[:max_chars], info


async def cmd_sub(args):
    text, info = await get_subtitle_text(args.bvid, args.max)
    print(json.dumps({
        "ok": bool(text), "bvid": args.bvid,
        "title": info.get("title"), "up": (info.get("owner") or {}).get("name"),
        "play": (info.get("stat") or {}).get("view"),
        "has_subtitle": bool(text), "chars": len(text),
        "subtitle": text or "(这个视频没有 AI 字幕)",
    }, ensure_ascii=False, indent=1))


# ---------------- DM ----------------
def send_dm_raw(cred, uid, text):
    if len(text) > 480:
        text = text[:477] + "…"
    payload = {
        "msg[sender_uid]": cred.dedeuserid,
        "msg[receiver_id]": str(uid),
        "msg[receiver_type]": "1",
        "msg[msg_type]": "1",
        "msg[msg_status]": "0",
        "msg[content]": json.dumps({"content": text}, ensure_ascii=False),
        "msg[timestamp]": str(int(time.time())),
        "msg[dev_id]": "0",
        "csrf": cred.bili_jct,
    }
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(
        "https://api.vc.bilibili.com/web_im/v1/web_im/send_msg",
        data=body,
        headers={
            "User-Agent": UA,
            "Referer": "https://www.bilibili.com/",
            "Content-Type": "application/x-www-form-urlencoded",
            "Cookie": f"SESSDATA={cred.sessdata}; bili_jct={cred.bili_jct}; DedeUserID={cred.dedeuserid}; buvid3={cred.buvid3}",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


async def cmd_dm(args):
    c = load_cred()
    if not c:
        print(json.dumps({"ok": False, "error": "未登录"}, ensure_ascii=False)); return
    uid = args.uid
    if not str(uid).isdigit():
        uid = await resolve_uid(str(uid))
        if not uid:
            print(json.dumps({"ok": False, "error": f"找不到用户 {args.uid}"}, ensure_ascii=False)); return
    try:
        r = send_dm_raw(c, uid, args.text)
        code = r.get("code")
        ok = code == 0
        print(json.dumps({"ok": ok, "code": code, "msg": r.get("message") or r.get("msg"),
                          "uid": uid, "chars": len(args.text)}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))


async def resolve_uid(name):
    try:
        res = await search.search_by_type(name, search_type=search.SearchObjectType.USER, page=1)
        for it in (res.get("result") or [])[:5]:
            uname = strip_em(it.get("uname") or "")
            if uname == name:
                return int(it.get("mid"))
        first = (res.get("result") or [None])[0]
        return int(first.get("mid")) if first else None
    except Exception:
        return None


async def extract_bvid(s):
    """从任意文本里抽出 BV 号；b23.tv 短链会跟一次跳转。"""
    m = re.search(r"(BV[0-9A-Za-z]{10})", s or "")
    if m:
        return m.group(1)
    m = re.search(r"https?://[^\s]+", s or "")
    if not m:
        return None
    url = m.group(0).rstrip("，。；、)）\"'")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/"})
        with urllib.request.urlopen(req, timeout=12) as r:
            final = r.geturl()
            body = r.read(20000).decode("utf-8", "ignore")
        for cand in (final, body):
            mm = re.search(r"(BV[0-9A-Za-z]{10})", cand)
            if mm:
                return mm.group(1)
    except Exception:
        return None
    return None


async def cmd_info(args):
    bvid = await extract_bvid(args.target)
    if not bvid:
        print(json.dumps({"ok": False, "error": f"没从「{args.target}」里认出 BV 号"}, ensure_ascii=False)); return
    try:
        v = video.Video(bvid=bvid, credential=load_cred())
        info = await v.get_info()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"取视频信息失败：{type(e).__name__} {e}"}, ensure_ascii=False)); return
    text = ""
    try:
        text, _ = await get_subtitle_text(bvid, args.max)
    except Exception:
        pass
    stat = info.get("stat") or {}
    aid = info.get("aid")
    hot_comments = fetch_top_comments(aid, limit=5) if aid else []
    print(json.dumps({
        "ok": True, "bvid": bvid,
        "url": f"https://www.bilibili.com/video/{bvid}",
        "title": info.get("title"),
        "up": (info.get("owner") or {}).get("name"),
        "duration": info.get("duration"),
        "play": stat.get("view"), "like": stat.get("like"),
        "danmaku": stat.get("danmaku"), "reply": stat.get("reply"),
        "pubdate": info.get("pubdate"),
        "desc": (info.get("desc") or "")[:300],
        "tags": [t.get("tag_name") for t in (info.get("tags") or [])][:8] if isinstance(info.get("tags"), list) else [],
        "has_subtitle": bool(text),
        "subtitle": text or "(这个视频没有 AI 字幕)",
        "hot_comments": hot_comments,
    }, ensure_ascii=False, indent=1))


async def cmd_uid(args):
    res = await search.search_by_type(args.name, search_type=search.SearchObjectType.USER, page=1)
    out = [{"uid": it.get("mid"), "name": strip_em(it.get("uname") or ""),
            "fans": it.get("fans"), "sign": strip_em(it.get("usign") or "")[:40]}
           for it in (res.get("result") or [])[:8]]
    print(json.dumps({"ok": True, "items": out}, ensure_ascii=False, indent=1))


# ---------------- frames：不用全量下载，按时间点直接抓帧 ----------------
async def get_play_url(v, cid, qn=16):
    try:
        d = await v.get_download_url(cid=cid)
    except Exception:
        return None
    if isinstance(d, dict):
        if d.get("durl"):
            return d["durl"][0].get("url")
        dash = d.get("dash") or {}
        vids = dash.get("video") or []
        if vids:
            vids.sort(key=lambda x: x.get("bandwidth") or 0)
            return vids[0].get("baseUrl") or vids[0].get("base_url")
    return None


def ffmpeg_frame(url, sec, out_path):
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
    cmd = [
        "ffmpeg", "-v", "error", "-y",
        "-headers", f"Referer: https://www.bilibili.com/\r\nUser-Agent: {ua}\r\n",
        "-ss", f"{max(0, sec):.2f}", "-i", url,
        "-frames:v", "1", "-q:v", "4", out_path,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=40)
        return r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 2000
    except Exception:
        return False


async def cmd_frames(args):
    cred = load_cred()
    v = video.Video(bvid=args.bvid, credential=cred)
    try:
        info = await v.get_info()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"取视频信息失败：{e}"}, ensure_ascii=False)); return
    pages = info.get("pages") or [{"cid": info.get("cid"), "duration": info.get("duration") or 0}]
    total = sum(int(p.get("duration") or 0) for p in pages) or 0
    if total <= 0:
        print(json.dumps({"ok": False, "error": "拿不到视频时长"}, ensure_ascii=False)); return

    n = max(2, min(16, args.n))
    points = [total * (i + 0.5) / n for i in range(n)]

    url_cache = {}
    outdir = os.path.join(OUT_DIR, f"frames-{args.bvid}")
    os.makedirs(outdir, exist_ok=True)
    shots = []
    for i, t in enumerate(points):
        acc, page = 0, pages[-1]
        for pg in pages:
            d = int(pg.get("duration") or 0)
            if t <= acc + d:
                page = pg
                break
            acc += d
        sec_in_page = max(0, t - acc)
        cid = page.get("cid")
        if cid not in url_cache:
            url_cache[cid] = await get_play_url(v, cid, args.qn)
        url = url_cache[cid]
        if not url:
            continue
        out = os.path.join(outdir, f"f{i + 1:02d}.jpg")
        if ffmpeg_frame(url, sec_in_page, out):
            shots.append({"at": round(t, 1), "mmss": f"{int(t) // 60}:{int(t) % 60:02d}", "path": out})

    if not shots:
        print(json.dumps({"ok": False, "error": "抓帧全失败（可能要会员/清晰度受限）"}, ensure_ascii=False)); return

    sheet = os.path.join(outdir, "sheet.jpg")
    try:
        from PIL import Image, ImageDraw
        cols = 4
        tw = 480
        imgs = []
        for s in shots:
            im = Image.open(s["path"]).convert("RGB")
            h = int(im.height * tw / im.width)
            im = im.resize((tw, h))
            dr = ImageDraw.Draw(im)
            dr.rectangle([0, 0, 74, 24], fill=(0, 0, 0))
            dr.text((6, 5), s["mmss"], fill=(255, 255, 255))
            imgs.append(im)
        rows = (len(imgs) + cols - 1) // cols
        ch = max(i.height for i in imgs)
        canvas = Image.new("RGB", (cols * tw, rows * ch), (12, 12, 12))
        for idx, im in enumerate(imgs):
            canvas.paste(im, ((idx % cols) * tw, (idx // cols) * ch))
        canvas.save(sheet, quality=82)
    except Exception:
        sheet = ""

    print(json.dumps({
        "ok": True, "bvid": args.bvid, "title": info.get("title"),
        "duration_s": total, "pages": len(pages),
        "count": len(shots), "sheet": sheet if os.path.exists(sheet) else "",
        "frames": shots,
    }, ensure_ascii=False, indent=1))


async def cmd_feed(args):
    items = await do_search(args.kw, args.days, args.min_play, args.limit, args.order)
    out = []
    for it in items:
        text = ""
        info = {}
        try:
            text, info = await get_subtitle_text(it["bvid"], 900)
        except Exception:
            pass
        aid = it.get("aid") or info.get("aid")
        it["url"] = f"https://www.bilibili.com/video/{it['bvid']}"
        it["has_subtitle"] = bool(text)
        it["subtitle_head"] = text[:900]
        it["hot_comments"] = fetch_top_comments(aid, limit=4) if aid else []
        out.append(it)
    print(json.dumps({"ok": True, "count": len(out), "items": out}, ensure_ascii=False, indent=1))


DEFAULT_BROWSE_TOPICS = [
    "野生技术协会 整活",
    "手工 离谱 发明",
    "NAS 软路由 折腾",
    "装机 翻车 搞笑",
    "AI 整活 逆天",
    "动物 迷惑行为",
    "数码 垃圾佬 捡垃圾",
    "游戏 离谱 bug",
]


async def cmd_browse(args):
    """
    像真人一样深度刷视频（v2.6 新增）：
    1. 若未指定关键词，自动从肥鱼平时爱看的整活/数码/野生技术/沙雕池里随机挑一个话题（或抓B站热门排行榜）
    2. 深入看前 limit 个视频的【完整简介 + AI字幕全文精华(1200字) + 前排高赞神评(6条)】
    3. 输出给模型，让模型真正聊视频里的具体梗点和神评，而不是敷衍转发两条链接
    """
    kw = (args.kw or "").strip()
    if not kw:
        kw = random.choice(DEFAULT_BROWSE_TOPICS)
    safe_limit = min(max(1, int(args.limit or 3)), 5)
    items = await do_search(kw, args.days, args.min_play, max(safe_limit * 2, 6), args.order)
    watched = []
    for it in items:
        text = ""
        info = {}
        try:
            text, info = await get_subtitle_text(it["bvid"], 800)
        except Exception:
            pass
        aid = it.get("aid") or info.get("aid")
        comments = fetch_top_comments(aid, limit=6) if aid else []
        desc = (info.get("desc") or it.get("desc") or "")[:260]
        watched.append({
            "bvid": it["bvid"],
            "url": f"https://www.bilibili.com/video/{it['bvid']}",
            "title": it.get("title"),
            "up": it.get("up"),
            "play": it.get("play"),
            "danmaku": it.get("danmaku"),
            "duration": it.get("duration"),
            "desc": desc,
            "has_subtitle": bool(text),
            "subtitle_digest": text[:800] if text else "(该视频无AI字幕，请结合简介与热评聊)",
            "hot_comments": comments,
        })
        if len(watched) >= safe_limit:
            break

    # 优先把有字幕或热评多的排在最前面
    watched.sort(key=lambda x: (1 if x["has_subtitle"] else 0, len(x["hot_comments"]), x["play"] or 0), reverse=True)
    print(json.dumps({
        "ok": True,
        "topic": kw,
        "count": len(watched),
        "guide": "请挑其中最有趣、槽点最足的 1 个视频，结合它的 subtitle_digest（字幕细节）和 hot_comments（网友神评），用肥鱼自己的话跟对方唠嗑吐槽视频里具体发生了什么好玩的事！绝不要只干巴巴甩两个链接交差！",
        "videos": watched,
    }, ensure_ascii=False, indent=1))


def main():
    p = argparse.ArgumentParser(prog="bili.py")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("login"); a.add_argument("--wait", type=int, default=0)
    sub.add_parser("status")

    a = sub.add_parser("search"); a.add_argument("kw")
    a.add_argument("--days", type=int, default=7); a.add_argument("--min-play", type=int, default=0)
    a.add_argument("--limit", type=int, default=10); a.add_argument("--order", default="play")

    a = sub.add_parser("sub"); a.add_argument("bvid"); a.add_argument("--max", type=int, default=1800)

    a = sub.add_parser("dm"); a.add_argument("uid"); a.add_argument("--text", required=True)

    a = sub.add_parser("uid"); a.add_argument("name")

    a = sub.add_parser("info"); a.add_argument("target"); a.add_argument("--max", type=int, default=1200)

    a = sub.add_parser("frames"); a.add_argument("bvid")
    a.add_argument("--n", type=int, default=8); a.add_argument("--qn", type=int, default=16)

    a = sub.add_parser("feed"); a.add_argument("kw")
    a.add_argument("--days", type=int, default=7); a.add_argument("--min-play", type=int, default=0)
    a.add_argument("--limit", type=int, default=6); a.add_argument("--order", default="play")

    a = sub.add_parser("browse"); a.add_argument("kw", nargs="?", default="")
    a.add_argument("--days", type=int, default=14); a.add_argument("--min-play", type=int, default=5000)
    a.add_argument("--limit", type=int, default=3); a.add_argument("--order", default="play")

    args = p.parse_args()
    fn = {
        "login": lambda: cmd_login(args.wait),
        "status": cmd_status,
        "search": lambda: cmd_search(args),
        "sub": lambda: cmd_sub(args),
        "dm": lambda: cmd_dm(args),
        "uid": lambda: cmd_uid(args),
        "info": lambda: cmd_info(args),
        "frames": lambda: cmd_frames(args),
        "feed": lambda: cmd_feed(args),
        "browse": lambda: cmd_browse(args),
    }[args.cmd]
    asyncio.run(fn())


if __name__ == "__main__":
    main()
