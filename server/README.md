# 服务端

Java 21、Spring Boot、Netty TCP，不启动 HTTP 服务。IDEA 打开 pom.xml，运行 ServerApplication。

~~~sh
mvn verify
java -jar target/chess-server.jar
~~~

配置：TCP_PORT 默认 9000，范围 1–65535；TCP_WORKER_THREADS 默认 4，范围 1–256。小型服务器可从 2 个 I/O 工作线程开始。部署示例使用 TCP_PORT=8888，与 App 默认地址端口一致。

服务端管理加密会话、DID 在线去重、房间成员和版本、开始/结束/解散、房主请求转发、有效心跳超时和统一清理。不保存暗棋、历史棋面、准备详情或离线战绩，房主断线直接结束本局。

## 资源控制

- 会话注册、房间状态变更和事件入队在 RoomHub 内串行化，网络写入及加密在各自 EventLoop 顺序执行。
- 心跳只安排下一次到期检查，不每秒遍历所有会话；普通业务不刷新有效心跳时间。
- 每用户最多 8 个房主转发请求，8 秒到期；请求、用户及房间维护索引，清理不扫描全部房间。
- 列表每页最多 64 个房间，通过有序 ID 游标继续查询。
- Netty 使用至多 2 个小型堆缓冲池，无线程本地缓存；读缓冲自适应，写水位 32/64 KiB；每连接最多 32 个排队业务输出，慢连接关闭。
- Docker JVM 默认 -Xms16m -Xmx128m -XX:+UseSerialGC -XX:MaxDirectMemorySize=16m -Xss512k；可通过 JAVA_TOOL_OPTIONS 替换。进程总内存还包含元空间、代码缓存、线程栈等。

完整仓库运行实际 Android 代码联调和棋局规则测试；独立 server/ Docker 上下文自动跳过需要 client/ 的检查。ResourceProbe 是手动有界心跳连接测量工具，不在常规测试中运行。

Docker 构建上下文只用 server/。完整部署文件及拉取命令见 [部署文档](../docs/DEPLOYMENT.md)，线协议见 [PROTOCOL.md](../docs/PROTOCOL.md)。
