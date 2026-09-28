# Rust 服务端

运行入口：src/main.rs。TCP 加密协议见 ../docs/PROTOCOL.md；网络入口、房间和严格 JSON 解析分别位于 src/net.rs、src/hub.rs、src/json.rs。

- `cargo run --release`：本地启动。
- TCP_PORT=8888、HTTP_PORT=80、UDP_PORT=8888，均可设置为 1–65535。
- TCP_WORKER_THREADS=4：共用 Tokio I/O 运行时的工作线程数，范围 1–256。
- 网页位于 src/main/resources/web/，通过 include_bytes 嵌入程序，不在请求时读磁盘。
- server/ 是唯一 Docker 构建上下文。Dockerfile 使用 musl 静态编译与 scratch 运行镜像，数值 UID 10001，无 JVM。

src/main/java、pom.xml 和 Java 测试用于迁移对照及 Android 规则/协议验证；它们不参与生产镜像运行。先构建 Rust，再运行 `mvn verify`；CHESS_RUST_BINARY 可指定需要验证的可执行文件。

会话、房间、请求队列、UDP 登记信息均只存内存。服务器不持久化棋面、战绩或密钥，不记录密钥日志。Web 与旧版安卓仍经服务器中转。P2P 信令允许 HTTP/WS，密钥安全继承该通道的实际安全边界。
