"""P0 自测用：模拟 MaiBot 的 NapCat 适配器连上来，验证整条链路。"""
import asyncio
import json
import sys

import aiohttp

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:3001/"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else "change-me"
REPLY = "--no-reply" not in sys.argv


async def call(ws, action, params=None, echo=None):
    await ws.send_str(json.dumps({"action": action, "params": params or {}, "echo": echo or action},
                                 ensure_ascii=False))
    resp = await ws.receive()
    return json.loads(resp.data)


async def main():
    headers = {"Authorization": f"Bearer {TOKEN}"}
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(URL, headers=headers, heartbeat=30) as ws:
            print("[mock-adapter] connected", flush=True)
            for a, p in [("get_version_info", {}), ("get_login_info", {}), ("get_status", {}),
                         ("get_group_list", {}), ("can_send_image", {})]:
                r = await call(ws, a, p)
                print(f"[mock-adapter] {a} -> {json.dumps(r, ensure_ascii=False)[:200]}", flush=True)
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                ev = json.loads(msg.data)
                pt = ev.get("post_type")
                if pt == "meta_event":
                    continue
                print(f"[mock-adapter] event: {json.dumps(ev, ensure_ascii=False)[:500]}", flush=True)
                if pt == "message" and REPLY:
                    text = ev.get("raw_message") or ""
                    if ev.get("message_type") == "group":
                        await call(ws, "send_group_msg",
                                   {"group_id": ev["group_id"],
                                    "message": [{"type": "text",
                                                 "data": {"text": f"收到群消息：{text}"}}]})
                    else:
                        await call(ws, "send_private_msg",
                                   {"user_id": ev["user_id"],
                                    "message": [{"type": "text",
                                                 "data": {"text": f"收到私聊：{text}"}}]})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
