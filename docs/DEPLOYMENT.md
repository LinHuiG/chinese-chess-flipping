# 服务器部署

本轮用户要求：代码检查后推送 GitHub，通过 Actions 发布镜像；用户自行在服务器拉取和部署。助手不操作远端服务器。

## 前提

服务器已安装 Docker Engine 和 Compose 插件。域名 hgame.tudoucoding.tech 指向服务器，云安全组和服务器防火墙放行 TCP 8888。本项目使用原始 TCP，不是网页或 HTTP 接口。

发布镜像为 ghcr.io/linhuig/chinese-chess-flipping:latest，支持 linux/amd64 和 linux/arm64；正式拉取前应确认对应 Actions 发布成功。

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
