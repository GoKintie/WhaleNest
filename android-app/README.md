# 鲸鱼窝 Android 管理壳

管理壳连接自行部署的鲸鱼窝和 NapCat。首次使用时在设置中填写两个服务的地址、端口及各自的访问凭据。局域网使用 NAS 实际地址，公网入口使用部署时配置的 HTTPS 域名。

3.6.5 使用 Android Keystore 保护两个管理令牌，并迁移旧设置。公网路线要求 HTTPS，受信任的局域网可继续使用原有 HTTP 入口。3.6.5 自动登录依赖同批更新的服务端。

## Windows 构建

准备 JDK 和包含 Build Tools、Android 平台的 SDK。构建脚本从 `JAVA_HOME`、`ANDROID_SDK_ROOT` 读取环境，并使用仓库的通用图标生成应用图标。

请在当前 PowerShell 会话中设置 `ANDROID_KEYSTORE_PATH`、`ANDROID_KEY_ALIAS` 和 `ANDROID_STORE_PASSWORD`，然后从仓库根目录运行。

```powershell
.\android-app\build-apk.ps1
```

构建脚本会在仓库根目录输出 APK，并执行签名验证。用于覆盖自己此前安装的版本时，签名证书须一致。

Java 路由和连接状态测试在 `tests/` 下，可与 `src/` 中同名的纯 Java 组件一起编译运行。
