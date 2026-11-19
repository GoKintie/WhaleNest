"""wx-onebot 自测：假驱动 + 模拟 MaiBot 适配器，验证 OneBot v11 收发全链路。"""
import asyncio
import json
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from aiohttp import ClientSession, WSMsgType, web

from drivers.fake import FakeDriver
from idmap import IdMap
from onebot import OneBotServer

PORT = 3301
TOKEN = "testtoken"
CFG = {
    "server": {"host": "127.0.0.1", "port": PORT, "token": TOKEN, "heartbeat_sec": 2},
    "bot": {"self_id": 10000, "nickname": "微信麦麦"},
    "driver": {"type": "fake"},
    "idmap": {"path": ""},
    "groups": [{"id": 1001, "name": "测试群A"}],
    "users": [{"id": 2001, "name": "小明"}],
}

RESULTS = []


async def mock_adapter():
    headers = {"Authorization": "Bearer " + TOKEN}
    async with ClientSession() as s:
        async with s.ws_connect("ws://127.0.0.1:%d/" % PORT, headers=headers) as ws:
            for action in ("get_version_info", "get_login_info", "get_status", "get_group_list"):
                await ws.send_str(json.dumps({"action": action, "params": {}, "echo": action}))
                r = await ws.receive()
                RESULTS.append(("MOCK-RESP", action, json.loads(r.data)))
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                ev = json.loads(msg.data)
                RESULTS.append(("MOCK-EVENT", ev.get("post_type"), ev))
                if ev.get("post_type") == "message":
                    await ws.send_str(json.dumps({
                        "action": "send_group_msg",
                        "params": {"group_id": ev["group_id"],
                                   "message": [{"type": "text",
                                                "data": {"text": "收到：" + ev.get("raw_message", "")}}]},
                        "echo": "reply1"}, ensure_ascii=False))
                    r = await ws.receive()
                    RESULTS.append(("MOCK-RESP", "send_group_msg", json.loads(r.data)))
                    return


async def main():
    idmap = IdMap("")
    srv = OneBotServer(CFG, idmap)
    srv.driver = FakeDriver(CFG, idmap)
    runner = web.AppRunner(srv.build_app())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", PORT).start()
    await srv.driver.start(srv.on_message)
    print("[1] 服务已启动 127.0.0.1:%d  self_id=%d" % (PORT, srv.self_id))

    task = asyncio.create_task(mock_adapter())
    await asyncio.sleep(1.0)
    print("[2] 模拟适配器已连接，clients=%d" % len(srv.clients))

    print("[3] 注入一条微信消息: 群1001 / 小明 -> '你好，这是一条测试消息'")
    await srv.driver.inject("你好，这是一条测试消息", group_id=1001, user_id=2001)

    await asyncio.wait_for(task, timeout=10)
    await asyncio.sleep(0.4)

    print("\n================ 全链路结果 ================")
    for kind, name, payload in RESULTS:
        if kind == "MOCK-RESP":
            print("  [适配器收到动作响应] %-18s -> %s" % (name, json.dumps(payload, ensure_ascii=False)[:160]))
        else:
            p = payload
            if p.get("post_type") == "message":
                print("  [适配器收到消息事件] type=%s group=%s user=%s raw=%r msg_id=%s" % (
                    p.get("message_type"), p.get("group_id"), p.get("user_id"),
                    p.get("raw_message"), p.get("message_id")))
            else:
                print("  [适配器收到] %s / %s" % (p.get("post_type"), p.get("meta_event_type")))
    print("\n  [假驱动实际'发出'的消息]")
    for s in srv.driver.sent:
        print("     -> %s:%s  %s" % (s["chat_type"], s["name"], json.dumps(s["segments"], ensure_ascii=False)))

    await runner.cleanup()
    print("\n自测结束 ✅")


asyncio.run(main())
