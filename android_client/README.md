# Android 客户端

Android Studio 打开本目录，使用 IDE 自带 JDK。compile/target SDK 37，最低 API 26，AGP 9.4.0、Gradle 9.6.0。

~~~powershell
.\gradlew.bat assembleDebug lintDebug
~~~

APK：app/build/outputs/apk/debug/app-debug.apk，调试签名，不包含正式发布密钥。

## 使用

0.4.0 新安装默认 HTTP hgame.tudoucoding.tech:80；HTTP 使用 WS，HTTPS 使用 WSS，路径固定 /ws。设置页可切换 HTTP/HTTPS 或启用 TCP（默认 8888）。旧版保存的设置保留 TCP，不覆盖用户地址。右上角设置可保存域名/IP 和端口，更换服务器会退出当前房间并重新连接。模拟器联调填 10.0.2.2:18888；真机填开发电脑局域网 IP。

大厅创建或加入房间，房主选择每步时间，双方准备后开局。大厅、等待页、对局页右上角均可查看完整规则。棋盘左侧为红方、右侧为黑方的阵亡统计；顺序为将帅、士、象、车、马、炮、兵卒，未阵亡灰显，阵亡后点亮并显示数字角标。

点击暗棋翻开；点击己方明棋选中，再点目标格移动或吃子；再次点击选中棋子取消选择。规则详情见 [棋局方案](../docs/GAME_RULES.md)。

0.3.0 使用原生浅色界面、自适应双棋子图标，以及按需播放的翻棋/走子/吃子动画和胜负反馈。设置可分别关闭音效与动画，动画同时遵守系统动画开关；静音/振动模式或媒体音量为零不播放音效，切后台释放音效资源。音效与图标由仓库 scripts/generate-game-assets.ps1 离线生成，App 不运行该生成脚本。

棋盘静止时没有动画帧回调；有限时对局的显示倒计时按秒更新，房主超时按剩余时间预约。同步、恢复前台和跳跃快照不追播历史动效。原生 UI 夹具位于 src/androidTest/，只进入测试 APK，不是生产服务端接口；其结果不等于实际联机和真机性能验收。

GameService 独立维护连接及房主业务，采用用户可停止的前台服务和续期有限的唤醒锁，后台不主动断开。5 秒心跳，连续 30 秒无 PONG 关闭；前台每次连接/握手失败完全结束后等待 3 秒重试。成功回大厅，不恢复旧房间。退出 App 或移除最近任务关闭连接。

使用 Android 的 specialUse 前台服务类型，依据 [Android 前台服务类型说明](https://developer.android.com/develop/background-work/services/fgs/service-types)。Android 13+ 请求通知权限，Android 17 请求局域网权限；拒绝权限可在系统设置中重新授权。模拟器检查不等于厂商真机兼容验收。

GameEngine 和 HostController 无 Android 依赖，在完整仓库的 Maven 检查中与实际 TcpClient 一起验证。暗棋真实身份和历史棋面仅由房主保存，公开快照用 99 表示暗棋。

HTTP 明文访问按需求开启；HTTPS 使用系统证书及主机名校验，不接受任意证书。WebSocket 使用 OkHttp 4.12.0，TCP 继续使用原有加密实现。游戏和房主裁判共用同一套逻辑。0.4.0/versionCode 4；本机 Gradle JVM 配置不入库。
