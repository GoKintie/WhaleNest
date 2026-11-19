# 微信桥

`drivers/wechat_linux.py` 复用已登录的 Linux 微信，读取已授权本地数据库，通过唯一目标窗口、剪贴板和数据库回执确认发送。不会安装新 Hook 协议、创建登录会话或重试不明结果。

可以接收文字、可解密图片和带下载地址的表情，可以发送文字和 PNG/JPEG 图片。语音发送需要兼容的图形录音与 PulseAudio 环境，通过桥的 `record` 能力报告就绪状态。原生 GIF 表情和文件发送未提供。GIF 识图由主项目 FFmpeg 取首帧。

现有 NAS 容器需已有 aiohttp、tomli（Python<3.11）、sqlcipher3、cryptography、zstandard、xclip、xdotool，以及用户本机配置的 db_dir / keys_file / self_wxid；这些私有文件不在发布包。`Dockerfile` 和 fake 示例只用于协议测试，不能单独提供一个登录微信客户端。

`config.docker.example.toml` 为 fake 模式。复制为 `config.toml` 后，先设置一个独立的高强度 `server.token`，再启动 Compose。真实配置仅作为只读文件挂载。启动器会拒绝空令牌及示例占位值。

模拟桥默认在宿主机的 `127.0.0.1:3301` 可达。主项目使用同一 Docker 网络时，可以配置 `ws://wechat-linux:3001`。在启动两个 Compose 项目前，确认 `NAPCAT_NETWORK` 指向同一个已存在的网络。现有 Linux 微信环境可以独立更新 Python 桥，将运行配置和密钥文件保存在持久化目录，仅授权运行用户访问。

在本目录安装依赖并运行合成测试。

```sh
python -m pip install -r requirements.txt
python -m unittest discover -p 'test_v36*.py'
python selftest.py
```

[微信语音上游和许可](voice/UPSTREAM.md)
