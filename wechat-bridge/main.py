import asyncio
import logging
import sys
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
from pathlib import Path

from aiohttp import web

from idmap import IdMap
from onebot import OneBotServer


def load_cfg(path: Path) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def build_driver(cfg, idmap):
    kind = (cfg.get("driver", {}) or {}).get("type", "fake")
    if kind == "fake":
        from drivers.fake import FakeDriver
        return FakeDriver(cfg, idmap)
    if kind == "wechat":
        from drivers.wechat_linux import WeChatLinuxDriver
        return WeChatLinuxDriver(cfg, idmap)
    raise SystemExit(f"unknown driver type: {kind}")


async def amain():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    cfg_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("config.toml")
    if not cfg_path.exists():
        print(f"config not found: {cfg_path}")
        print("copy config.example.toml to config.toml and edit it")
        return 1
    cfg = load_cfg(cfg_path)
    token = str((cfg.get("server") or {}).get("token", "")).strip()
    if not token or token == "change-me-please":
        print("Set a unique server.token in config.toml before starting the bridge.")
        return 1
    idmap = IdMap((cfg.get("idmap", {}) or {}).get("path", "idmap.json"))
    srv = OneBotServer(cfg, idmap)
    srv.driver = build_driver(cfg, idmap)

    app = srv.build_app()
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, srv.host, srv.port).start()
    log = logging.getLogger("main")
    log.info("wx-onebot %s listening on %s:%d (token=%s)",
             "0.1.0", srv.host, srv.port, "set" if srv.token else "none")
    log.info("driver=%s self_id=%s groups=%s",
             getattr(srv.driver, "name", "?"), srv.self_id,
             [g["group_id"] for g in srv.driver.groups()])
    log.info("debug: POST http://127.0.0.1:%d/debug/inject  {\"group_id\":..,\"text\":..}", srv.port)

    await srv.driver.start(srv.on_message)
    # 用驱动上报的真实身份（微信号）覆盖配置里的占位 self_id
    try:
        _info = srv.driver.login_info() or {}
        if _info.get("user_id"):
            srv.self_id = _info["user_id"]
            log.info("self_id 已设为 %s (%s)", srv.self_id, _info.get("nickname", ""))
    except Exception as _e:
        log.warning("获取 login_info 失败: %s", _e)
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass
    finally:
        await srv.driver.stop()
        await runner.cleanup()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(amain()))
    except KeyboardInterrupt:
        print("\nbye")
