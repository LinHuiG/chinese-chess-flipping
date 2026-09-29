# Rust 服务端

运行入口：src/main.rs。TCP 加密协议见 ../docs/PROTOCOL.md；网络入口、房间和严格 JSON 解析分别位于 src/net.rs、src/hub.rs、src/json.rs。

- 首次先构建 Android APK，再从仓库根目录执行 `python scripts/package-app-update.py` 生成更新资源；随后 `cargo run --release` 本地启动。Actions 自动执行这一流程。
- TCP_PORT=8888、HTTP_PORT=80、UDP_PORT=8888，均可设置为 1–65535。
- TCP_WORKER_THREADS=4：共用 Tokio I/O 运行时的工作线程数，范围 1–256。
- 网页位于 src/main/resources/web/，更新包位于 app-update/；作为独立层打入镜像，启动时读取一次并共享 Bytes，不在请求时读磁盘。CHESS_RESOURCE_DIR 在镜像中为 /app，本地默认工程目录；缺少资源或 APK 清单校验失败时启动失败。APK 与版本清单是生成文件，不入库；发布包由 Actions 用固定签名构建。
- server/ 是唯一 Docker 构建上下文。Dockerfile 使用 musl 静态编译与 scratch 运行镜像，数值 UID 10001，无 JVM。资源在 Rust 编译之后复制，仅改网页/APK 时可复用编译缓存。

使用 `cargo check --locked` 做编译检查，`cargo test --locked` 运行 Rust 测试。旧 Java 实现、Maven 配置及其验证夹具已移除；Android 客户端仍是独立的 Java 工程。

会话、房间、请求队列、UDP 登记信息均只存内存。服务器不持久化棋面、战绩或密钥，不记录密钥日志。Web 经服务器中转；0.5.x 客户端不能连接 v2 服务，须一起升级。P2P 信令允许 HTTP/WS，密钥安全继承该通道的实际安全边界。

源码已按功能块加中文注释，建议按 main.rs → net.rs → hub.rs 阅读，wire.rs / json.rs 用于查看协议细节；update.rs 是版本检查和 TCP/HTTP 下载。用户断线只解绑，最后心跳 60 秒后才退出和清理；Hub 不保存棋面、昵称资料。

中转正文使用 Bytes 原样传递，服务端不解析棋局 JSON；TCP 外层仍需解密和重加密，WS 封帧也有复制，不承诺全链路零拷贝。当前 IPv4 服务器可交换客户端全局 IPv6 候选，无需部署 IPv6 才能尝试客户端 IPv6 直连。
