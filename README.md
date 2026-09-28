# 翻棋联机

Rust 服务端、原生 Java Android 客户端，以及响应式网页版。server/ 和 android_client/ 是独立工程；Docker 只构建 server/，包含网页资源。当前版本 0.5.0；实际发布和验证状态见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

接续阅读 [协作说明](AGENTS.md)、[本轮方案](docs/RUST_P2P_PLAN.md)、[房间规则](docs/ROOM_MANAGEMENT_PLAN.md)、[棋局规则](docs/GAME_RULES.md)、[通信协议](docs/PROTOCOL.md)。

## 功能

- 无账号、双人房间、准备、房主转移、退出与断线判负；同 DID 新连接替换旧连接，重连回大厅。
- 房主维护棋盘、规则、每步计时及正常胜负。服务器只维护最小会话和房间信息、转发消息、处理退出判负。
- TCP 8888 保留原有 P-256 / HKDF / AES-GCM 二进制协议；HTTP 80 提供网页和 /ws。HTTPS/WSS 由反向代理终止 TLS。
- 新版安卓双方开局后尝试 UDP 直连。房主随机主密钥经服务器转发；UDP 使用方向独立的 AES-256-GCM 加密、防重放和有限重试。失败回退中转，Web 和旧版安卓始终中转。
- HTTP/WS 模式也允许 P2P：该模式下分发密钥的链路是明文；服务器能看到密钥，不承诺服务器不可解密或可信身份认证。
- 安卓和 Web 显示服务器心跳往返延迟；安卓显示直连/中转，直连成功且有有效样本时才显示 UDP 延迟。心跳更新不重绘棋盘，界面沿用简洁 iOS 风格。
- 保留 4×8 棋盘、已确认的特殊吃法、禁止重复棋面、每步 30/60/90 秒或无限、阵亡统计和按需动效音效。

## 本地运行

1. 安装 Rust 稳定工具链。在仓库根目录设置 TCP_PORT=18888、HTTP_PORT=18880、UDP_PORT=18888、TCP_WORKER_THREADS=2，然后执行 `cargo run --release --manifest-path server/Cargo.toml`。
2. Android Studio 打开 android_client/，使用 SDK 37、Build Tools 36.0.0。设置服务器为电脑可达地址和相应 HTTP 或 TCP 端口。
3. 浏览器打开 http://localhost:18880/。模拟器通过 10.0.2.2 访问宿主机；UDP 穿越受模拟器虚拟网络限制，不能用它推断公网打洞成功率。
4. 手机在设置中选择 HTTP/HTTPS/TCP。新版默认 HTTP hgame.tudoucoding.tech:80；旧版地址保留。

直连不替代服务器在线连接。UDP 断开会中转；服务器断开仍按退出判负。切换通道不重置每步计时。后台连接由前台服务维护，系统仍可能终止进程。

## 构建与检查

~~~powershell
cargo build --locked --release --manifest-path server/Cargo.toml
# Java 21 / Maven 仅用于旧实现对照、Android 规则与 Rust 黑盒互通检查。
# 先构建 Rust；也可通过 CHESS_RUST_BINARY 指向其绝对路径。
mvn -f server/pom.xml verify
# 在 android_client/ 中：
gradlew.bat assembleDebug lintDebug
~~~

生产入口为 Rust 可执行文件，不运行 JAR。server/src/main/java 保留为迁移对照及验证夹具，不进入生产镜像。Android 保持原生 Java，不引入 WebRTC 或原生 .so。APK 位于 android_client/app/build/outputs/apk/debug/app-debug.apk。

## Docker 与发布

镜像地址：ghcr.io/linhuig/chinese-chess-flipping:latest，另有 sha-* 标签。GitHub Actions 构建 Rust，并运行 Java/Android 互通验证；仅 main 整次推送包含 server/ 变化时发布 amd64、arm64 镜像，或手动触发发布。

容器运行时只包含静态 Rust 程序（内嵌网页），没有 JVM。保留 TCP_PORT、HTTP_PORT、TCP_WORKER_THREADS，新增 UDP_PORT。直连协助端口需独立开放 UDP；现有 HTTP 反向代理不会自动转发它。部署配置见 [部署说明](docs/DEPLOYMENT.md)，由用户自行部署，不远程操作服务器。

## 验证边界

编译、桌面 JVM 联调、模拟器、公网真机和 Linux 容器是不同验证层级。以项目状态记录的实际结果为准，不能从本机短测推断最大容量、所有 NAT 穿透成功率或真机兼容性。
