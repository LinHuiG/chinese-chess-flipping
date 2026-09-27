# 项目执行记录与交接

更新时间：2026-09-27（Asia/Shanghai）。以下区分已验证结果与待确认状态，新线程不要将待办当成已完成。

## 用户需求与已确定的组织方式

- 在 `D:\Code\chinese-chess-flipping` 下建立 `server/` 和 `client/` 两个独立工程。
- 服务端：Java 21、Spring、对外 TCP，配置项为工作线程数和监听端口，使用 Docker 发布。
- 客户端：Android App，希望支持 iQOO、一加、小米等主流手机的新系统。
- 用户确认整个根目录上传到同一个 GitHub 仓库，Actions 只将服务端打包成 Docker 镜像。
- 仓库：https://github.com/LinHuiG/chinese-chess-flipping ，分支 `main`。
- 要求分别用 IDEA 和 Android Studio 打开工程。用户对 Docker 不熟悉，说明应使用中文并提供可执行步骤。

## 已实现

### 服务端

- Java 21、Spring Boot 3.5.16、Netty；不启动 HTTP 服务。
- 入口：`server/src/main/java/com/chessflipping/server/ServerApplication.java`。
- `TCP_PORT` 默认 9000，范围 1–65535。
- `TCP_WORKER_THREADS` 默认 4，范围 1–256，控制 Netty I/O 工作线程；另有接入线程和 JVM 等内部线程。
- TCP 使用 UTF-8，每行一条 JSON，最大入站帧 8192 字节，支持拆包和粘包。
- 消息：连接时 WELCOME；PING 返回 PONG；ECHO 回显文本；错误返回 ERROR；90 秒无入站消息断开。
- 非法参数在启动时拒绝，包含 Spring 生命周期启动和停止处理。
- 多阶段 Dockerfile、非 root 运行、Compose、环境变量示例已配置。

### Android 客户端

- 原生 Java Android 工程，最低 API 26，compile/target SDK 37，AGP 9.4.0，Gradle 9.6.0，含 Gradle Wrapper。
- 包名 `com.chessflipping.client`。
- 当前界面是通信联调页：地址、端口、连接/断开、消息发送、状态与日志显示。
- 后台线程处理网络；20 秒心跳；进入后台主动断开，返回后手动连接。
- 处理窗口边距，并声明、申请 Android 17 本地网络权限。
- 无 Google Play 服务、厂商 SDK 或原生 `.so` 依赖。
- 当前没有棋盘、翻棋规则、房间、匹配、账号、持久化、TLS 或断线恢复棋局。用户尚未指定这些业务细节，不要把基础工程描述成完整游戏。

## GitHub 与镜像

- `9025216`：首次提交，建立两端工程和发布流水线。
- `18fb25d`：Android 心跳调度、图标和备份规则修正；已推送。
- 工作流：`.github/workflows/publish.yml`，推送 main、v* 标签或手动触发发布；PR 只运行服务端测试。
- 目前没有 paths 过滤，所以客户端或文档变动推送 main 也会触发服务端流水线，但 Docker 构建上下文始终只有 `server/`。
- 流水线先 Maven verify，再发布 linux/amd64、linux/arm64 镜像到 GHCR，使用内置 GITHUB_TOKEN。
- 镜像：`ghcr.io/linhuig/chinese-chess-flipping:latest`，另有版本及 sha 标签。
- 已实际确认首次运行成功：https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36297517439 。
- 已通过 GHCR 匿名 token 和 manifest 请求确认 latest 可匿名读取，镜像索引包含 amd64、arm64。未在本机实际执行 docker pull/run（本轮 PATH 中未找到 Docker）。
- 后续提交触发的流水线应以 GitHub Actions 当前结果为准；不要把首次运行成功等同于所有后续运行成功。

## 已完成的验证

1. Java 21 执行 Maven verify 成功，4 项测试通过，覆盖拆包/粘包、中文、非法 JSON、未知类型、超长帧和参数校验。
2. 启动实际 JAR，以端口 19090、工作线程 2 验证配置生效；通过真实 TCP socket 收到 WELCOME、PONG 和中文 ECHO。测试进程已停止。
3. Android `assembleDebug lintDebug` 成功；Lint 为 0 errors、4 warnings（版本更新提示、文本国际化等非阻塞提示）。
4. 调试 APK：`client/app/build/outputs/apk/debug/app-debug.apk`；该构建产物被 Git 忽略，未上传源码仓库。
5. 尚未进行手机安装、模拟器交互或 iQOO/一加/小米真机验收，也未部署到用户的正式服务器。

## IDE 最后已知状态

- IDEA 已确认打开服务端，窗口标题为 `server – README.md`。
- Android Studio 已选择 `client/`，最后停在 “Trust and Open Project 'client'?” 对话框。已告知用户手动点击 Trust Project；未确认用户之后是否点击或同步完成。
- 此处停下是所用 computer-use 技能禁止代操作安全/隐私权限提示。新线程先核实当前状态，不要反复重新打开或假定仍停留在旧弹窗。

## 本机工具与构建经验

- IDEA：`D:\Program Files\JetBrains\IntelliJ IDEA 2025.2`，自带 JBR 21.0.7。
- Maven：上述目录的 `plugins\maven\lib\maven3\bin\mvn.cmd`。
- Android Studio：`D:\Program Files\Android\Android Studio`，自带 JBR 25。
- Android SDK：`C:\Users\linhui\AppData\Local\Android\Sdk`，已安装 SDK 37、Build Tools 36.0.0。
- `client/local.properties` 是本机配置，被 Git 忽略；Windows SDK 路径的冒号需转义，例 `sdk.dir=C\:/Users/linhui/AppData/Local/Android/Sdk`。
- 首次构建遇到 Java/Gradle 依赖下载连接重置或卡住。本机当时系统代理为 `127.0.0.1:7897`；代理值仅是当时环境，不应写入共享构建配置。
- PowerShell 传 Gradle JVM 参数必须加引号，例如 `'-Dhttps.proxyHost=127.0.0.1'` 和 `'-Dhttps.proxyPort=7897'`，否则可能被误解析成 Gradle 任务。
- Gradle 发行包已下载并校验 SHA-256，Wrapper 缓存已准备；若换电脑，Wrapper 会重新下载。
- Git push 已使用本机现有凭据成功。不在文档、提交或日志中保存 token；无需要求用户将凭据发到聊天。
- 交接文档开始编写时发现未跟踪文件 `client/gradle/gradle-daemon-jvm.properties`，可能由 IDE 新生成；本次仅记录，不修改、不随文档提交。后续应检查内容和用途，再决定是否纳入版本控制。

## 建议下一步（未自动授权新增业务开发）

1. 确认 Android Studio 已信任工程并同步成功，安装调试 APK 做两端联调。模拟器用 `10.0.2.2:9000`；真机用电脑或服务器实际地址。
2. 确认目标部署设备、网络和端口，在目标设备运行 Docker 镜像并验证手机连接。
3. 与用户明确翻棋规则、棋盘布局、人数、房间流程、胜负判断和断线处理，再开发游戏业务。
4. 后续按业务需求补充认证、TLS、数据存储和正式 APK 签名。

部署命令、协议及使用说明详见根目录 `README.md`。新线程开始时先检查 `git status`，保护用户或 IDE 新增的修改。
