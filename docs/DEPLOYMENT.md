# 服务器部署（Rust 0.5.0）

实际已发布版本和 Actions 结果见 ../PROJECT_STATUS.md。默认由用户自行部署；本轮两台服务器的更新已获得明确授权。公开文档仅保留通用配置，不记录实际部署地址、登录账号、密码或管理入口。

Android 0.5.1 修复 UDP 多来源路径导致的直连回退，两端客户端均应升级。定向检查和构建已通过，真实双方联机仍待验收；生产服务端程序没有因此改变。

## UDP 排查

- TCP 与 UDP 规则相互独立，云端安全组或轻量实例防火墙需要单独放行 UDP 8888。确认规则关联正确的实例，来源覆盖实际客户端网络，且没有更高优先级的匹配拒绝规则。
- 如果限制云端出站流量，也要检查对应 UDP 出站策略。系统防火墙、Docker 映射和服务监听均需要正确；仅在系统内放行不代表云端规则已放行。
- 通过双方服务器互探和容器抓包区分本地网络、云端路径及容器转发问题。端口可达不等于实际 Android P2P 验收完成。
- 参考：[轻量实例防火墙](https://cloud.tencent.com/document/product/1207/44577)、[CVM 安全组](https://cloud.tencent.com/document/product/213/112614)。

## 使用 Docker Compose

仓库的 server/compose.yaml 已包含全部端口与安全配置。在服务器保存该文件，创建同目录 .env：

~~~dotenv
SERVER_IMAGE=ghcr.io/linhuig/chinese-chess-flipping:latest
TCP_PORT=8888
HTTP_PORT=80
HTTP_BIND_ADDRESS=127.0.0.1
HTTP_PUBLISH_PORT=80
UDP_PORT=8888
TCP_WORKER_THREADS=2
~~~

然后执行：

~~~sh
docker compose pull
docker compose up -d --no-build
docker compose logs --tail=50 server
~~~

如果直接对外提供 HTTP，把 HTTP_BIND_ADDRESS 改为 0.0.0.0；如使用同机反向代理则保持回环监听。需要开放 TCP 8888、UDP 8888，以及实际对外提供网页的 HTTP/HTTPS 端口。端口值可修改，但 UDP 的容器内外端口保持一致，服务器会向安卓告知 UDP_PORT。

TCP 与 UDP 可以使用相同的数字端口，它们是两种独立协议。只开放 TCP 8888 不会开放 UDP 8888。UDP 不可达时客户端自动继续中转，不影响普通联机。当前打洞协助监听 IPv4；无法取得 IPv4 可达路径时回退中转。

Rust 不使用 JAVA_TOOL_OPTIONS，不需要 JVM 或配置堆大小。TCP_WORKER_THREADS 控制 TCP/HTTP/UDP 共用的工作线程数，可先用 2，根据实际负载调整。进程内存、CPU 和镜像大小以实测为准。

## HTTPS 反向代理示例

~~~nginx
location / {
    proxy_pass http://127.0.0.1:80;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 60s;
}
~~~

证书和 TLS 由用户配置，浏览器 HTTPS 页面自动使用 WSS。安卓设置支持 HTTP、HTTPS 和原始加密 TCP。上述 HTTP 代理不负责 UDP；域名需让安卓能够直接到达 UDP 协助监听端口。若代理或网络阻止 UDP，继续使用中转。

按用户要求，HTTP/WS 也允许 P2P，房主主密钥会在这一控制链路上明文传输。服务器可见密钥但不持久化；不要把这种模式称为服务器不可解密的端到端加密。现有自定义 TCP 也没有可信服务器身份认证。

## 更新、回退与状态

- 更新会清空在线房间，客户端重新连接后回大厅。
- 直连期间服务器连接仍必须保持；服务器断线仍按退出判负。
- 可使用上一版 sha-* 镜像标签回退。旧服务器没有 P2P 能力，新安卓不会主动向其发送直连申请。
- 若只修改安卓、文档或工作流，Actions 不自动重建服务端镜像。修改 server/ 或手动运行工作流才发布。
- server/pom.xml 仅用于迁移验证，生产启动程序为 /app/chess-server。
