# Android 客户端

Android Studio 打开本目录，使用 IDE 自带 JDK。compile/target SDK 37，最低 API 26，AGP 9.4.0、Gradle 9.6.0。

~~~powershell
.\gradlew.bat assembleDebug lintDebug
~~~

APK：app/build/outputs/apk/debug/app-debug.apk，调试签名，不包含正式发布密钥。

## 使用

默认服务器 hgame.tudoucoding.tech:8888。右上角设置可保存域名/IP 和端口，更换服务器会退出当前房间并重新连接。模拟器联调填 10.0.2.2:18888；真机填开发电脑局域网 IP。

大厅创建或加入房间，房主选择每步时间，双方准备后开局。大厅、等待页、对局页右上角均可查看完整规则。棋盘左侧为红方、右侧为黑方的阵亡统计；顺序为将帅、士、象、车、马、炮、兵卒，未阵亡灰显，阵亡后点亮并显示数字角标。

点击暗棋翻开；点击己方明棋选中，再点目标格移动或吃子；再次点击选中棋子取消选择。规则详情见 [棋局方案](../docs/GAME_RULES.md)。

GameService 独立维护连接及房主业务，采用用户可停止的前台服务和续期有限的唤醒锁，后台不主动断开。5 秒心跳，连续 30 秒无 PONG 关闭；前台每次连接/握手失败完全结束后等待 3 秒重试。成功回大厅，不恢复旧房间。退出 App 或移除最近任务关闭连接。

使用 Android 的 specialUse 前台服务类型，依据 [Android 前台服务类型说明](https://developer.android.com/develop/background-work/services/fgs/service-types)。Android 13+ 请求通知权限，Android 17 请求局域网权限；拒绝权限可在系统设置中重新授权。模拟器检查不等于厂商真机兼容验收。

GameEngine 和 HostController 无 Android 依赖，在完整仓库的 Maven 检查中与实际 TcpClient 一起验证。暗棋真实身份和历史棋面仅由房主保存，公开快照用 99 表示暗棋。
