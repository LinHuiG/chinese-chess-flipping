# 服务器部署

0.4.0 同时提供原始 TCP 8888、HTTP 80、WebSocket `/ws` 和网页版。Java 服务内部不加载证书，HTTPS/WSS 由用户的反向代理终止。用户自行部署，助手未操作远端服务器。

## 发布状态

**0.4.0 已发布成功，latest 已包含网页版与 WebSocket。**

- 源码：61a32a5e98a87a94f5ea1098172f355cdae29464。
- [Actions 36318713210](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36318713210)：test / publish 均成功，2026-09-27 20:26:12（北京时间）完成发布。
- 镜像标签：`ghcr.io/linhuig/chinese-chess-flipping:latest`、`:sha-61a32a5`。
- 两个标签共同摘要：`sha256:9b35c381efce43638194e65786ef46271ebcd74ae4b711e514bf059910cca574`；已匿名核实包含 linux/amd64、linux/arm64。
- 可用旧版回滚标签：`:sha-b47535f`（0.3.0，只有 TCP）。

已有部署需按下面配置补上 HTTP 端口映射再更新；仅拉镜像不会自动修改旧 compose 文件。未操作用户服务器。自动发布只针对 main 整次推送前后 server/ 的变化；客户端、文档和工作流单独变化仅测试。PR 只测试，单独推送标签不自动发布；手动 Run workflow 可以重建，仍须测试通过。

## 使用仓库配置

服务器需要 Docker Engine 和 Compose 插件。将 server/compose.yaml 与 server/.env.example 放入部署目录，后者改名为 .env。核心变量：

~~~dotenv
TCP_PORT=8888
HTTP_PORT=80
HTTP_PUBLISH_PORT=8080
HTTP_BIND_ADDRESS=127.0.0.1
TCP_WORKER_THREADS=2
SERVER_IMAGE=ghcr.io/linhuig/chinese-chess-flipping:latest
JAVA_TOOL_OPTIONS=-Xms16m -Xmx128m -XX:+UseSerialGC -XX:MaxDirectMemorySize=16m -Xss512k
~~~

- TCP 8888 对外保留，云安全组和服务器防火墙按需放行。
- 容器内 HTTP 使用 HTTP_PORT，默认 80，同时提供网页与 `/ws`。
- HTTP_PUBLISH_PORT 是宿主机入口。示例设为 8080，避免与反向代理占用的 80 冲突；仓库默认值为 80。
- HTTP_BIND_ADDRESS 默认 127.0.0.1，供同一宿主机上的反向代理访问。若先直接提供 HTTP，把它改为 0.0.0.0，并放行对应端口。
- 若反向代理也是容器，使用同一 Docker 网络访问 `server:80`；代理容器内的 127.0.0.1 指向它自己。

新镜像确认发布成功后执行：

~~~sh
docker compose pull
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=100 server
~~~

更新同样先 pull 再 up。发布镜像不会自动更新已经运行的容器。回滚时将 SERVER_IMAGE 改为已确认可用的 sha-* 标签或摘要；回滚到 0.3.0 后只能使用 TCP。

从源码自行构建时，需要完整 server/ 目录，在其中执行 `docker compose up -d --build`，并将 SERVER_IMAGE 设置为本地标签，例如 chess-server:local。

## 手写 compose.yaml

也可使用以下等价配置，示例配合同宿主机上的反向代理：

~~~yaml
services:
  server:
    image: ghcr.io/linhuig/chinese-chess-flipping:latest
    container_name: chess-flipping
    ports:
      - "8888:8888/tcp"
      - "127.0.0.1:8080:80/tcp"
    environment:
      TCP_PORT: "8888"
      HTTP_PORT: "80"
      TCP_WORKER_THREADS: "2"
      JAVA_TOOL_OPTIONS: "-Xms16m -Xmx128m -XX:+UseSerialGC -XX:MaxDirectMemorySize=16m -Xss512k"
    restart: unless-stopped
    stop_grace_period: 20s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    sysctls:
      net.ipv4.ip_unprivileged_port_start: "0"
~~~

sysctl 允许容器中的非 root Java 进程监听 80。该配置未在本机 Docker 实测；若平台不支持，可改 HTTP_PORT=8080，并映射 `127.0.0.1:8080:8080`，避免容器内低端口限制。

不需要数据库或数据卷。服务重启清空所有会话、房间和对局。128 MiB 是最大 Java 堆，并非容器总内存；按实际负载调整堆和线程数。

## HTTPS / WSS 反向代理

域名指向服务器，在现有 Nginx HTTPS server 块内加入以下 location，证书、443 监听和 HTTP 跳转按你的现有配置处理：

~~~nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
~~~

网页部署在域名根路径，WebSocket 固定为 `/ws`。保留原始 Host（含非默认端口）和 Origin，不能删掉 Origin 来绕过同源检查。代理需要支持 WebSocket Upgrade；这里复用同一入口处理静态资源与 WS。

浏览器打开 HTTPS 页面自动使用 WSS。Android 选择 HTTPS，填写域名和 443；不要在地址框加协议或 `/ws`。HTTP/WS 不加密，HTTPS 使用系统证书与主机名校验，没有忽略证书开关。

## 客户端和连接检查

| 方式 | 地址 | 说明 |
| --- | --- | --- |
| 浏览器 HTTP | http://域名:公开HTTP端口/ | 页面自动连接同源 /ws |
| 浏览器 HTTPS | https://域名/ | 通过代理使用 WSS |
| Android HTTP | 域名 + 80，或自定义端口 | 关闭 TCP 开关，选择 HTTP |
| Android HTTPS | 域名 + 443 | 关闭 TCP 开关，选择 HTTPS |
| Android TCP | 域名 + 8888 | 打开 TCP 开关，保留原加密协议 |

Android 新安装默认 hgame.tudoucoding.tech、HTTP 80；旧版已保存的服务器设置保留为 TCP。如果你的公网只提供 HTTPS，请在 App 中切换 HTTPS 443。

先用 `curl -I http://127.0.0.1:8080/` 检查 HTTP，再打开网页确认“已连接”，最后双端入房。curl GET 不能验证原始 TCP 8888。无法建立 WSS 时检查代理 Upgrade、Host、证书和超时；无法建立 TCP 时检查 8888 放行和占用。

浏览器、Android TCP、Android WS 共用房间；CHL 也接受 IOS，原生 iOS 客户端尚未开发。房主裁判和断线判负规则保持不变，浏览器切后台后是否持续运行受系统限制。
