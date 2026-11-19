# 在 Windows 运行鲸鱼窝

Windows 版在本机运行 QQ 聊天服务和 WebUI。准备 **Node.js 22.19 或以上版本**、npm，以及可访问的 NapCat。QQ 登录在 NapCat 完成。Windows 版也可以连接已有的 Linux 微信桥。

## 启动

1. 解压到当前用户有读写权限的文件夹，双击 `Start-WhaleNest.cmd`。首次启动需要联网安装 npm 依赖。
2. 打开浏览器访问 `http://127.0.0.1:3081/`。使用 `.env.windows` 中你设置的 `WEB_TOKEN`，或用下面的命令读取首次启动自动生成的令牌。
3. 在「设置 → 模型与服务」配置模型和 API Key。在白名单中加入获准聊天的账号或群。
4. 修改 `.env.windows` 中的 `ONEBOT_WS`、`ONEBOT_TOKEN` 和 `OWNER_USERS`，然后重启。默认地址是 `ws://127.0.0.1:3001`。

```powershell
Get-Content -LiteralPath .\workspace\.web-token
```

也可以在解压目录执行 `npm.cmd ci`、`npm.cmd start`。在启动窗口按 Ctrl+C 停止。程序从自己的目录加载配置，并在启动时补齐缺失的种子文件。再次启动沿用已有配置和记忆。

## 网络与媒体

默认监听 `127.0.0.1`。NapCat 与鲸鱼窝运行在同一台电脑时可直接使用默认设置。NapCat 在另一台设备时，用鲸鱼窝电脑的内网地址配置 `WEB_BIND` 和 `PUBLIC_BASE`，使 NapCat 能按短期媒体链接取图和音频。公网访问管理页使用 HTTPS。

文字聊天和 WebUI 依赖 Node.js。GIF 取帧等媒体处理需要 PATH 中的 FFmpeg，B 站工具需要 Python，可选自动化工具需要各自的运行环境。真实微信接入依赖已登录的 Linux 微信，本包可用 OneBot 连接它的微信桥。

## 数据位置

默认 `workspace/` 保存聊天、设置和媒体。`data/` 保存配置加密主密钥。`.env.windows` 保存部署参数。请将三者放在可信目录，备份时一起保留。管理页保存的 API Key 加密落盘，手工写进 `.env.windows` 的值保持原文。

WebUI 依当前浏览器会话保存管理令牌。Android 3.6.5 的自动登录需要本次更新的服务端。
