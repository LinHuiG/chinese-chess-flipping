# 服务端

**2026-09-27 文档提交说明：**下文加密通信描述的是本地工作区实现，相关源码和测试未包含在本次文档提交中；远端源码和镜像仍以实际代码及发布结果为准。接续状态见 [项目交接记录](../PROJECT_STATUS.md)。

用 IDEA 打开当前目录的 `pom.xml`，选择 Java 21，运行 `com.chessflipping.server.ServerApplication`。

默认 TCP 端口 9000，工作线程 4。IDE 的运行配置 Environment variables 中可以设置 `TCP_PORT=9000;TCP_WORKER_THREADS=4`。

构建：`mvn verify`。运行：`java -jar target/chess-server.jar`。

使用以 0xFC 0xFC 开始的 21 字节固定头二进制协议，控制头与业务包体整体 AES-GCM 加密。启动时生成内存 ECC 密钥对，客户端每次连接获取公钥并完成 ECDH 握手；业务包体为 JSON，握手包体为原始字节数组。详见 [协议文档](../docs/PROTOCOL.md)，旧版明文客户端及无 0xFC 0xFC 前缀的二进制客户端无法连接。

完整仓库中 `mvn verify` 还会编译实际 Android 网络代码并通过真实 TCP 联调；仅复制 server/ 或 Docker 构建时没有客户端源码，会跳过这一组跨工程测试，其余协议测试照常运行。

Docker：`docker compose up -d --build`。发布流水线位于仓库根目录 `.github/workflows/`，应上传整个父目录，详细操作见根目录 README。
