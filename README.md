# 翻棋联机

Rust 服务端、原生 Java Android 客户端，以及响应式网页版。server/ 和 android_client/ 是独立工程；Docker 只构建 server/，包含网页和 APK 更新资源。服务端当前版本 0.6.0，Android 0.6.1（兵卒可互吃）；实际发布和验证状态见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

接续阅读 [协作说明](AGENTS.md)、[本轮方案](docs/SESSION_PROTOCOL_V2_PLAN.md)、[房间规则](docs/ROOM_MANAGEMENT_PLAN.md)、[棋局规则](docs/GAME_RULES.md)、[通信协议](docs/PROTOCOL.md)。

## 功能

- 无账号、双人房间、准备、房主转移；用户与连接解绑，断线后保留 60 秒，App 重启和网页刷新可恢复原会话。用户名存本地，服务器只转发，默认房名为“用户名的房间”。
- 房主维护棋盘、规则、每步计时及正常胜负。服务器只维护最小会话和房间信息、转发消息、处理退出判负。
- TCP 8888 使用 v2 P-256 / HKDF / AES-GCM 二进制协议，WS 共用 v2 二进制帧；HTTP 80 提供网页和 /ws。HTTPS/WSS 由反向代理终止 TLS。
- 新版安卓双方开局后尝试 UDP 直连。房主随机主密钥经服务器转发；UDP 使用方向独立的 AES-256-GCM 加密、防重放和有限重试。失败回退中转，Web 始终中转；0.5.x 客户端须同步升级。
- HTTP/WS 模式也允许 P2P：该模式下分发密钥的链路是明文；服务器能看到密钥，不承诺服务器不可解密或可信身份认证。
- 安卓和 Web 显示服务器心跳往返延迟；安卓显示直连/中转，直连成功且有有效样本时才显示 UDP 延迟。心跳更新不重绘棋盘，界面沿用简洁 iOS 风格。
- App 设置提供“检查更新”和自动更新开关；只下载更高 versionCode，校验哈希、包名及签名后调用系统安装。TCP 分块或 HTTP 下载，游戏中推迟自动弹出安装。
- 保留 4×8 棋盘、已确认的特殊吃法、禁止重复棋面、每步 30/60/90 秒或无限、阵亡统计和按需动效音效。

## 本地运行

1. 安装 Rust 稳定工具链，按下节先构建一次 APK 更新资源。在仓库根目录设置 TCP_PORT=18888、HTTP_PORT=18880、UDP_PORT=18888、TCP_WORKER_THREADS=2，然后执行 `cargo run --release --manifest-path server/Cargo.toml`。
2. Android Studio 打开 android_client/，使用 SDK 37、Build Tools 36.0.0。设置服务器为电脑可达地址和相应 HTTP 或 TCP 端口。
3. 浏览器打开 http://localhost:18880/。模拟器通过 10.0.2.2 访问宿主机；UDP 穿越受模拟器虚拟网络限制，不能用它推断公网打洞成功率。
4. 手机在设置中选择 HTTP/HTTPS/TCP。新版默认 HTTP hgame.tudoucoding.tech:80；旧版地址保留。

直连不替代服务器在线连接。UDP 断开会中转；服务器连接中断保留用户到最后有效心跳后 60 秒，状态灰显；服务器进程重启则原房间全部失效。切换通道不重置每步计时。后台连接由前台服务维护，系统仍可能终止进程。

## 构建与检查

~~~powershell
# 仓库根目录：先生成服务端运行时需要的 APK 与版本清单（生成物不入库）。
android_client/gradlew.bat -p android_client assembleDebug
python scripts/package-app-update.py
cargo build --locked --release --manifest-path server/Cargo.toml
cargo test --locked --manifest-path server/Cargo.toml
# 在 android_client/ 中：
gradlew.bat assembleDebug lintDebug testDebugUnitTest
~~~

服务端仅保留 Rust 实现，旧 Java/Maven 已移除；棋规、UDP 和恢复检查迁入 Android 单元测试。Android 保持原生 Java，不引入 WebRTC 或原生 .so。APK 位于 android_client/app/build/outputs/apk/debug/app-debug.apk。

原始 TCP/WS 与更新下载互通测试需先启动本地服务器，给 Gradle 设置 CHESS_TEST_TCP_PORT / CHESS_TEST_HTTP_PORT；未设置时跳过相应互通项。Web 恢复/去重纯逻辑检查：`node scripts/session-v2-test.mjs`；双浏览器联调：设置 CHESS_WEB_URL 后运行 `node scripts/web-smoke.cjs`（需 Playwright）。

## Docker 与发布

镜像地址：ghcr.io/linhuig/chinese-chess-flipping:latest，另有 sha-* 标签。Actions 自动构建固定签名的 release APK，生成版本清单，再由原生 amd64、arm64 机器独立构建镜像；各自完成即发布 latest-amd64 / latest-arm64，两者都成功后合并通用 latest；同时提供 app-update 下载附件。main 推送包含 Android、服务端或 APK 打包脚本变化时发布，也可手动触发；仅改工作流或仓库文档不触发推送构建。新架构标签从下一次代码发布开始提供。

容器运行时包含静态 Rust 程序及独立的网页、APK 资源层，没有 JVM。资源在启动时读取并共享，Docker 编译层仅依赖 Rust 源码和 Cargo 配置；仅改网页或 APK 时可复用缓存中的服务端程序，缓存缺失或基础镜像变化时仍会重新编译。保留 TCP_PORT、HTTP_PORT、TCP_WORKER_THREADS，新增 UDP_PORT。直连协助端口需独立开放 UDP；现有 HTTP 反向代理不会自动转发它。签名配置和部署见 [部署说明](docs/DEPLOYMENT.md)，由用户自行部署，不远程操作服务器。

## 验证边界

编译、桌面 JVM 联调、模拟器、公网真机和 Linux 容器是不同验证层级。以项目状态记录的实际结果为准，不能从本机短测推断最大容量、所有 NAT 穿透成功率或真机兼容性。
