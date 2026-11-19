from media_auth import verify as verify_media
import asyncio
import json
import os
import logging
import time

from aiohttp import WSMsgType, web

from msgs import normalize, segments_to_cq, to_text

log = logging.getLogger("onebot")

VERSION = "0.1.0"


class ActionFailed(Exception):
    def __init__(self, retcode, message):
        super().__init__(message)
        self.retcode = retcode


class OneBotServer:
    def __init__(self, cfg, idmap):
        s = cfg.get("server", {}) or {}
        self.host = s.get("host", "0.0.0.0")
        self.port = int(s.get("port", 3001))
        self.token = s.get("token", "") or ""
        self.allow_debug_inject=bool(s.get("allow_debug_inject",False))
        self.heartbeat_sec = float(s.get("heartbeat_sec", 5))
        b = cfg.get("bot", {}) or {}
        self.self_id = b.get("self_id", 10000)
        self.nickname = b.get("nickname", "微信麦麦")
        self.idmap = idmap
        self.driver = None
        self.clients = set()
        self._mid = 0
        self.started_at = time.time()

    def _now(self):
        return int(time.time())

    def _next_mid(self):
        self._mid += 1
        if self._mid > 2000000000:
            self._mid = 1
        return self._mid

    def _event(self, d):
        d.setdefault("time", self._now())
        d.setdefault("self_id", self.self_id)
        return d

    def lifecycle(self):
        return self._event({"post_type": "meta_event", "meta_event_type": "lifecycle",
                            "sub_type": "connect"})

    def heartbeat(self):
        return self._event({"post_type": "meta_event", "meta_event_type": "heartbeat",
                            "status": {"online": True, "good": True},
                            "interval": int(self.heartbeat_sec * 1000)})

    def to_onebot_message(self, m):
        segs = m.get("segments") or []
        raw = m.get("raw") or to_text(segs) or segments_to_cq(segs)
        ev = {
            "post_type": "message",
            "message_id": self._next_mid(),
            "user_id": m["user_id"],
            "message": segs,
            "raw_message": raw,
            "font": 0,
            "sender": {
                "user_id": m["user_id"],
                "nickname": m.get("nickname", ""),
                "card": m.get("card", ""),
                "role": m.get("role", "member"),
            },
            "time": int(m.get("time") or self._now()),
            "self_id": self.self_id,
        }
        if m["chat_type"] == "group":
            ev["message_type"] = "group"
            ev["sub_type"] = "normal"
            ev["group_id"] = m["chat_id"]
            ev["group_name"] = m.get("group_name") or ""
            ev["anonymous"] = None
        else:
            ev["message_type"] = "private"
            ev["sub_type"] = "friend"
        return ev

    async def emit(self, payload):
        data = json.dumps(payload, ensure_ascii=False)
        log.info("emit: 发送给 %d 个客户端, type=%s chat_id=%s",
                 len(self.clients), payload.get("message_type"), payload.get("group_id") or payload.get("user_id"))
        dead = []
        for ws in list(self.clients):
            if ws.closed:
                dead.append(ws)
                continue
            try:
                await ws.send_str(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def on_message(self, m):
        await self.emit(self.to_onebot_message(m))

    async def _hb_loop(self, ws):
        try:
            while not ws.closed:
                await asyncio.sleep(self.heartbeat_sec)
                if ws.closed:
                    break
                await ws.send_str(json.dumps(self.heartbeat(), ensure_ascii=False))
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    async def ws_handler(self, request):
        if self.token:
            auth = request.headers.get("Authorization", "")
            q = request.query.get("access_token") or request.query.get("token")
            if auth not in (f"Bearer {self.token}", self.token) and q != self.token:
                log.warning("reject unauthorized client %s", request.remote)
                return web.Response(status=401, text="unauthorized")
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=16 * 1024 * 1024)
        await ws.prepare(request)
        self.clients.add(ws)
        log.info("adapter connected from %s (clients=%d)", request.remote, len(self.clients))
        hb = asyncio.create_task(self._hb_loop(ws))
        try:
            await ws.send_str(json.dumps(self.lifecycle(), ensure_ascii=False))
            await ws.send_str(json.dumps(self.heartbeat(), ensure_ascii=False))
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    asyncio.create_task(self._handle_action(ws, msg.data))
                elif msg.type == WSMsgType.ERROR:
                    log.warning("ws error: %s", ws.exception())
                    break
        finally:
            hb.cancel()
            self.clients.discard(ws)
            log.info("adapter disconnected (clients=%d)", len(self.clients))
        return ws

    async def _handle_action(self, ws, raw):
        try:
            req = json.loads(raw)
        except Exception:
            log.warning("bad action payload: %s", raw[:200])
            return
        action = req.get("action")
        params = req.get("params") or {}
        echo = req.get("echo")
        log.info("action=%s params=%s", action, json.dumps(params, ensure_ascii=False)[:400])
        try:
            data = await self.dispatch(action, params)
            resp = {"status": "ok", "retcode": 0, "data": data, "echo": echo}
        except ActionFailed as e:
            resp = {"status": "failed", "retcode": e.retcode, "data": None,
                    "message": str(e), "echo": echo}
        except Exception as e:
            log.exception("action crashed: %s", action)
            resp = {"status": "failed", "retcode": 1201 if "unknown" in str(e) else 1200, "data": None,
                    "message": f"{type(e).__name__}: {e}", "echo": echo}
        try:
            await ws.send_str(json.dumps(resp, ensure_ascii=False))
        except Exception:
            pass

    async def dispatch(self, action, p):
        d = self.driver
        if action == "send_group_msg":
            mid = await d.send("group", p["group_id"], normalize(p.get("message", "")))
            if mid is None or mid is False:raise ActionFailed(1201,"send not confirmed; result unknown; do not retry automatically")
            return {"message_id": mid}
        if action == "send_private_msg":
            mid = await d.send("private", p["user_id"], normalize(p.get("message", "")))
            if mid is None or mid is False:raise ActionFailed(1201,"send not confirmed; result unknown; do not retry automatically")
            return {"message_id": mid}
        if action == "send_msg":
            mt = p.get("message_type") or ("group" if p.get("group_id") is not None else "private")
            if mt == "group":
                mid = await d.send("group", p["group_id"], normalize(p.get("message", "")))
            else:
                mid = await d.send("private", p["user_id"], normalize(p.get("message", "")))
            if mid is None or mid is False:raise ActionFailed(1201,"send not confirmed; result unknown; do not retry automatically")
            return {"message_id": mid}
        if action == "get_login_info":
            return d.login_info()
        if action == "get_status":
            return {"online": True, "good": True}
        if action == "get_version_info":
            return {"app_name": "wx-onebot", "app_version": VERSION, "protocol_version": "v11"}
        if action == "get_group_list":
            return d.groups()
        if action == "get_group_info":
            return d.group_info(p["group_id"])
        if action == "get_group_member_list":
            return d.members(p["group_id"])
        if action == "get_group_member_info":
            gid, uid = p["group_id"], p["user_id"]
            for m in d.members(gid):
                if m["user_id"] == uid:
                    return m
            raise ActionFailed(1404, "member not found")
        if action == "get_friend_list":
            return d.friends()
        if action == "get_capabilities":
            return getattr(d,"capabilities",{"text":True,"image":False,"emoji":False,"record":False})
        if action in ("can_send_image","can_send_record"):
            return {"yes":getattr(d,"capabilities",{}).get("image" if action=="can_send_image" else "record",False)}
        if action in ("delete_msg", "set_restart", "clean_cache", "get_cookies"):
            return None
        raise ActionFailed(1404, f"unsupported action: {action}")

    async def handle_inject(self, request):
        if not (self.token and request.headers.get("Authorization")=="Bearer "+self.token):return web.json_response({"ok":False},status=401)
        if not getattr(self,"allow_debug_inject",False):return web.json_response({"ok":False,"error":"debug injection disabled"},status=403)
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        text = (data.get("text") or "").strip()
        if not text:
            return web.json_response({"ok": False, "error": "empty text"}, status=400)
        if not hasattr(self.driver, "inject"):
            return web.json_response({"ok": False, "error": "current driver has no inject()"}, status=400)
        res = await self.driver.inject(text, group_id=data.get("group_id"), user_id=data.get("user_id"))
        return web.json_response(res)

    async def handle_state(self, request):
        if not (self.token and request.headers.get("Authorization")=="Bearer "+self.token):return web.json_response({"ok":False},status=401)
        return web.json_response({
            "driver": getattr(self.driver, "name", None),
            "self_id": self.self_id,
            "nickname": self.nickname,
            "clients": len(self.clients),
            "uptime_sec": int(time.time() - self.started_at),
            "groups": self.driver.groups() if self.driver else [],
            "sent_tail": getattr(self.driver, "sent", [])[-20:],
        }, dumps=lambda o: json.dumps(o, ensure_ascii=False))

    async def handle_media(self, request):
        """给 MaiBot 提供图片下载（它只接受 http url，不认 base64）。"""
        import re as _re
        from aiohttp import web as _web
        name = request.match_info.get("name", "")
        if not _re.fullmatch(r"[A-Za-z0-9_.\-]+", name or ""):
            return _web.Response(status=400, text="bad name")
        if not verify_media(name,request.query):return _web.Response(status=401,text="unauthorized media")
        path = os.path.join("/tmp/wxemoji", name)
        if not os.path.isfile(path):
            return _web.Response(status=404, text="not found")
        return _web.FileResponse(path)

    def build_app(self):
        app = web.Application()
        app.router.add_get("/", self.ws_handler)
        app.router.add_get("/media/{name}", self.handle_media)
        app.router.add_get("/onebot/v11/ws", self.ws_handler)
        app.router.add_post("/debug/inject", self.handle_inject)
        app.router.add_get("/debug/state", self.handle_state)
        app.router.add_get("/{tail:.*}", self.ws_handler)
        return app
