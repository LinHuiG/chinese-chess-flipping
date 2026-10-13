# 赛博房间 Android

版本 0.7.2 / versionCode 12，包名保持 com.chessflipping.client。Android Studio 打开本目录；JDK 25、AGP 9.4.0、Gradle 9.6.0、compile/target SDK 37，最低 API 26。

~~~powershell
.\gradlew.bat assembleDebug testDebugUnitTest lintDebug
~~~

调试 APK 在 app/build/outputs/apk/debug/app-debug.apk。正式发布使用 Actions 中原有签名，调试签名不能覆盖正式包。

## 使用

默认 **TCP / fqgame.tdcode.tech / 8888**。升级保留服务器设置，设置页“恢复默认值”后“保存设置”生效。可改 HTTP/HTTPS，分别使用 WS/WSS，路径 /ws。模拟器使用 10.0.2.2 访问开发电脑。

大厅选择翻棋（2 人）或黄金矿工（2–3 人）。凑齐设定人数，大家准备后开局。房主退出立即解散，不转让。矿工每位玩家操作自己的爪子和购物，房主每 5 秒保存，也可手动保存；重新建房可继续，按加入顺序恢复原座位财富和装备。房主进入后台会暂停矿工。

翻棋规则、禁止重复棋面、30/60/90 秒或不限时、两侧阵亡统计保持。棋盘真实暗棋只存房主设备。心跳每 5 秒，15 秒未回包时重连，服务端最后有效心跳后 60 秒回收；有效期内可恢复连接。服务器重启使房间失效，矿工本地存档仍保留。

## 实现

App 的 UI、玩法、房主裁判和存档共用 server/src/main/resources/web 的 ES 模块，构建时直接打包为本地 assets。GameService 持有本地 WebView，Activity 重建时重新挂接；不下载远端页面进入 NativeRoom 桥接环境。只允许 appassets.androidplatform.net/web 的本地资源，外部链接交系统浏览器。

Java 保留原生 TCP 自定义 ECDH/HKDF/AES-GCM、OkHttp WS/WSS、UDP socket、设置和 APK 校验安装。P2P 按已获准对端协商密钥，带方向密钥、64 包重放窗口与客户端分片；操作未获房主确认时 400 ms 经服务器重试。Web 玩家或 UDP 不通时服务器转发，HTTP 模式不禁止 App 之间尝试 UDP。

UDP 最大数据报 1200 字节，单对端 256 KB/s 预算；20 KB 分片重组已在本机 socket 测试。真实 Wi‑Fi/5G NAT 组合与厂商后台策略仍需真机验收。

用户可通过常驻通知断开。Android 13+ 请求通知权限，Android 17 请求局域网权限。正式 APK 关闭 WebView 调试，debug 包可用 CDP 验收。测试夹具只打入 androidTest APK。

接入新功能见 [开发指南](../docs/FRAMEWORK_DEVELOPMENT_GUIDE.md)，协议见 [接入手册](../docs/CYBER_ROOM_INTEGRATION_MANUAL.md)。v3 不兼容旧版，需要一起升级服务器与客户端。
