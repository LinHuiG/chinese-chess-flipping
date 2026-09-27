# 翻棋联机基础工程

同一个 GitHub 仓库管理两个独立工程，Docker 镜像只包含 `server/`。

| 目录 | 用途 | IDE |
| --- | --- | --- |
| `server/` | Java 21 + Spring Boot + Netty TCP 服务 | IntelliJ IDEA |
| `client/` | 原生 Android Java 应用 | Android Studio |
| `.github/workflows/` | 测试服务端并发布 GHCR 镜像 | GitHub Actions |

当前实现 TCP 连接、JSON 消息回显、20 秒心跳与连接状态显示；未实现棋局规则、房间、用户认证或数据持久化。协议是明文 TCP，正式开放含账号等敏感信息的业务前需增加 TLS 和认证。

## 本地联调

1. 用 IDEA 打开 `server/pom.xml`，Project SDK 选择 Java 21，运行 `ServerApplication`。
2. 用 Android Studio 打开 `client/`，使用 IDE 自带 JDK，安装 Android SDK 37 和构建工具，完成 Gradle 同步。
3. 运行 Android 应用。模拟器默认填 `10.0.2.2:9000`；真机填开发电脑的局域网 IP，手机和电脑需能互相访问，Windows 防火墙需允许 TCP 9000。
4. 点击连接，收到 WELCOME 后发送测试消息。进入后台会主动断开，回到前台点击连接重连。

## GitHub 发布（整个根目录上传）

目标仓库：https://github.com/LinHuiG/chinese-chess-flipping

推送 `main` 或 `v*` 标签后，仓库根目录的 `.github/workflows/publish.yml` 会先运行服务端测试，再根据 `server/Dockerfile` 构建 Linux amd64 和 arm64 镜像，并上传：

```text
ghcr.io/linhuig/chinese-chess-flipping:latest
```

`latest` 跟踪默认分支；版本标签如 `v0.1.0` 会产生同名镜像标签；每次构建另有 `sha-*` 标签。PR 只测试，不发布。发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需把密码放进代码。

在 GitHub 仓库的 Actions 页面查看构建进度。首次发布后，在个人主页 Packages 中打开镜像包，在 Package settings 中根据需要设为 Public；公开仓库不代表镜像包自动公开。公开镜像可匿名拉取，私有镜像需要 `docker login ghcr.io`，使用具备 `read:packages` 且有包访问权限的令牌。

## 用 Docker 部署

本地从源码构建（在 `server/` 执行）：

```sh
docker compose up -d --build
```

服务器从 GHCR 拉取（把 `server/compose.yaml` 和 `server/.env.example` 放到同一部署目录，把 `.env.example` 复制为 `.env`）：

```sh
docker compose pull
docker compose up -d --no-build
docker compose logs -f
```

`.env` 中可配置：

```dotenv
SERVER_IMAGE=ghcr.io/linhuig/chinese-chess-flipping:latest
TCP_PORT=9000
TCP_WORKER_THREADS=4
```

`TCP_PORT` 同时配置宿主机映射端口和容器监听端口，范围 1–65535。`TCP_WORKER_THREADS` 是 Netty I/O 工作线程数，范围 1–256，默认 4；另有 1 个接入线程及 JVM/Spring 内部线程，不代表进程全部线程数量。不在 I/O 线程中执行阻塞数据库访问等业务。

更新：再次执行 `docker compose pull` 和 `docker compose up -d --no-build`。回滚：将 `SERVER_IMAGE` 改为旧版本标签或镜像摘要后重新执行。公网访问需在服务器防火墙/云安全组放行选定 TCP 端口。

## TCP 协议 v1

UTF-8 编码，每条 JSON 消息以换行 `\n` 结束；最大入站帧 8192 字节（不含换行）。支持拆包和粘包。90 秒未收到数据服务端断开连接，客户端每 20 秒发送 PING。

```json
{"type":"WELCOME","protocolVersion":1}
{"type":"PING","requestId":"1"}
{"type":"PONG","requestId":"1"}
{"type":"ECHO","message":"你好","requestId":"2"}
```

WELCOME 由服务端在连接时主动发送，PING 返回 PONG，ECHO 返回同名类型和原消息。合法文本 requestId 原样返回。非法请求返回 ERROR 和错误码；超长消息断开连接。

## Android 兼容性

最低 Android 8.0（API 26），compile/target SDK 37，AGP 9.4.0 + Gradle 9.6.0。使用 Android 标准 API，无 Google Play 服务或厂商 SDK 依赖，无原生 `.so`，不限定 CPU 架构。支持系统窗口边距与可滚动布局，适用于 iQOO、OnePlus、小米等 Android 手机的基础通信测试。

Android 17 的局域网连接需要本地网络权限，应用在连接前申请。不同厂商系统、折叠屏和网络切换仍需真机验收；当前未声明已经完成厂商机型认证。发布正式 APK 还需要配置自己的签名密钥（不要提交密钥到 GitHub）。

## 验证命令

```sh
mvn -f server/pom.xml verify
cd client
./gradlew assembleDebug lintDebug
```

Windows 使用 `gradlew.bat`。服务端测试覆盖 TCP 拆包/粘包、中文消息、非法 JSON、未知类型、超长帧和配置校验。
