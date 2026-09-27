# 服务器部署

本轮用户要求：代码检查后推送 GitHub，通过 Actions 发布镜像；用户自行在服务器拉取和部署。助手不操作远端服务器。

## 前提

服务器已安装 Docker Engine 和 Compose 插件。域名 hgame.tudoucoding.tech 指向服务器，云安全组和服务器防火墙放行 TCP 8888。本项目使用原始 TCP，不是网页或 HTTP 接口。

发布镜像为 ghcr.io/linhuig/chinese-chess-flipping:latest，支持 linux/amd64 和 linux/arm64；正式拉取前应确认对应 Actions 发布成功。

## 本次发布已确认

- 源代码：b47535fe2a0e6f24e81b9c372342cbdab979a86a，包含本轮服务端同步恢复与 START 大小校验修复。
- [Actions 36313268361](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36313268361)：test/publish 均成功，2026-09-27 18:44:50（北京时间）完成。
- 标签：latest、sha-b47535f；匿名获取镜像清单成功，已确认 linux/amd64、linux/arm64。
- 两个标签共同摘要：sha256:32378fc8281a443e023bc0deb723c52bafb8b1f0d0d8a7f4a1d0f39f7def967e。
- 需要固定本次版本时，可将下面 image 改为 ghcr.io/linhuig/chinese-chess-flipping:sha-b47535f，或使用 @sha256 摘要格式。上一发布标签 sha-5a165bf 保留作回滚参考。

本次只发布镜像，没有连接或修改用户服务器；实际拉取和运行由用户完成。

自动发布只针对 main 整次推送前后 server/ 的变化，包含源码、依赖与 Docker 配置。客户端/文档/工作流单独变化仅测试，不重新构建镜像；PR 只测试，单独推送标签不自动发布。手动 Run workflow 可以主动重建，仍须测试通过。

## compose.yaml

在服务器的部署目录中使用：

~~~yaml
services:
  server:
    image: ghcr.io/linhuig/chinese-chess-flipping:latest
    container_name: chess-flipping
    ports:
      - "8888:8888/tcp"
    environment:
      TCP_PORT: "8888"
      TCP_WORKER_THREADS: "2"
      JAVA_TOOL_OPTIONS: "-Xms16m -Xmx128m -XX:+UseSerialGC -XX:MaxDirectMemorySize=16m -Xss512k"
    restart: unless-stopped
    stop_grace_period: 20s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
~~~

不需要数据库或数据卷。服务重启时用户、房间和对局全部清空。

128 MiB 是最大 Java 堆，不是容器总内存限制；不要把容器内存硬限额直接设为 128 MiB。先观察实际负载，需要更多连接时再调整堆和线程。2 个工作线程是小型部署起点，不是经压测得出的最大吞吐配置。

## 首次启动和更新

~~~sh
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 server
~~~

更新时同样先 pull，再 up -d。发布镜像不会自动更新已经运行的服务器。

回滚：把 image 的 latest 改为已确认可用的 sha-* 标签或镜像摘要，再执行上述命令。客户端与服务端协议需匹配。

## 使用仓库自带配置

也可在部署目录使用 server/compose.yaml 和 server/.env.example，将后者命名为 .env。关键配置为：

~~~dotenv
TCP_PORT=8888
TCP_WORKER_THREADS=2
SERVER_IMAGE=ghcr.io/linhuig/chinese-chess-flipping:latest
JAVA_TOOL_OPTIONS=-Xms16m -Xmx128m -XX:+UseSerialGC -XX:MaxDirectMemorySize=16m -Xss512k
~~~

仓库 compose.yaml 同时保留源码构建入口；只拉镜像部署时使用 docker compose up -d --no-build，避免在服务器上构建。

## 连接验证

App 默认 hgame.tudoucoding.tech:8888。连接后应进入大厅，两台手机可以创建/加入房间。更换地址时使用 App 右上角设置。

无法连接时依次检查容器状态和日志、域名解析、TCP 8888 放行及端口是否占用。网页浏览器不能用于验证此 TCP 协议。
