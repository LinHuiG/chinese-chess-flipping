# 项目执行记录与交接

更新时间：2026-09-28（Asia/Shanghai）。新线程先阅读本文和 README.md，再检查 git status；当前代码、测试和远端状态优先于历史记录。

## 0.5.0 Rust / Android UDP P2P / 心跳延迟（2026-09-28，已推送，发布中）

- 用户已授权实施，方案见 docs/RUST_P2P_PLAN.md。Rust 生产服务包含 TCP、HTTP/WS 和 UDP 登记协助，兼容现有 TCP；Java 保留作迁移参考和验证夹具，不进入镜像。
- 安卓双方开局后尝试 UDP 直连，房主分发随机主密钥，方向独立 AES-GCM、64 包防重放窗口、操作去重和有限重试；普通 HTTP/WS 也允许密钥分发。失败中转，服务器心跳和断线判负继续保留。
- 安卓与 Web 增加服务器 RTT；安卓直连成功才显示 UDP RTT，失败隐藏。状态胶囊沿用 iOS 风格，仅更新网络文字。网络接收复用解析对象，网页和 WS 请求避免重复序列化，Rust 广播共用已编码字节。
- Rust release 编译通过；Android assembleDebug / lintDebug 通过（0 errors、9 warnings）。首次集中 Maven 64 项中 63 项通过，修正防重放测试对重复包丢弃行为的错误预期后，定向 UdpSessionTest / RustInteropTest 6 项全通过；最新报告合计 64 项、0 失败/错误/跳过，未为计数重复全量执行。
- Actions Linux 独立完整验证已通过：64 项，0 失败/错误/跳过，2026-09-28 21:15（北京时间）完成测试 job；Rust release 构建通过。镜像发布结果待下方更新。
- Rust 与实际 Android TCP/WS 混合房间、心跳、同 DID 替换、普通 WS 下 UDP 密钥分发和加密直连、确认超时回退及退房判负的 4 项黑盒检查首次均通过。桌面 JVM 联调不等同真机验证。
- 两台 API 37 模拟器在普通 HTTP 连接下建立直连，双方翻棋；仅阻断客人 App 的 UDP 后均回退中转、隐藏 UDP RTT，继续走子和退出判负成功。临时规则已移除，原服务器设置已恢复，两个本轮模拟器和临时 Rust 服务已停止；原本机 80/8888 服务未动。
- 实际 Rust + 双浏览器的建房/准备/四步翻棋/同步/离开/解散及桌面、手机横竖屏检查通过，服务器 RTT 可见；既有 web-review-smoke 呈现与消息边界检查通过。截图见 docs/VERIFICATION.md。
- Windows 同机、2 工作线程、102 个 TCP 心跳连接、15.01 秒轻载采样：Rust 工作集 8.42 MiB，Java 125.21 MiB，约减少 93.3%；私有内存 2.62 / 116.41 MiB。CPU 太低，无法据此给出吞吐提升倍数；并非 Linux 或容量结果。Linux 镜像体积待真实发布后核对。
- 复核后补正直连时房主无效操作的提示归属：只通知房主，不把错误发给客人；UDP 消息 ID 复用一次 UUID 生成结果；重新 assembleDebug / lintDebug 通过。该项只改客户端，不影响正在发布的 Rust 镜像，也未重复整套联机检查。
- 最新 APK：android_client/build/deliverables/chinese-chess-flipping-0.5.0-debug.apk，1647415 字节，versionCode 5，v2 调试签名校验通过；SHA-256：E4A45964BD32B7B638AF10595BD8191AF874F724454569EF727FA479C367A098。先前 1647390 字节版本已被替换。
- 业务提交 43534f3005719ace285156471293a58fbc4ff156 已推送 origin/main；[Actions 36427114170](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36427114170) 正在执行检查与镜像发布，完成后补记真实结果。未远程部署。公网 NAT、实际 Android 厂商设备、HTTPS/WSS 和长期后台不在本次验证结果内。保留原未跟踪 android_client/gradle/gradle-daemon-jvm.properties。

## 0.4.0 提交与镜像发布（2026-09-27，成功）

- 业务提交 61a32a5e98a87a94f5ea1098172f355cdae29464 已推送 origin/main，包含 HTTP/WS、响应式网页、安卓目录迁移和三种传输设置、网页走子与最后吃子动画、检查中发现的问题修复及资源优化。
- [Actions 36318713210](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36318713210) 的 test / publish 均成功，2026-09-27 20:26:12（北京时间）发布完成。匿名核实 latest 与 sha-61a32a5 同指向 `sha256:9b35c381efce43638194e65786ef46271ebcd74ae4b711e514bf059910cca574`，OCI 清单包含 linux/amd64、linux/arm64。
- 提交后核对发现 Windows 目录迁移把 android_client/gradlew 执行位变成 100644，已恢复为 100755，与本次结果归档一并后续提交。仅涉及执行位与文档，不改变已发布服务端源码；使用 [skip ci] 避免相同服务端重复检查。
- 本地检查结果和 APK 校验见下一节；未远程部署、未更换证书。用户需更新端口映射并自行拉取新镜像，见 docs/DEPLOYMENT.md。本地旧服务仍未重启，网页新资源以已发布镜像或新 JAR 为准。
- 仅保留来源已说明的 android_client/gradle/gradle-daemon-jvm.properties 未跟踪；不提交 SDK 路径、缓存、签名或 APK。以下“尚未提交/发布”的条目均是历史阶段。

## 0.4.0 发布前检查与修复（2026-09-27）

- 用户明确要求再次检查 bug/性能，完成后 commit 并 push。本次提交包含此前完整 0.4.0、网页走子动画、以下修复和记录；本机 Gradle JVM 配置继续保留不入库，不远程部署。
- 修复网页最后一次吃子后 ROOM / 等待 STATE 立即截断动画：房间逻辑即时更新，仅保留最终棋面最多 300 ms，随后进入等待并结算。补齐结束/后台/关闭动画时的清理。
- 合并 STATE 的重复 render，并缓存未变化的棋盘呈现；确认消息不再重写 32 格及阵亡统计。浏览器心跳检查不再每秒复制 pending 数组；服务端 WS 复用标识正则，输出直接使用序列化字节，去掉字节→字符串→字节的重复编码。不宣称未经测量的 CPU/内存降幅。
- 补紧 WEB 的 JSON body 对象验证与发送失败返回值，Android WS 的 CODE 改为数值精确比较，避免小数错误码被截断为 0。
- 最终本地 Maven verify：57 项通过，0 失败/错误/跳过；Android assembleDebug lintDebug 通过，0 errors、9 warnings。scripts/web-review-smoke.cjs 定向检查消息格式、失败发送、移动帧、吃子、重复快照、减少动态效果、无变化确认不写棋盘、最终吃子与结算清理，全部通过。未重复真机/公网/容量检查。
- 最新交付 APK 已替换为修复后的 0.4.0，1622147 字节；SHA-256：132804776234C9F57CB4B7222C338BCE3273ED7568230D020F8AFD4EBAEFB24E。此前同路径文件的大小/hash 属于历史构建。
- 检查完成后已提交推送，Actions 结果见上方发布节。先前被拦截的本地 80 端口服务未重启；它仍运行旧资源，不能用它判断最新修复是否生效。

## 网页走子过渡补充（2026-09-27）

- 用户反馈走子没有过渡；原实现仅在目标格缩放。改为 Web Animations 按实际格子坐标从起点平移至终点，普通走子 220 ms、吃子 280 ms，翻棋 210 ms；被吃棋子短暂淡出，暗棋被吃时使用本次已公开身份。
- 只对经棋面差分确认的连续一步播放；首次/跳步/重复同步不重播。动画结束、退出房间、切后台、窗口变化和关闭动画时清理，遵守系统减少动态效果设置；无常驻逐帧计时器。
- Edge/Chromium 隔离棋面定向检查通过：起点位置一致、途中位置、到达落点、吃子淡出、重复状态、动画开关、减少动态效果及结束清理。检查的是呈现层，没有重复全量规则/联机测试；JS 语法检查与跳过测试的 Maven package 成功。
- 本地 80 端口仍为旧资源，最后观察到一个等待房间、没有进行中的对局。更新服务的停止/重启命令被自动审批拒绝（仅返回 blocked by policy），未执行重启；已询问用户是否允许清空等待房间后更新。代码和记录暂存，未提交或推送，无远端部署变动。

## 0.4.0 HTTP / WebSocket、网页版与安卓目录迁移（2026-09-27，本地完成）

- 用户本轮要求 CHL 接受 ANDROID/IOS/WEB，保留 TCP 8888，新增 HTTP 80 与 /ws，提供手机和电脑布局的网页版；client/ 改名 android_client/，安卓支持 HTTP/HTTPS 与可选 TCP，界面沿用苹果风格。
- 已实现双入口、共用 RoomHub、网页资源打包、浏览器规则和房主逻辑、安卓 OkHttp WebSocket 传输及设置。保留原房主裁判和断线判负规则；未操作远端服务器或证书。
- 服务端集中 Maven verify 56 项通过；随后将实际 Android WsClient 纳入双向 TCP/WS 房主混合联调，定向 2 组通过，没有再重复全量检查。最终跳过重复测试的 package 成功。网页三个模块语法检查通过。
- Android 最终 assembleDebug lintDebug 成功，0 errors、9 warnings；设置页固定控件 ID 导致的 lint 错误已改为 View.generateViewId。API 37 模拟器安装成功，原 TCP 与新 HTTP 均实际连接成功，HTTP/HTTPS 切换会按模式更新标准端口，保留自定义端口。
- Chromium 双浏览器通过建房、加入、准备、无限时设置、四步轮流翻棋、双方棋面一致、退出判负与解散；桌面 1440×1050、手机 390×844、横屏 844×390 截图已检查。真实 Android HTTP 房主与浏览器客人也完成各翻一子、颜色分配、退出判负和解散。截图与边界见 docs/VERIFICATION.md。
- 交付 android_client/build/deliverables/chinese-chess-flipping-0.4.0-debug.apk，1622112 字节，versionCode 4，调试签名 v2 校验通过；SHA-256：12229F57171433F4745B12733D30C646F7E5D5CF9AAAE8DA401F39F64C63ACD6。新增 OkHttp 依赖与 Apache 许可随 APK 打包。
- 源码与本机配置迁到 android_client/，旧 client/build/ 尚有模拟器占用的两个日志文件，暂保留；原未跟踪 Gradle JVM 配置继续不入库。
- 先前停止占用 JAR 的旧本地服务后已恢复新版：PID 33644，TCP 8888、HTTP 80、工作线程 2、最大堆 128 MiB。运行副本为 server/target/web-session/server-check.jar，日志在同目录，避免后续 Maven 打包锁定主产物；PID 下次使用前需重新核实。模拟器恢复原 TCP 192.168.0.108:8888 设置，保留新版 App 和本地服务供体验。本轮未新增 HTTP 防火墙规则。
- 未验证公网 HTTPS/WSS 证书链、iOS Safari 真机、其他安卓厂商设备、浏览器长时间后台或新 Docker 配置。CHL 接受 IOS 不表示已开发原生 iOS App。文档含反代示例及 HTTP 端口映射说明。
- 本阶段代码、文档与截图已暂存，尚未提交、推送或触发 Actions；此前业务镜像仍为 0.3.0 归档版本。未操作远端部署，详见 docs/DEPLOYMENT.md。下文旧路径 client/ 与默认 TCP 描述均是历史记录。

## 按服务端变更发布镜像（2026-09-27）

- 用户要求避免仅修改 App 却重新打包服务端镜像。工作流保留 main/PR 自动测试，发布 job 改为仅 main 整次推送前后 server/ 有差异时执行；包含该目录下源码、依赖、Dockerfile 与配置。读取 push.before 到当前 SHA 的净差异，不只检查最后一个提交；比较失败会让检查失败，不静默跳过。
- 客户端、文档、工作流单独修改只测试，不发布；PR 不发布。取消单独推送 v* 标签的自动发布，保留 workflow_dispatch 手动重建入口。GitHub 的 push 路径过滤不适用于标签，不能简单添加 paths 后继续让标签无条件发布。
- 工作流及记录提交 bc57a9cc8bb171774a8396f70fcfc1b59a35fdb6 已推送。用历史 Git 差异核对：服务端变更会选中发布，纯文档变更不会；本次未重复运行本地业务测试。
- [Actions 36313801610](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36313801610) 于 2026-09-27 18:50:40（北京时间）完成：test=success，publish=skipped。实际验证本次无 server/ 变更不重建镜像；手动发布和新分支首次推送的分支逻辑未额外触发验收。
- 验证结果以纯文档提交 [skip ci] 推送，避免为归档重复运行测试。可拉取的最新业务镜像仍对应 b47535f；本机 client/gradle/gradle-daemon-jvm.properties 继续保留，不提交。

## 0.3.0 提交与发布（2026-09-27，成功）

- 用户已明确授权将本轮修改提交并推送 GitHub；一并推送之前仅本地提交的 APK 交付记录 4141f3d。不修改远端部署，用户自行更新服务器。
- 提交范围为 0.3.0 客户端界面、图标、短动画与音效、低开销刷新/计时、服务端快照同步与大小校验修复，以及测试和项目记录。本机 Gradle 配置、SDK 路径、缓存、APK 与密钥不入库。
- 业务提交 b47535fe2a0e6f24e81b9c372342cbdab979a86a 已推送 origin/main，之前本地提交 4141f3d 一并推送。本次复用下面已完成的本地检查，没有重复运行本地全量测试。
- [Actions 36313268361](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36313268361) 的 test/publish 均成功，2026-09-27 18:44:50（北京时间）完成。匿名核实 GHCR latest 与 sha-b47535f 指向同一摘要 sha256:32378fc8281a443e023bc0deb723c52bafb8b1f0d0d8a7f4a1d0f39f7def967e，包含 linux/amd64 与 linux/arm64。
- 未连接、拉取或修改用户服务器；用户自行部署。客户端 APK 不在服务端镜像内，仍使用此前已交付的 0.3.0 调试 APK。后续工作流/文档改动不改变此次镜像对应的业务源码版本。

## 0.3.0 界面与低开销反馈优化（2026-09-27，本地完成）

- 用户体验后确认功能无明显问题，要求检查 bug/性能、参考 iOS 调整界面、增加吃子与胜负动画/音效，并重做图标；保持手机资源开销较低。通用知识讲解仅留在聊天，本节只记录项目实施与验证。
- 已调整原生 Android 浅灰白分组界面、蓝色主操作、分段计时选择、棋盘及红黑阵亡栏，增加设置中的音效/动画开关。重做红黑双棋子自适应矢量图标，通知使用透明底单色图标；工具按钮采用两枚 Lucide 矢量，许可随 APK 打包。
- 使用 210/260 ms 的按需棋盘动画与 260 ms 结算过渡，尊重系统动画开关；首次快照、重复同步、跳跃快照和恢复前台不追播吃子动画。音效为离线生成的三段原创 PCM，合计 58784 字节，通过 SoundPool 最多两路播放，后台释放；没有动画库或持续粒子/模糊效果。
- 修复服务端严格连续业务 seq 导致超时回复后无法同步的问题，改为完整快照严格递增，保留版本/gameId 与防重放检查；补齐 START 状态体大小校验。加密 Nonce 连续性未改。客户端等待页复用控件，棋盘复用绘图对象，显示倒计时仅有限时对局按秒更新，房主超时改按真实剩余时间预约；房间列表完成后清理临时缓存。
- 已完成 Maven test：49 项通过，0 失败/错误/跳过；随后跳过重复测试的 package 成功。Android 主包与测试包构建、lintDebug 已通过，0 errors、7 warnings；早期检查的测试代码 JSON 异常声明和样式 API/常量问题已修复。单模拟器竖屏 UI 隔离夹具 10 项检查通过，后续横屏增加音效加载检查共 11 项通过。检查涵盖等待控件复用、吃子动效、完成停止、重复/恢复不追播、动画开关、胜负弹层及三段音效加载；夹具不是实际联机对局测试。
- 1080×2280 竖屏与 2280×1080 横屏画面已检查，系统桌面显示新图标。无限时静止棋盘约 3 秒采样前后渲染帧数均为 132，top 两次显示 CPU 0.0%，PSS 68041 KiB；仅是调试包、软件 GPU 模拟器短测，不代表真机功耗或帧率。累计 UI 采样有 24/132 janky frames，包含页面切换/截图/动效，不能据此承诺真机流畅度。实机听感、长时间耗电和厂商后台策略尚未验收。详细边界见 docs/VERIFICATION.md。
- 交付包：client/build/deliverables/chinese-chess-flipping-0.3.0-debug.apk，1051580 字节，versionCode 3，调试签名校验通过；SHA-256 为 3506F77F0AC5EF4EEB74744A9FBFA7CA5BFD20275B3A8D644B651038EA660BB1。比 0.2.0 增加 86293 字节；没有正式发行密钥。
- 18:20 已在确认无玩家连接后替换本地 JAR 并重启，PID 31328，仍为 192.168.0.108:8888、2 个线程、最大堆 128 MiB。新版 App 实际加密握手并进入空大厅成功。日志为 server/target/lan-session/20260927-182001.*.log；Maven 服务端版本号仍为 0.2.0，以当前源码和重建 JAR 为准。保留一个模拟器和本地服务供用户操作。
- 后续模拟器设置被改为 hgame.tudoucoding.tech:443，观察到握手失败；未覆盖用户设置，也未操作远端服务。已在聊天说明 8888 是原始二进制 TCP、无 HTTP path，curl GET 的 Empty reply 不能作为游戏协议健康检查；通知是低优先级前台服务通知，暂未移除后台服务。
- 上述本地验收完成时业务改动尚未提交或推送，未触发 Actions；后续提交/发布状态以上方最新记录为准。本机 Gradle 配置保留不入库，项目文档、设计资产与截图已暂存，暂存不代表提交或发布。

## 本地局域网体验服务（2026-09-27 17:37）

- 用户要求启动本地服务并放行端口，供手机实际体验。使用现有已验证 JAR，在后台启动 Java 21 服务，TCP 8888、2 个工作线程、最大堆 128 MiB；本次启动 PID 为 28636，不配置开机自启。
- 本次局域网地址为 `192.168.0.108:8888`；已确认进程存活、端口监听及本机通过该地址的 TCP 连接成功。手机跨设备连接尚待用户验证，不能将本机连接成功视为真机联网验收。
- 用户确认管理员权限后，新增 Windows 防火墙规则 `ChessFlipping-LAN-TCP-8888`，已核实启用且状态正常。仅允许以太网接口上来自 `192.168.0.0/24` 的入站 TCP 8888，限定本机地址和此次 Java 程序；适用于 Public/Private 配置，不关闭防火墙、不修改网络类别或其他端口规则。
- 日志保存在忽略目录 `server/target/lan-session/`。按用户体验需求保留服务运行；停止服务会清空房间，后续打包前应注意 Windows JAR 文件锁。地址、PID 为本次启动记录，下次使用前需重新核实。
- 本轮没有修改业务代码、构建 APK 或镜像，没有提交、推送或操作远端服务器；仅暂存项目运行记录。

## APK 交付（2026-09-27）

- 用户要求提供 APK。本轮没有修改业务源码，没有重新发布镜像或操作远端服务器；用户要求仅本地提交，不推送。
- 再次执行 Android `:app:assembleDebug` 成功，33 项任务均为 up-to-date，复用已验证构建产物，没有重新运行功能回归。交付副本位于 `client/build/deliverables/chinese-chess-flipping-0.2.0-debug.apk`，965287 字节，0.2.0/versionCode 2，调试签名；apksigner 校验通过。
- 交付 APK 的 SHA-256 为 `04DBB9E80A6826B576F6030C424FC77744A68AF7B54C2A2A0E16C0C140777028`，与上一阶段 APK 一致。APK 位于忽略的构建目录，不加入源码仓库；未创建发行签名密钥或上传 GitHub Release。
- 再次通过 GitHub API 核对 Actions 36308099105 为 completed/success，对应源码 5a165bf；未查询或变更服务器运行状态。此前的模拟器验收边界保持不变，本轮未做真机验收。

## 最新阶段：完整功能已推送，Actions 镜像发布成功（2026-09-27）

- 本阶段用户已明确授权开发、统一测试、提交并推送 GitHub，通过 Actions 发布镜像。用户自行在服务器拉取和部署；助手不操作远端服务器。已有未提交的加密通信源码已与本轮业务实现一并纳入发布范围。
- 完成无账号双人房间、准备/计时设置、房主转移、断线清理、前台自动重连、后台连接服务，以及全部已确认棋局规则、判重、正常胜负和退出判负。服务端保留最小会话/房间信息，房主 App 裁判，不在服务端保存棋盘或战绩。
- Android 0.2.0：默认 hgame.tudoucoding.tech:8888，可编辑域名/IP 和端口；大厅/等待/游戏右上角规则入口；左红右黑阵亡栏，按将士象车马炮兵排列，灰显、点亮及数字角标；竖屏和横屏均已检查，横屏保留竖向 4×8 棋盘。
- 最终本地 Maven 测试 42 项通过，0 失败/错误/跳过。该次 verify 在测试后因 Windows 正运行的 JAR 文件锁导致 repackage 失败；停止本地进程后，-DskipTests package 成功。随后本次 Actions 的完整 Maven verify 已成功；保留本地失败说明，不把它记成完全成功。
- 最终 Android assembleDebug lintDebug 成功，0 errors、7 warnings。调试 APK 位于 client/app/build/outputs/apk/debug/app-debug.apk；没有创建正式签名密钥。
- 安装 Android 17/API 37 模拟器镜像，创建 ChessFlip37、ChessFlip37Guest 两台设备，连接本地 TCP 18888。验证创建/加入/准备/计时选择、开局/翻棋/吃子/阵亡计数、规则页、横竖屏、实际 30 秒超时、退出判负、解散、服务重启后重连回大厅。房主后台并锁屏约 2 分钟期间仍可处理另一端操作。
- 资源优化：小型 Netty 堆缓冲池、有限输出和请求队列、按到期时间检查心跳、房间列表游标分页、房间内索引清理、状态变化才同步。Windows 本地 102 个心跳连接的 15 秒采样：工作集约 124.4 MiB、私有内存 115.0 MiB、CPU 为单核的 0.31%。这是轻负载短测，不代表 Linux 容器开销、容量上限或相对旧版的节省比例。
- 完整结果与截图：[验证记录](docs/VERIFICATION.md)。服务器配置：[部署说明](docs/DEPLOYMENT.md)。操作顺序和实现选择：[实施记录](docs/IMPLEMENTATION_PLAN.md)。
- 代码提交 5a165bf0f43b41c90fc818a5cb437ca5f240378d 已推送 origin/main。[Actions 36308099105](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36308099105) 的 test 和 publish 均成功，2026-09-27 17:06（北京时间）完成。镜像 ghcr.io/linhuig/chinese-chess-flipping:latest 与 :sha-5a165bf 指向同一摘要 sha256:82b97016a0fa80912ade6b676fa8f132b2e235df3291cf247162c2219b674c94，已匿名核实清单包含 linux/amd64、linux/arm64。
- 发布结果归档作为后续纯文档提交，使用 [skip ci] 避免相同业务代码重复构建；镜像源代码对应上述 5a165bf。未操作用户服务器。验收后的两台模拟器和本地测试服务均已关闭，APK、虚拟设备配置与截图保留。
- 未验证：真实手机及厂商后台策略、全部 Android 版本、长时间休眠/弱网、公网实服部署和大规模容量。无本地 Docker，镜像构建在 Actions 成功，不等于已在用户服务器拉取运行。
- 下面保留历史记录，其中“尚未开发”“未提交”“20 秒心跳”等描述仅对应当时阶段；当前事实以上述最新阶段、实际代码和远端运行结果为准。本机生成的 client/gradle/gradle-daemon-jvm.properties 保持原样，不提交。

## 历史阶段：文档归档单独提交（2026-09-27）

- 用户已要求将刚才暂存的 8 份方案和文档提交并推送到 origin/main。本次提交仅包含文档、规则归档和协作要求；已有未暂存的通信源码、测试代码和本机配置不在本次提交范围内。
- 文档中二进制加密通信的实现与验证记录对应本地工作区。相关代码尚未纳入本次提交，其他线程仅检出远端文档提交时不能据此认为源码或镜像已经升级；以实际代码和 Git 记录为准。三份 README 和协议文档已补充这一范围说明。
- 提交前已确认本地 main 与 origin/main 一致，并检查暂存文件和文档差异；未运行本地构建或测试。推送会按现有配置自动触发 GitHub Actions，构建的是远端已提交源码，不包含本地未提交通信改动。提交和推送结果以 Git 记录为准，不将流水线触发当作发布成功。
- 下文各归档阶段的“未提交、未推送”是当时的历史记录；当前文档与代码的提交范围按本节和下方“GitHub 与发布状态”理解。

## 文档统一暂存与 agent 归档要求（2026-09-27）

- 用户要求将本地全部方案、文档和设计加入 Git 暂存区，并明确：**agent 存档也必须 `git add`，即使是临时文件或草稿。** 此要求已写入根目录 AGENTS.md，后续线程创建或更新归档时必须遵循，并检查正文与接续入口均已暂存。
- 本次归档类文件共 8 份：AGENTS.md、PROJECT_STATUS.md、根目录 README.md、client/README.md、server/README.md，以及 docs/ 下的 PROTOCOL.md、ROOM_MANAGEMENT_PLAN.md、GAME_RULES.md，统一加入暂存区。
- 已检查仓库文件清单（包含被忽略文件的非构建目录），没有发现其他待纳入的方案、设计或 agent 临时存档。已有业务代码修改和本机文件保留原状态；本次仅更新协作记录并暂存文档。
- 本次仅检查文件清单和暂存状态，未运行构建或测试，没有提交、推送或发布。暂存不代表已提交，也不代表方案已实现。

## 棋局规则已确认并归档（2026-09-27）

- 用户要求将本线程讨论确认的游戏方案归档，供其他线程接续。完整入口：[翻棋游戏规则与棋局方案](docs/GAME_RULES.md)。本轮仅修改文档，尚未实现棋局业务。
- 已确认：竖向 4 列 8 行、32 枚随机暗棋、随机先手、第一次翻棋定色并消耗首回合；所有棋子的普通和特殊吃法已明确，不能套用其他翻棋规则。普通同类互吃仅将帅允许，车/马/炮特殊吃法可以吃对方同类及任意暗棋；被吃暗棋公开身份。
- 已确认：某方全部棋子（含暗棋）被吃光立即判负；无暗棋且没有合法行动时判负；将帅被吃本身不结束对局。退出、断线及房主解散仍沿用房间方案。
- 已确认：禁止出现历史相同棋面，只比较固定格子的状态，不考虑行动方，同色同类不区分个体。房主 App 在内存判重；每次吃子或翻棋后清空旧历史并记录当前棋面。所有走法都因重复被禁止且无暗棋时，当前方判负，不设和棋。
- 已确认：房主开局前选择每步 30 秒、60 秒、90 秒或无限，对双方一致，超时直接判负。默认选项和同步实现未指定，不将实现建议当作用户已定参数。
- 已更新根目录 README、AGENTS 和房间方案中的接续入口，修正“棋局规则尚未定义”的旧说明。房间和棋局均待开发；本轮归档不表示已开始开发。
- 本轮仅核对文档内容、链接及本地变更；未运行构建、自动测试、真机、联机或 Docker 验证。原有代码修改保留，没有启用 dsh，没有提交、推送或发布。

## 上次代码变更：TCP 固定标识（2026-09-27）

- 按用户要求，在所有报文最前面增加两个固定字节 0xFC 0xFC，固定包头由 19 字节变为 21 字节；TOTAL 包含前缀，长度字段偏移为 2，CRC32 偏移为 17。
- 两端编码、解码、流读取、Netty 分帧及 AES-GCM AAD 同步更新；固定标识纳入 CRC/AAD，标识错误按协议错误关闭连接。两端三份共享协议源码已核对完全一致。
- 已同步协议文档、三份 README 和既有测试中的字段偏移。与此前无前缀的二进制协议不兼容，部署时必须同时更新两端。
- 最小检查通过：服务端 Maven -DskipTests test-compile、Android :app:compileDebugJavaWithJavac、git diff --check。未运行测试用例、完整回归、真机或 Docker 验证；历史测试通过记录不代表本次修改已全面验证。未提交、推送或发布。

## 用户最新执行偏好（后续线程必须遵循）

- 2026-09-27 用户明确要求：方案、文档、设计、交接记录和 **agent 存档（包括临时文件、草稿）创建或更新后必须 `git add`**；归档正文和入口一起暂存。协作要求见根目录 AGENTS.md；不擅自提交或推送。
- 2026-09-27 用户明确要求：**不要过度测试，等整个项目功能完成后，再统一进行修复和测试。**
- 开发阶段优先完成功能，仅做必要的最小编译检查、处理阻塞开发的明显问题；不主动新增大量测试、扩展验证范围或反复回归，不提前开展全面修复。
- 持续记录已实现、已检查和未验证项；“编译通过”不等于已通过真机或全面验收。系统测试和非阻塞问题统一留到项目功能完成后处理。
- 本轮通信任务已编写并运行的测试保留；收到此指示后不再追加测试，已经运行中的 Maven 检查只收取结果。
- 此偏好也已写入根目录 AGENTS.md，供新线程直接读取。

## 房间阶段记录：业务方案已归档，尚未开发

- 2026-09-27 用户要求先讨论房间业务，再归档给其他线程接续。本阶段仅修改文档，没有开始业务编码。
- **接续入口：[房间管理、连接清理与自动重连方案](docs/ROOM_MANAGEMENT_PLAN.md)。** 其中区分已确认规则、实现建议和实际代码差异；棋局规则已在本日后续讨论中确认，另见 [棋局方案](docs/GAME_RULES.md)。根目录 README 和 AGENTS.md 均已加入入口。
- 已确认：无账号，每 App 一个连接；每 5 秒心跳，服务端 30 秒未收到有效心跳就关闭；任一端关闭都由服务端统一清理并退出房间；离线不保留用户或战绩。
- 已确认：前台断线后间隔 3 秒重连，间隔不包含连接/握手耗时；重连成功回房间列表；同 App 新连接握手成功后立即替换并清理旧连接；切后台/锁屏不主动退出，实际断线才退出。
- 已确认：每房最多两人、名称去空白后 1～32 字符且可重名、列表显示 `#ID 房间名`、等待且未满才能加入、成员变化全部取消准备、满员且全准备才开局、房主按加入顺序转移、空房删除。
- 已确认：服务端保存最小成员和房间状态并处理进出与断线，房主客户端维护详细状态；游戏中退出判负，游戏中房主解散先按房主认输；结束后留房成员回到未准备的等待状态。
- 房间归档时尚未定义的具体翻棋规则，现已在 [棋局方案](docs/GAME_RULES.md) 中确认并归档，无需重复确认；后续按用户开发指令确定实施范围，不自行补全其他规则或将占位流程当成完整游戏。
- 当前源码仍为 20 秒心跳、90 秒读空闲关闭、后台主动断开、手动重连，尚无房间业务。下文通信实现和测试结果属于上一阶段，不能视为新方案已实现。
- 本次仅核对文档、代码、既有报告及本地 Git 状态，检查归档内容和链接；未运行构建/测试，未真机验证，未查询远端发布状态。保留原有工作区修改，没有启用 dsh，没有提交、推送或发布。

## 上一阶段：二进制加密通信本地实现完成

上一通信阶段要求已落地：服务端使用 Netty TCP；当时固定 19 字节包头不加密（本次新增前缀后为 21 字节），控制头与包体整体加密；业务包体为 JSON，握手包体为原始 byte[]。该阶段没有启用 dsh，没有提交、推送或发布镜像。

- 已完成服务端 Maven verify：最终 27 项测试通过（0 失败、0 错误、0 跳过），包含实际 Android 网络代码与 Netty 的真实 TCP 联调。最后一次检查于 14:12 完成；收到用户减少测试的指示后只收取已有进程结果，没有追加运行。
- Android assembleDebug lintDebug 已通过，Lint 为 0 errors、4 warnings（版本提示、备份配置提示、文本国际化提示）。
- 客户端关闭原因发布的并发时序已用专用同步锁处理，最终源码对应的服务端检查及 Android 构建已结束。
- 本机 adb devices 没有连接的设备，未进行手机安装、模拟器交互或厂商真机验证。
- 详细协议已新增到 docs/PROTOCOL.md；根目录及两端 README 已同步更新。
- 不要用历史明文协议的远端镜像验证新版 APK；两端需同时更新。

## 已确定的项目组织与需求

- 根目录：D:\Code\chinese-chess-flipping。
- server/ 和 client/ 是同一 Git 仓库中的两个独立工程，分别用 IDEA 与 Android Studio 打开。
- 服务端：Java 21、Spring Boot 3.5.16、Netty，对外 TCP，不启动 HTTP 服务。
- Docker 构建上下文始终只有 server/，GitHub Actions 位于根目录 .github/workflows/。
- Android：原生 Java，最低 API 26，compile/target SDK 37，AGP 9.4.0，Gradle 9.6.0，包名 com.chessflipping.client。
- 中文说明使用方式，区分自动测试/构建通过和真实手机验证，不宣称已通过 iQOO/一加/小米厂商兼容性验收。
- 不提交本机 SDK 路径、IDE 状态、缓存、密钥或签名文件。保留来源不明或用户新增的修改。
- 已有未跟踪文件 client/gradle/gradle-daemon-jvm.properties，本轮保留原样，未纳入发布或修改。

## 上一通信阶段的实现记录（历史）

### 报文与握手

- 固定头：固定标识 0xFC 0xFC(2) + 总长度(4) + 控制头长度X(4) + 包体长度Y(4) + 版本(1) + 类型(1) + 加密/压缩标志(1) + CRC32(4)，全部大端序。
- X/Y 是解密后的字节长度；控制头最大 4096，包体最大 65536；加密报文总长为 21+12+X+Y+16。
- 控制头为 UTF-8 JSON。业务及心跳包体为 UTF-8 JSON 对象，握手包体为原始字节。
- 控制头与包体合并后 AES-256-GCM 加密；固定头 byte[0..16] 作为 AAD；CRC32 对 byte[0..16] 和 byte[21..末尾] 计算，不包含自身。
- ECC 采用 P-256 ECDH，HKDF-SHA256 派生两个方向的独立 AES 密钥与 Nonce 前缀。服务端每次启动生成内存密钥；客户端每次连接获取公钥并生成临时密钥，不缓存公钥、不做 MD5 校验。
- 明文阶段：PUBLIC_KEY_REQUEST → SERVER_HELLO → CLIENT_KEY。只交换流水号、公钥和随机数，设备标识不在此阶段传输。
- 加密阶段：SERVER_FINISHED → CLIENT_FINISHED → READY；确认双方掌握密钥及握手摘要后才允许业务。
- 每方向严格递增 Nonce 序号，拒绝重复、跳号及跨会话报文；握手后禁止明文通信；暂不启用压缩。
- 控制头使用 32 位 TID，响应原样返回；加密 CLIENT_FINISHED 携带 CHL/DID/APP/VER。DID 是本地保存的随机安装标识，清除数据或重装后变化，不是登录身份凭据。
- 公钥交换没有预置信任，不能抵御主动中间人攻击；服务端启动密钥在进程内复用，因此也不提供历史会话的前向保密。不是标准 TLS，未实现用户认证。

### 服务端

- TCP_PORT 默认 9000（1–65535），TCP_WORKER_THREADS 默认 4（1–256），仍控制 Netty I/O 工作线程数。
- 新增 BinaryFrameDecoder，处理拆包/粘包，先验证固定头上限再分配/等待完整报文。
- ProtocolHandler 为每连接独立握手状态及加密会话；10 秒绝对握手时限，90 秒未收到完整报文关闭。
- 保留 ECHO 中文回显和 PING/PONG。业务格式错误返回加密 ERROR；协议/CRC/GCM/握手失败直接关闭连接。
- 原有明文 WELCOME 和按换行分帧协议已移除。
- TCP 生命周期、Docker 非 root、多阶段构建和配置项保留。

### Android 客户端

- TcpClient 的网络、握手、加解密全部在后台执行；读线程和单一写线程保证收发顺序。
- 界面状态：正在连接 → 正在进行加密握手 → 加密连接已建立；只有最后阶段启用发送按钮。
- 每 20 秒发送加密心跳，连接超时 8 秒，握手绝对超时 10 秒，socket 读取超时 70 秒，最多 128 个等待请求。
- 进入后台主动关闭，返回前台手动重连，每次重连重新握手。
- Android 17 本地网络权限处理及窗口边距处理保留；没有 Google Play 服务、厂商 SDK、原生 .so 或新增运行时加密库。

### 关键文件与维护约定

- docs/PROTOCOL.md：完整线协议，包含偏移、长度、包类型、握手字节布局、HKDF/Nonce、CRC/AAD 和错误行为。
- server/src/main/java/com/chessflipping/server/TcpServer.java：监听及每次启动生成 ECC 密钥。
- server/src/main/java/com/chessflipping/server/BinaryFrameDecoder.java、ProtocolHandler.java：分帧及状态机。
- client/app/src/main/java/com/chessflipping/client/TcpClient.java、MainActivity.java：客户端网络与界面状态。
- 两端各有 com/chessflipping/protocol/{WireProtocol,KeyExchange,SecureSession}.java。为保持两个独立工程以及 server/ Docker 上下文，两份源码保持完全一致；修改时必须同时更新。
- ClientInteropTest 检查两份协议源码一致，在隔离的类加载器中编译实际 Android TcpClient 与协议源码，并与真实 Netty 端口互通；org.json 只作为服务端测试依赖，生产服务端没有新增该运行时依赖。
- 独立 server/ 或 Docker 中不存在 client/ 时跳过 ClientInteropTest，其余协议测试照常执行；完整仓库的 GitHub Actions 会运行全部测试。

## 上一通信阶段的既有验证内容

1. KeyExchangeTest：4 项，通过 RFC 5869 官方向量、非法曲线/公钥、截断包及长度上限、关闭会话/方向隔离。
2. ProtocolTest：20 项，覆盖逐字节握手、拆包/粘包、中文及最大包体、非法 JSON/头部、CRC、密文/认证标签/明文包头篡改、重放/跳号、会话隔离、明文降级、握手摘要/设备字段、握手超时和空闲处理、参数校验。
3. ClientInteropTest：3 项，实际 Android 网络代码运行于桌面 JVM，通过真实 TCP 验证并行客户端、中文 ECHO、20 秒自动心跳、重连、被篡改握手拒绝和 10 秒握手超时。
4. Android assembleDebug lintDebug 已成功；APK 位于 client/app/build/outputs/apk/debug/app-debug.apk，被 Git 忽略。
5. JVM 互通不等同于 Android 系统加密提供者或真机 UI 验证；没有连接的 adb 设备。
6. 本轮尚未在 Docker 中构建/运行新版本，也未部署正式服务器或更新远端镜像。

## 上一阶段的 GitHub 与发布状态（历史）

- 仓库：https://github.com/LinHuiG/chinese-chess-flipping ，本地分支 main。
- 已知历史提交：9025216（首次工程）、18fb25d（心跳、图标和备份规则），均来自本轮前记录。
- 方案、文档与 agent 归档要求作为单独的文档提交；二进制加密协议相关源码和测试修改仍留在本地，未包含在本次文档提交中。不要把远端源码或镜像当成本轮加密协议产物；后续代码发布需另外提交并验证。
- .github/workflows/publish.yml：推送 main、v* 标签或手动触发先 Maven verify，再发布 linux/amd64、linux/arm64 到 GHCR；PR 只测试。
- 未设置 paths 过滤，客户端/文档推送 main 也会触发流水线，Docker 上下文依旧只用 server/。
- 镜像：ghcr.io/linhuig/chinese-chess-flipping:latest，另有版本和 sha 标签。
- 历史首次发布成功：https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36297517439 。当时确认 latest 可匿名读取且有两个架构；不是对本轮新代码的发布验证。
- 本机未实际 docker pull/run；后续远端状态要重新查询。

## 本机工具与构建经验

- IDEA / Java 21：D:\Program Files\JetBrains\IntelliJ IDEA 2025.2\jbr。
- Maven：D:\Program Files\JetBrains\IntelliJ IDEA 2025.2\plugins\maven\lib\maven3\bin\mvn.cmd。
- Android Studio JBR 25：D:\Program Files\Android\Android Studio\jbr。
- Android SDK：C:\Users\linhui\AppData\Local\Android\Sdk，已安装 SDK 37、Build Tools 36.0.0。
- client/local.properties 为已忽略的本机 SDK 配置，不提交。
- PowerShell 中 Maven/Gradle 的 -D 参数应作为完整字符串引用，例如 '-Dmaven.test.skip=true'，否则可能被错误拆分。
- 本轮 Maven、Gradle 依赖下载和构建无需修改共享代理配置。历史代理 127.0.0.1:7897 仅为旧环境记录，不应写入仓库。
- IDE 历史状态：IDEA 曾打开 server；Android Studio 曾停在信任提示。本轮仅命令行构建，未检查当前 IDE 页面。
- Git push 历史上使用本机凭据成功；不在聊天、日志、源码中保存 token。

## 下一步

1. 当前功能和本地集中检查已经完成，不重复开发既有房间和棋局。用户按 [部署说明](docs/DEPLOYMENT.md) 在自己的服务器拉取匹配版本镜像，放行 TCP 8888 并核实域名；未经新授权不操作远端服务器。
2. 用户有真实设备后，再针对实际机型检查网络权限、系统加密提供者、长时间后台/锁屏与前台重连；有限模拟器结果不等于厂商真机验收。
3. 以实际公网负载决定是否需要提高堆/线程或进一步压测，不以本次 102 个心跳连接短测推断最大容量。镜像与客户端协议必须匹配。
4. 若需抵御主动中间人攻击/前向保密，另行设计可信身份与临时服务端密钥或标准 TLS。
