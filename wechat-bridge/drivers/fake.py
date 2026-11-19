import asyncio
import time

from drivers.base import Driver


class FakeDriver(Driver):
    """P0 驱动：不接触任何微信，用于验证 OneBot 协议端与 MaiBot 的整条链路。"""

    name = "fake"

    def __init__(self, cfg, idmap):
        self.cfg = cfg
        self.idmap = idmap
        self.groups_cfg = cfg.get("groups", []) or []
        self.users_cfg = cfg.get("users", []) or []
        self.on_message = None
        self._mid = 900000
        self.sent = []
        self._gid = {g["id"]: g for g in self.groups_cfg}
        self._uid = {u["id"]: u for u in self.users_cfg}

    async def start(self, on_message):
        self.on_message = on_message

    def _next_mid(self):
        self._mid += 1
        return self._mid

    async def send(self, chat_type: str, chat_id: int, segments: list):
        from msgs import to_text
        mid = self._next_mid()
        name = self._gid.get(chat_id, {}).get("name") or self._uid.get(chat_id, {}).get("name") or chat_id
        text = to_text(segments)
        self.sent.append({"chat_type": chat_type, "chat_id": chat_id, "name": name,
                          "segments": segments, "message_id": mid, "time": int(time.time())})
        print("[SEND -> %s:%s] %s" % (chat_type, name, text), flush=True)
        return mid

    def login_info(self):
        bot = self.cfg.get("bot", {})
        return {"user_id": int(bot.get("self_id", 10000)), "nickname": bot.get("nickname", "微信麦麦")}

    def groups(self):
        return [{"group_id": g["id"], "group_name": g["name"],
                 "member_count": len(self.users_cfg), "max_member_count": 500}
                for g in self.groups_cfg]

    def group_info(self, group_id):
        for g in self.groups():
            if g["group_id"] == group_id:
                return g
        return {}

    def members(self, group_id):
        return [{"group_id": group_id, "user_id": u["id"], "nickname": u["name"],
                 "card": "", "role": "owner" if i == 0 else "member"}
                for i, u in enumerate(self.users_cfg)]

    def friends(self):
        return [{"user_id": u["id"], "nickname": u["name"]} for u in self.users_cfg]

    async def inject(self, text, group_id=None, user_id=None):
        segs = [{"type": "text", "data": {"text": text}}]
        if group_id is not None:
            g = self._gid.get(int(group_id))
            u = self._uid.get(int(user_id)) if user_id else None
            if not g:
                return {"ok": False, "error": "unknown group_id %s" % group_id}
            if not u:
                u = self.users_cfg[0] if self.users_cfg else {"id": 2001, "name": "测试用户"}
            msg = {"chat_type": "group", "chat_id": g["id"], "user_id": u["id"],
                   "nickname": u["name"], "card": "", "segments": segs,
                   "raw": text, "time": int(time.time())}
        else:
            if not user_id:
                return {"ok": False, "error": "need group_id or user_id"}
            u = self._uid.get(int(user_id)) or {"id": int(user_id), "name": str(user_id)}
            msg = {"chat_type": "private", "chat_id": u["id"], "user_id": u["id"],
                   "nickname": u["name"], "card": "", "segments": segs,
                   "raw": text, "time": int(time.time())}
        await self.on_message(msg)
        return {"ok": True, "injected": msg}
