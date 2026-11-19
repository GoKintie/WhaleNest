# 第三方来源与许可

## 随包分发的上游文件

- `wechat-bridge/voice/voice_audio.py` 与 `wechat-bridge/voice/assets/voice_*.png` 源于 ChisBread/wechat-ai，沿用 GPL-3.0-or-later。许可证全文位于该模块。 [上游说明](wechat-bridge/voice/UPSTREAM.md) · [GPL 全文](wechat-bridge/voice/LICENSE) · [上游许可声明](https://github.com/ChisBread/wechat-ai/blob/master/pyproject.toml)
- 大肥鱼社区的角色和表达曾用于方案参考。公开版预设采用独立措辞，保留对相关社区项目的致谢。 [大肥鱼 AstrBot 项目](https://github.com/whyever77/dafeiyu-astrbot) · [历史参考项目许可](docs/licenses/dafeiyu-astrbot-MIT.txt)

## 设计参考

- MaiBot 的关系提取、记忆召回与表达配置。 [MaiBot](https://github.com/Mai-with-u/MaiBot)
- 真寻的插件目录和插件管理流程。 [真寻机器人](https://github.com/zhenxun-org/zhenxun_bot)
- 社区语音和梗词检索工具的接入方式。 [Esmerubphire/astrbot_plugin_feiyu_voice](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice) · [in1t1a1/astrbot_plugin_memewiki](https://github.com/in1t1a1/astrbot_plugin_memewiki)

## 运行依赖

Node.js 依赖按 `package-lock.json` 安装。Python 依赖列于各镜像的 requirements 文件，遵循各自的许可。NapCat、微信客户端和外部模型服务由部署者单独配置。
