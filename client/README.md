# Android 客户端

**2026-09-27 文档提交说明：**下文加密通信描述的是本地工作区实现，相关源码和测试未包含在本次文档提交中；仅检出远端文档提交不代表客户端已升级。接续状态见 [项目交接记录](../PROJECT_STATUS.md)。

Android Studio 打开本目录，使用自带 JDK，等待 Gradle 同步后运行 app。

要求：支持 AGP 9.4 的 Android Studio、Android SDK 37、可联网下载 Gradle/Google Maven 依赖。

Windows 构建：`gradlew.bat assembleDebug lintDebug`。

调试 APK：`app/build/outputs/apk/debug/app-debug.apk`。

模拟器连接 `10.0.2.2:9000`；真机连接服务器实际 IP，不能用 `localhost` 代替开发电脑。连接后自动获取公钥并建立 ECDH + AES-GCM 会话，状态显示“加密连接已建立”后才能发送 ECHO 测试消息，每 20 秒自动发送加密心跳。进入后台断开连接，返回后手动重连并重新握手。当前是联调基础界面，尚无棋盘和对局业务。

固定 21 字节包头明文（以 0xFC 0xFC 开始），控制头与包体整体加密；业务包体使用 JSON，握手包体使用原始字节数组。协议不兼容旧版明文服务端或无 0xFC 0xFC 前缀的二进制服务端，两端必须同步更新；公钥不缓存。详细字段与安全边界见 [协议文档](../docs/PROTOCOL.md)。

完整仓库中的服务端 `mvn verify` 会在 JVM 上编译并运行这里的实际 `TcpClient` 与协议类，通过真实 TCP 与 Netty 联调。这不等同于 Android 真机测试；仍需在目标手机验证系统加密提供者、网络权限及后台行为。
