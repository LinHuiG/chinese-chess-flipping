# 翻棋联机基础工程

同一个 GitHub 仓库管理两个独立工程，Docker 镜像只包含 `server/`。

**新线程接手请先阅读 [项目执行记录与交接](PROJECT_STATUS.md)**，其中记录已完成的功能、实际验证结果、GitHub 发布状态、本机环境和待办事项。协作约定见 [AGENTS.md](AGENTS.md)。

**2026-09-27 文档提交范围：**本次仅提交方案、文档与协作记录。下文二进制加密通信的实现说明对应本地工作区，相关源码和测试尚未随本次文档提交入库；远端源码及镜像仍以实际代码和发布结果为准。

**2026-09-27 房间业务方案已归档，尚未开发：**见 [房间管理、连接清理与自动重连方案](docs/ROOM_MANAGEMENT_PLAN.md)。已明确无账号、两人房间、房主维护详细状态、5 秒心跳/服务端 30 秒超时、前台间隔 3 秒重连、同 App 新连接替换旧连接、退出判负及游戏中解散按房主认输。以下通信和使用说明仍描述现有代码，不表示这些新规则已经落地。

**2026-09-27 棋局规则已确认并归档，尚未开发：**见 [翻棋游戏规则与棋局方案](docs/GAME_RULES.md)。涵盖竖向 4 列 8 行棋盘、32 枚随机暗棋、随机先手和首次翻棋定色、各棋子走吃规则、吃暗棋公开身份、棋子吃光及无合法行动判负、房主内存判重，以及 30/60/90 秒或无限的每步计时。其他线程按该文档接续，无需重新确认已定规则。

| 目录 | 用途 | IDE |
| --- | --- | --- |
| `server/` | Java 21 + Spring Boot + Netty TCP 服务 | IntelliJ IDEA |
| `client/` | 原生 Android Java 应用 | Android Studio |
| `.github/workflows/` | 测试服务端并发布 GHCR 镜像 | GitHub Actions |

当前实现二进制 TCP 报文、ECDH + AES-GCM 加密握手、JSON 消息回显、20 秒加密心跳与连接状态显示。固定 21 字节包头明文（以 0xFC 0xFC 开始），控制头和包体整体加密；业务包体为 JSON，握手包体为原始字节数组。未实现棋局规则、房间、用户认证或数据持久化。公钥每次从网络获取，尚无可信服务器身份认证，不能抵御主动中间人攻击。

## 本地联调

1. 用 IDEA 打开 `server/pom.xml`，Project SDK 选择 Java 21，运行 `ServerApplication`。
2. 用 Android Studio 打开 `client/`，使用 IDE 自带 JDK，安装 Android SDK 37 和构建工具，完成 Gradle 同步。
3. 运行 Android 应用。模拟器默认填 `10.0.2.2:9000`；真机填开发电脑的局域网 IP，手机和电脑需能互相访问，Windows 防火墙需允许 TCP 9000。
4. 点击连接，状态依次显示正在连接、正在进行加密握手、加密连接已建立；此时可发送测试消息。进入后台会主动断开，回到前台点击连接重新握手。

本轮协议与原有明文协议、此前无 0xFC 0xFC 前缀的二进制协议均不兼容，请同时更新服务端和客户端。本地源码更新不会自动更新已发布的 Docker 镜像；远端镜像仍以实际提交和 Actions 发布结果为准。

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

## TCP 二进制加密协议 v1

完整字段、包类型、原始握手包体、密钥派生、CRC32 范围与错误处理见 [协议文档](docs/PROTOCOL.md)。

```text
固定头(21 字节明文) | Nonce(12) | 加密后的控制头与包体 | GCM Tag(16)
```

控制头使用 UTF-8 JSON，含 32 位 TID 请求流水号；业务包体为 JSON 对象，如 `{"type":"ECHO","message":"你好"}`。X/Y 表示加密前的控制头/包体字节长度，总长度包含全部线上数据。控制头最大 4 KiB，包体最大 64 KiB。初始公钥交换报文明文，随后握手确认、心跳、业务报文全部加密。

服务端每次启动生成内存 ECC 密钥对，客户端每次连接重新获取公钥，不缓存公钥。两端握手绝对超时 10 秒；客户端每 20 秒发送加密 PING，服务端返回 PONG，90 秒未收到完整报文断开连接。不再发送明文 WELCOME。

## Android 兼容性

最低 Android 8.0（API 26），compile/target SDK 37，AGP 9.4.0 + Gradle 9.6.0。使用 Android 标准 API，无 Google Play 服务或厂商 SDK 依赖，无原生 `.so`，不限定 CPU 架构。支持系统窗口边距与可滚动布局，适用于 iQOO、OnePlus、小米等 Android 手机的基础通信测试。

Android 17 的局域网连接需要本地网络权限，应用在连接前申请。不同厂商系统、折叠屏和网络切换仍需真机验收；当前未声明已经完成厂商机型认证。发布正式 APK 还需要配置自己的签名密钥（不要提交密钥到 GitHub）。

## 验证命令

```sh
mvn -f server/pom.xml verify
cd client
./gradlew assembleDebug lintDebug
```

Windows 使用 `gradlew.bat`。完整仓库的 Maven 验证包含实际 Android 网络代码与 Netty 的 TCP 联调，以及拆包/粘包、中文、密文和包头篡改、重放、会话隔离、握手超时及 HKDF 官方测试向量。独立 server/ 构建会跳过缺少客户端源码的互通测试。设备安装和真机验证另行进行。
