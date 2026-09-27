# 服务端

用 IDEA 打开当前目录的 `pom.xml`，选择 Java 21，运行 `com.chessflipping.server.ServerApplication`。

默认 TCP 端口 9000，工作线程 4。IDE 的运行配置 Environment variables 中可以设置 `TCP_PORT=9000;TCP_WORKER_THREADS=4`。

构建：`mvn verify`。运行：`java -jar target/chess-server.jar`。

Docker：`docker compose up -d --build`。发布流水线位于仓库根目录 `.github/workflows/`，应上传整个父目录，详细操作见根目录 README。
