# 服务器部署（Rust 0.6.0）

实际已发布版本和 Actions 结果见 ../PROJECT_STATUS.md。本轮由用户自行部署，不沿用历史部署操作授权。公开文档仅保留通用配置，不记录实际部署地址、登录账号、密码或管理入口。

0.6.0 使用不兼容旧版的协议 v2，服务端和两端客户端需一起升级。增加 60 秒恢复、昵称、P2P 候选和重试、App 更新；真实 Wi-Fi/5G 直连改善仍待验收。

## Actions 构建 App 和镜像

工作流保留三类任务：`build_apk_and_check（Build APK and run checks）→ publish（amd64 / arm64 矩阵）→ merge`，完整发布共四个执行实例。首个任务先判断是否发布，再按已验证缓存决定 APK/Rust 构建与检查，成功后交接 `app-update`。APK 是服务端启动及真实更新下载检查的输入，因此构建与检查共用一个 Runner，避免额外环境准备与附件往返。PR 使用 debug APK，不获取发布签名、不发布镜像。原内部 ID `test` 已改名，依赖与输出引用同步；若已有按旧显示名称匹配的分支保护，需同步检查名。

Actions 已改用原生声明 Node.js 24 的版本（包括 checkout、cache、Gradle、Node、artifact 与 Docker 系列）。这是 Action 自身运行时的升级，与 setup-node 为网页检查安装 Node.js 24 是两回事；不使用恢复旧 Node.js 的环境变量。背景见 [GitHub Node.js 20 弃用公告](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)。

仍保留内部 `git diff`：GitHub 在超过 1,000 个提交的推送或差异计算超时等情况下可能直接运行带路径过滤的工作流，因此不能把“工作流被 push 触发”等同于“确有发布范围改动”。参考 [路径差异计算说明](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons)。缓存优化不改变检出深度、发布判定或架构标签策略。

### 已验证产物复用（2026-09-30）

以下假设所需精确缓存存在且完整，工具环境未变化；首次运行、缓存丢失或校验失败会补建和补测。使用当前输入哈希，而非简单比较上一次提交，避免回退代码、切分支或恢复一个失败提交时错误复用。

| 当前输入变化 | APK 与客户端单元测试/lint | 检查用 Rust 编译/单元测试 | TCP/WS/更新下载互通 |
| --- | --- | --- | --- |
| 仅 Web 资源 | 复用并跳过 | 复用并跳过 | 已验证相同两端组合时跳过 |
| 仅 Android | 构建并检查 | 复用并跳过 | 运行 |
| 仅 Rust | 复用并跳过 | 构建并检查 | 运行 |
| Android 与 Rust 都变 | 构建并检查 | 构建并检查 | 运行 |

网页逻辑检查、APK 清单/哈希校验、启动当前服务并核对 HTTP 资源、发布镜像中的资源核对仍保留。只改 Web 不需要启动 JDK/Android/Gradle 设置步骤（互通缓存也有效时），但仍准备 Rust 工具链以核对其真实版本；若 stable 更新则 Rust 与互通缓存失效。镜像内 Rust 仍靠现有分架构 BuildKit 缓存复用，Docker 缓存丢失时需重编；检查用二进制不能替代 musl/arm64 镜像二进制。

- `checked-apk-v1-*`：保存成品 latest.apk 与 latest.json。输入包含整个 android_client、APK 打包脚本、工作流、Runner 镜像版本/架构、debug 或 release 变体、缓存代次。构建配置和客户端测试改动也失效；复用前再次校验版本、大小、包名清单及 SHA-256。
- `checked-rust-v1-*`：保存检查用 chess-server 与 SHA-256 校验文件。输入包含 Rust 源码、Cargo 配置/锁文件、build.rs、Cargo/工具链配置、工作流、Runner 镜像版本/架构、实际 rustc/Cargo 版本和缓存代次；Web/APK 资源不计入 Rust 源码输入。
- `checked-interop-v1-*`：保存上面两组输入组合的通过标记。任一端或其构建/测试输入改变、任一成品需要重建、组合标记缺失/不匹配，都执行互通。Gradle 的 interop 任务禁用自身的 UP-TO-DATE 与构建缓存，防止外部服务端变化却复用 Java 测试结果。
- 三种缓存只在本次所有必需检查与 Web 检查成功后保存。仅 `cache-hit == 'true'` 且内容校验成功才可跳过，前缀命中不能当成已验证。Gradle/Cargo 依赖与中间编译缓存继续作为冷构建加速；[restore/save 分离](https://github.com/actions/cache) 用于控制保存时机。
- 仓库 Actions **Variables** 可设置 `CI_CACHE_EPOCH`（默认 `1`）。更换 APK 签名或需要强制重新验证时递增它；签名私钥/密码不进缓存，也不写入缓存键。签名 Secrets 本身不参与输入哈希，所以轮换签名必须同时更新该代次。依赖获取策略等未体现在输入文件中的环境调整也应更新代次。
- GitHub 缓存不可原地覆盖；精确条目若损坏，本次会补建，但不覆盖原坏条目。删除对应 Actions 缓存或递增代次，后续才能重新保存。缓存可能被清理，不承诺永远不编译。

普通 main 推送在路径过滤正常执行时，无 server/（含 Web）、android_client/ 或 APK 打包脚本变化不启动本流程；即使路径过滤放行，内部 diff 确认无相关改动后也会令 should_check=false，跳过后续环境准备、缓存读写、构建、检查及发布，仅完成检出和范围判定。PR 仍检查，手动触发仍强制发布。编译缓存全部命中不等于跳过镜像发布：Web 内容变化仍需复制到新镜像，按原方式推送、校验并合并。

发布流程：固定签名的 `assembleRelease` → 生成 APK 版本清单 → Rust 检查与编译 → APK 作为 Actions 的 app-update 附件传给两个独立镜像任务。amd64 使用 ubuntu-24.04，arm64 使用原生 ubuntu-24.04-arm，移除 QEMU；各自先按 digest 上传镜像、启动并校验资源，通过后才发布 latest-amd64 / latest-arm64 和架构 sha 标签，互不等待。某一架构验证失败时，其正式标签保持不变，也不取消另一架构。两者均成功后按本次 digest 合并通用 latest / sha-*，不重复构建。按 digest 上传使用 [Docker image exporter](https://docs.docker.com/build/exporters/image-registry/)，验证后通过 [imagetools create](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/) 更新标签。网页、APK 和清单作为独立资源层放入镜像，不再编译进 Rust 程序，不需另配下载目录，也不把二进制包提交到仓库。启动时从 CHESS_RESOURCE_DIR（镜像固定 /app，本地默认 server/）读取一次并校验 APK，随后共享内存快照；缺少资源或 APK 校验失败时启动失败。更新继续使用原来的拉镜像、重建容器流程。原生机器见 [GitHub runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

amd64 服务器希望提前更新时，在 .env 中设置 `SERVER_IMAGE=ghcr.io/linhuig/chinese-chess-flipping:latest-amd64`；通用 latest 保持兼容，仍等待两个架构。latest-amd64 / latest-arm64 已实际发布；本次资源更新总耗时 4 分 15 秒，详见 PROJECT_STATUS.md。

Docker 编译阶段只复制 Cargo.toml、Cargo.lock 和 src/*.rs；网页、APK 在最终镜像阶段复制。Actions 按架构保存 BuildKit 缓存，仅改资源且缓存命中时跳过 Rust 编译；首次发布、缓存被清理或 Rust 基础镜像变化仍需编译。检查任务另保存 Cargo 和 Gradle 构建缓存，减少冷构建开销；已验证的输入组合可以复用检查结果，具体边界见上表，耗时以实际 Actions 记录为准。

仓库 Actions Secrets 使用以下四项：

| 名称 | 内容 |
| --- | --- |
| APK_KEYSTORE_B64 | 原有签名 keystore 的 Base64 内容 |
| APK_STORE_PASSWORD | keystore 密码 |
| APK_KEY_ALIAS | 原签名别名 |
| APK_KEY_PASSWORD | 原签名私钥密码 |

发布时缺少任何一项即报错；PR 检查使用临时 debug 签名，不获得发布密钥。构建后临时 keystore 删除，私钥不进入仓库、附件或镜像。保留原签名才能覆盖已经安装的版本，不能每次 Actions 都生成新密钥。参考 [Android 签名说明](https://developer.android.com/studio/publish/app-signing) 与 [GitHub Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

每次 App 发布递增 `android_client/app/build.gradle.kts` 的 versionCode，并修改 versionName。检查更新比较 versionCode；更改服务器程序但没有 App 新版本时不会重复下载。首次从 0.5.x 升级需手动安装 app-update 附件中的 APK，此后可在 App 内更新。下载后校验包名、版本、SHA-256 和签名，安装需 Android 系统确认；在设置中可关闭自动检查。

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

TCP 与 UDP 可以使用相同的数字端口，它们是两种独立协议。只开放 TCP 8888 不会开放 UDP 8888。UDP 不可达时客户端自动继续中转，不影响普通联机。当前登记监听 IPv4；客户端可经控制连接交换全局 IPv6 候选，不要求服务器有 IPv6。两种路径均不可用时继续中转。

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
- 直连期间服务器连接仍必须保持；网络断开保留至最后心跳后 60 秒，倒计时继续。
- 可使用上一版 sha-* 镜像标签回退。0.6.0 协议 v2 与 0.5.x 不兼容，回退或升级须同时处理服务端和客户端。
- main 推送中的 Android、server/ 或 APK 打包脚本变化触发镜像发布；仅改工作流或仓库文档不会触发推送构建。PR 仍执行检查，手动触发仍可发布。
- 服务端只使用 Cargo 构建，生产启动程序为 /app/chess-server。
