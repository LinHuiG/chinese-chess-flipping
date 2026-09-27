# Android 客户端

Android Studio 打开本目录，使用自带 JDK，等待 Gradle 同步后运行 app。

要求：支持 AGP 9.4 的 Android Studio、Android SDK 37、可联网下载 Gradle/Google Maven 依赖。

Windows 构建：`gradlew.bat assembleDebug lintDebug`。

调试 APK：`app/build/outputs/apk/debug/app-debug.apk`。

模拟器连接 `10.0.2.2:9000`；真机连接服务器实际 IP，不能用 `localhost` 代替开发电脑。连接后显示 WELCOME，发送消息后显示 ECHO，每 20 秒自动心跳。进入后台断开连接，返回后手动重连。当前是联调基础界面，尚无棋盘和对局业务。
