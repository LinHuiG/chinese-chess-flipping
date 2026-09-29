# 项目执行记录与交接

## 网页 APK 下载入口（2026-09-30）

- 用户要求网页提供 APK 下载按钮。顶部工具栏新增“下载 APK”，直接使用已有同源接口 /api/app/latest.apk?versionCode=0 和浏览器下载行为；没有新增重复服务端接口、JavaScript 或安装包副本。保留原有版本检查和 APK 响应头，下载文件名为 chess-flipping.apk。
- 工具栏在窄屏可换行，新增链接沿用原有蓝色与键盘焦点样式；根 README 和部署说明补充网页下载入口与接口用法。
- 本地使用现有 Rust release 程序加载当前网页与新打包的 0.6.2 调试 APK，Playwright/Edge 检查 1440、390、320px 下入口可见、工具栏不越界且页面无横向溢出，并查看 390px 截图。HEAD 返回正确 APK 类型和附件文件名；真实点击下载得到 3056913 字节文件，SHA-256 与本地清单一致。git diff --cached --check 通过；未运行完整对局回归或部署服务器，截图与构建产物不入库。
- 默认服务器改动 1b85fcf 已推送；[Actions 36602866065](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36602866065) 全部成功，正式 APK 与双架构镜像已发布。网页入口将在本轮推送后的镜像中提供，远端 Actions 结果待确认。

## Android 默认服务器改为 fqgame.tdcode.tech（2026-09-30）

- 用户要求 APK 默认配置与文档统一为 TCP / fqgame.tdcode.tech / 8888，并授权提交。已同步 GameService 的默认域名、端口和协议，以及设置页尚未绑定服务时的 TCP 选中状态和“恢复默认值”；保留已经保存的服务器设置，用户可通过“恢复默认值”后“保存并连接”切换。
- Android 版本递增为 0.6.2 / versionCode 9，便于应用内更新识别；服务端版本和协议不变。根 README、Android README、部署说明及 AGENTS.md 已同步，历史实施/验收记录保持原貌。
- 本地使用已有 Android Studio JBR 完成 assembleDebug（11 秒），生成调试 APK；git diff --cached --check 通过。未扩展回归测试，未验证真机安装、界面操作或目标域名公网连通性，未部署服务器。正式签名 APK 和镜像发布结果待本次推送后的 Actions。
- 本轮文件已暂存，保留本机 Gradle JVM 未跟踪配置及本地教学资料。

## AGPL 许可与 README 整理（2026-09-30）

- 用户选择 AGPL-3.0，并授权将许可证与 README 一起提交推送。新增根目录 LICENSE，采用 SPDX 发布的 AGPL v3 标准全文；README 和 server/Cargo.toml 明确标识为 AGPL-3.0-only。第三方代码、资源及原有许可声明保留各自许可，本轮未进行完整依赖许可审计。
- README 改为面向玩家、部署者和开发者的项目首页：介绍功能、Android 下载与联机、Docker Compose 启动/更新、端口、本地开发和许可证。删除 agent 接续入口、操作授权提醒、内部验证边界及流水线缓存实现细节；内部协作与执行记录仍保留在 AGENTS.md、PROJECT_STATUS.md。
- 核对当前代码中的默认地址、最低 Android 版本、SDK/JDK 配置、Compose 端口映射及 APK 打包路径。README 的 6 个本地链接存在，2 段 PowerShell 示例语法解析通过；Cargo 离线 metadata 正确读取 AGPL-3.0-only，LICENSE 第 0–17 节及正文结束标记齐全，git diff --cached --check 通过。未运行编译、对局回归或新部署。
- GitHub API 确认最近成功运行 36599997835 的 app-update 附件存在且未过期。当前环境访问默认站点 HTTPS 返回 502、HTTP 检查超时，未据此断言服务器故障；README 未添加承诺可用的公共试玩/直接 APK 下载入口，未修改服务器。
- 文档及许可证已暂存；本轮提交使用 [skip ci]，避免仅许可元数据变动触发镜像构建。保留本机 Gradle 未跟踪文件与被忽略的本地教学资料。

## CI 优化与 Node.js 24（2026-09-30，已发布）

- 用户授权复核后提交推送，并要求处理 GitHub Node.js 20 弃用警告。已核实最近一次远端运行 36575192599 的结果为 success，该提示不是该次发布失败的证据。
- 逐个读取上游 action.yml，确认 checkout v6、cache（含 restore/save）v5、Gradle setup v5、setup-node v6、upload-artifact v6、download-artifact v7、Docker build-push v7/login v4/metadata v6/setup-buildx v4 均声明 node24；原有 setup-java v5 和 setup-android v4 同样为 node24，保持不变。构建逻辑、缓存边界及已确认的第 3/4 项优化范围不变。
- 用户新增教学资料本地保留要求：已将学习大纲、docs/learning/、课程 PDF 从暂存区移除并加入忽略规则；教学记录移至 docs/learning/PROJECT_STATUS.md，README 移除远端无法访问的教学入口，AGENTS.md 记录该暂存例外。文件均保留在本地。
- 主改动提交 88e99215a1ffee6178eed2246d7e3c6bf48f5ffe 已推送 main。推送前 actionlint 1.7.12 与差异检查通过；沿用本轮已完成的条件/顺序静态核对及之前记录的定向 Gradle 检查，不追加完整本地回归。
- [Actions 36599997835](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36599997835) 全部成功：Build APK and run checks、Publish amd64、Publish arm64、Publish multi-platform manifest 四项均 success。两架构均实际完成按 digest 上传、启动资源检查、验证后更新架构标签，随后成功合并通用索引；步骤时间戳确认标签更新晚于验证成功。
- 本次四项检查的 annotations 中无 Node.js 20 弃用警告；仅检查任务有 ubuntu-latest 将迁移到 Ubuntu 26 的 notice，非失败。没有远程部署，没有追加缓存暖启动或无改动分支的远端运行；这些场景不冒充已实跑验收。教学文件仍在本地且未被跟踪，原有本机 Gradle 未跟踪文件保留。

## CI 无改动跳过与验证后发布标签（2026-09-30，本地实现）

- 用户确认修复无相关改动时继续检查、镜像验证前更新架构标签两处问题；Runner/工作流缓存键及 Docker 依赖层优化暂不实施。保留原 job 结构、缓存方案、PR 检查和手动强制发布行为。
- scope 新增 should_check 输出。push 内部 diff 没有 server/（含 Web）、android_client/ 或 APK 打包脚本变化时，后续 22 个步骤全部跳过，publish/merge 也跳过；只有检出和范围判定会执行。PR 仍执行检查且不发布。
- 架构镜像改为按 digest 上传，启动并验证清单/Web/APK 后，才通过 imagetools create 更新原有架构 latest/sha 标签；验证失败不改正式标签。两架构互不等待，通用索引仍待双方成功后按本次 digest 合并。
- 验证：actionlint 1.7.12、git diff --check 通过；本地静态求值确认无改动时全部 22 个后续 step 条件为 false，并核对 digest 上传、验证、更新标签与保存 digest 的顺序和默认成功条件。未执行 Bash 运行验证、完整构建或远端 Actions，真实 GHCR digest 上传/拉取/更新标签待下次发布验证。
- 已同步 README 与部署说明并暂存本轮修改；未提交、推送、发布或部署，保留既有其他暂存文件和本机 Gradle 未跟踪文件。

## CI 已验证产物复用（2026-09-30，本地实现）

- 用户要求 Android 未变复用 APK 并跳过客户端检查，Rust 未变跳过编译/测试，只有 Web 变化时不重复两端工作；进一步要求修改 job ID。已将 `test` 改为 `build_apk_and_check`，同步 publish 的依赖和输出引用，保持合并任务及双架构发布、合并结构。
- 增加 APK 成品、Rust 检查程序、两端互通组合标记三个精确缓存，只在全部必需检查及 Web 检查成功后保存。输入覆盖源码/构建和测试配置、工作流、Runner 镜像版本、Rust 实际工具链、APK 变体和 CI_CACHE_EPOCH；Web 不计入 Rust/Android 源码键。缺失、非精确命中或文件校验失败补建，坏的精确缓存需删除或更新代次，不能原地覆盖。
- 互通按客户端或服务端任一输入变化重跑，并在任一产物补建或组合结果缺失时重跑；已向用户说明仅客户端变化也可能破坏协议。Gradle 新增 chessTestSuite=client/interop，前者排除 TransportV2Test，后者只执行该类、要求测试端口并禁用 Gradle 的测试缓存/UP-TO-DATE；普通本地命令仍跑原全部用例。
- 仅 Web 且完整暖缓存时跳过 JDK/Android/Gradle 设置、APK 构建/客户端检查、检查用 Cargo 编译/测试及互通；保留清单哈希、HTTP 资源、Web 逻辑及架构镜像资源检查。Rust 工具链准备仍用于核对版本；Docker 的 musl/双架构编译仍依赖各自 BuildKit 缓存，不宣称永不重编。
- 签名密钥未放缓存/缓存键；轮换签名需同步递增仓库 Actions Variable `CI_CACHE_EPOCH`（默认 1）。原触发/发布判定、PR debug 与正式签名隔离、标签及 concurrency 保留；未设置远端变量、未提交推送或触发 Actions/部署。
- 验证：actionlint 1.7.12 通过；10 个多行 Bash 块语法检查通过；实际条件脚本在本地临时夹具跑过 9 个冷暖/单端变更/损坏/非精确命中场景；输入键 7 个失效场景及相同输入稳定性通过。Windows 夹具中 SHA-256 命令以 Python 等价实现，工具链调用为桩，不冒充 GitHub 执行结果。
- Android 定向检查：client 模式 16 项通过（0 失败/跳过）；interop 的 Gradle test dry-run 仅选中 TransportV2Test 的 2 项（按 dry-run 跳过），确认筛选与 Kotlin 配置有效，未称为真实互通通过。未重跑 Rust、完整 lint、真机或远端 CI；缓存上传/恢复和耗时仍待 Actions 实跑。文档及配置按要求暂存，保留原有教学文件和本机 Gradle 未跟踪文件。

## Actions 命名与职责说明（2026-09-29，本地配置）

- 用户最终决定保留 APK 构建与检查合并，首个任务新增显示名称 `Build APK and run checks`，内部 ID 仍为 test；Rust 步骤改名 `Test and build Rust server`，修正工作目录网页检查的注释。结构仍是 test → 两架构 publish → merge，不新增 apk job 或中间附件。
- 原有触发条件、发布判定、命令、检出深度、签名范围、检查顺序、artifact、缓存、标签、权限和 concurrency 均保留。命名变化可能需要已有按名称匹配的 required check 配置同步；本轮未修改远端分支保护。
- 纠正此前“可直接按事件类型替代内部 diff”的建议：GitHub 对超过 1,000 个提交的推送或差异计算超时可能放行工作流，为保留无应用改动不发布的行为，保留实际 diff 和 output 交接。
- 用户询问的缓存边界已补充部署说明：APK 仍调用 Gradle，不按 Android 变化显式下载历史包；镜像内 Rust 缓存与检查用 Cargo 分开；缓存全部命中不代表跳过镜像发布。本轮不新增缓存/历史产物复用机制。
- actionlint 1.7.12 静态检查通过；逐行排除名称与注释后，工作流与本轮前 HEAD 完全相同，确认未改执行配置和命令。git diff --check 通过。未运行项目构建/回归，未触发远端 Actions、镜像发布或部署，未改业务代码；修改已暂存，未提交推送。

## 两台服务器更新至 0.6.1 资源发布（2026-09-29）

- 用户再次授权更新两台服务器；已备份配置、保留旧镜像回退标签，拉取 latest 后按镜像是否变化决定重建。本次两台均有更新，部署提交 50898fec7c3cfde248b7b743cff25dc2d38ba2b2，索引摘要 sha256:4692c5586262e54b1237ac7a934018f996385fcf692de1b6f8dd4f6c15e7ade8。
- 保留两台 TCP/UDP 8888、各自 HTTP 80 / 8086 和现有反代配置；容器运行正常、重启计数 0、UDP 监听正常。第一台自动更新定时器 active，原脚本比较镜像 ID、相同且运行中则跳过的逻辑仍在。
- 两台公网版本接口均返回 App 0.6.1 / versionCode 8；公网 TCP v2 握手和 WSS READY/PONG 通过。第一台公网完整 APK 下载校验通过，第二台经服务上游完整下载校验通过，均匹配 Actions SHA-256 a1ef4a8b258a62b3960cbe9915e43ffcddc5149c26a59d8c8f7d6a6002b4bb0c；第二台本地公网完整下载较慢，未将其写成已完成。
- Rust 日志仍显示引擎 0.6.0，协议仍为 v2，这是本次发布的预期版本关系。用户两端 App 应升级至 0.6.1，网页刷新获取兵卒互吃规则。本轮未进行真实对局或公网 UDP/P2P 验收。
- 记录已脱敏，服务器地址和凭据不入库；未改动其他开发文件。

## 资源分层与兵卒互吃 0.6.1（2026-09-29，已发布）

- 用户授权实施、提交推送并实跑 Actions 测时；未启用 dsh 或子代理，未远程部署。打包改造提交 587f238，客户端/网页规则提交 50898fe。
- 网页和 APK/清单不再通过 include_bytes!/include_str! 编译进 Rust；启动时读取一次，校验 APK 后共享 Bytes 快照。保留固定网页白名单、HEAD、安全头、TCP/HTTP 版本检查和分块下载；缺少资源或 APK 校验失败会启动失败。镜像设 CHESS_RESOURCE_DIR=/app，本地默认 server/，用户仍按原方式拉镜像更新。
- Docker 编译层只复制 Cargo 配置和 src/*.rs，网页/APK 在最终镜像中单独复制；保留原生 amd64/arm64 独立发布及合并。Actions 增加 Cargo、Gradle 缓存。资源变更且缓存命中时不重编镜像中的 Rust；缓存失效或基础镜像变化仍需编译。
- 兵卒可吃上下左右相邻的对方明兵/卒，保留吃将帅；不能吃己方明棋、暗棋或其他种类。同步 Android/Web 判定与说明、规则文档、既有吃子矩阵和无路可走夹具；Web 检查覆盖双方颜色和非法目标边界。
- Android 发布为 0.6.1 / versionCode 8，Rust 引擎及协议仍为 0.6.0 / v2。双方 App 应更新至 0.6.1，网页版需在服务更新后刷新。

### 实测耗时

以下总耗时统一从 Actions 创建时间到最后一个 job 完成时间计算；并行 job 耗时不能直接相加。

| 发布 | 总耗时 | 检查任务 | amd64 镜像任务 | arm64 镜像任务 |
| --- | --- | --- | --- | --- |
| [旧 QEMU 流程 36558536441](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36558536441) | 20 分 29 秒 | 3 分 31 秒 | 两架构合并任务共 16 分 51 秒 | 同左 |
| [首次资源分层 36574372330](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36574372330) | 6 分 19 秒 | 3 分 48 秒 | 1 分 56 秒 | 1 分 52 秒 |
| [兵卒互吃资源更新 36575192599](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36575192599) | 4 分 15 秒 | 3 分 12 秒 | 33 秒 | 25 秒 |

- 三次均成功。旧流程详细日志：amd64 Rust 编译 154.2 秒，QEMU arm64 编译 928.1 秒，导出/推送 7.7 秒，缓存导出约 40 秒；历史瓶颈是 ARM 模拟编译。首轮新流程原生 Rust 编译约 76.7 / 54.7 秒。
- 第二轮两架构 RUN cargo build --locked --release 均明确 CACHED；Docker build/push 步骤分别仅 6 / 4 秒，镜像启动及网页/APK 内容核对分别 1 / 2 秒；最终合并任务 18 秒。GHCR 两次发布的 Rust 二进制层摘要逐架构完全相同，网页/APK 层均变化，确认真实复用。
- 第二轮剩余开销：APK 构建签名 35 秒，检查任务 Rust 测试/编译 43 秒（仍会编译检查用程序，不是镜像程序），联调/lint 23 秒，Gradle 缓存保存 56 秒，另有环境、缓存恢复、排队及清理。因此没有宣称整条流水线完全不编译 Rust，也没有跳过原有发布检查。
- 4 分 15 秒比旧流程约缩短 79%；同时包含原生架构、资源分层和构建缓存带来的改善，不将全部收益归于资源分层。后续网络、队列和缓存状态可能改变耗时。

### 验证与交付

- 本地：Rust 7 项测试、release 编译；运行时网页内容、HEAD、APK 下载及 404 检查；Android GameEngineTest 8 项及 assembleDebug；Web 规则/恢复检查；actionlint 和 git diff --check 通过。
- 最终 Actions：Rust 7 项及 release、Android 固定签名 release/单元/互通/lint、Node 恢复与兵卒规则检查、amd64/arm64 实际镜像启动和网页/APK 字节核对均通过。未进行新一轮真机、真实公网对局或性能压测。
- 最终镜像 sha-50898fe 与 latest 发布成功，索引摘要 sha256:4692c5586262e54b1237ac7a934018f996385fcf692de1b6f8dd4f6c15e7ade8；同时发布 latest-amd64 / latest-arm64。配置和用户部署命令不变。
- Actions APK 已下载至 android_client/build/deliverables/chinese-chess-flipping-0.6.1-actions.apk，2253142 字节，SHA-256 a1ef4a8b258a62b3960cbe9915e43ffcddc5149c26a59d8c8f7d6a6002b4bb0c。清单/哈希/apksigner 校验通过，签名证书与已有 0.6.0 一致。APK、原始日志及本机凭据未入库。
- 保留原未跟踪 android_client/gradle/gradle-daemon-jvm.properties。收尾文档提交标记 [skip ci]，避免仅同步说明再次发布镜像。

## 两台服务器更新至 0.6.0（2026-09-29）

- 用户本轮明确授权按部署文档更新两台服务器；已分别备份 Compose 配置、容器信息并为旧镜像保留回退标签，再拉取 latest、重建对应服务。
- 两台均运行 0.6.0，镜像发布提交 ca2bb9fd166b38fef72c8d98f75e08e822365cfe，仓库摘要 sha256:75b906f98f09e1c18b243a36d9a84478629ed28a202a705c46e63c6237e55c33。
- 原配置未修改：两台 TCP/UDP 均为 8888；第一台 HTTP 80 通过原容器网络反代，第二台保留 HTTP 8086 的原有绑定与反代。第一台每日更新定时器保持 enabled/active。
- 已验证：两台容器 running、重启计数 0、UDP 8888 容器内监听和 Docker 映射；公网 HTTPS、TCP v2 握手响应、WSS v2 READY/PONG；下载内嵌 APK 均为 0.6.0 / versionCode 7、2253138 字节，SHA-256 20318287daff4b1790bb88cbb462c60652ac5092c6e41ca67eb56795dcf619a8，与 Actions 附件一致。
- 本轮未验证公网 UDP 端到端登记、真实对局或 Wi-Fi/5G/IPv6 P2P 成功率；监听与映射正常不代表这些场景已经通过。0.5.x 与协议 v2 不兼容，已告知用户两端 App 首次需要手动升级至 0.6.0。
- 部署记录仅保留脱敏结果；实际地址、账户、密码、服务器备份和 SSH 辅助脚本均未加入仓库。

## amd64 独立提前发布（2026-09-29，配置调整）

- 用户要求拆分发布、amd64 完成即可使用，并明确本次没有服务端代码修改，不得重新发布镜像。仅修改工作流与仓库文档，未改 server/、Android 或 APK 打包代码。
- publish 改为原生 amd64 / arm64 矩阵，移除 QEMU；fail-fast=false，独立发布 latest-amd64 / latest-arm64 和架构专用 sha 标签。按架构隔离缓存，两个任务都成功后以本次 digest 合并通用 latest / sha-*；同分支串行发布防止旧构建覆盖新标签。
- push 增加路径过滤，并从内部变更判定移除工作流路径；仅 server/、android_client/ 或 scripts/package-app-update.py 变化自动触发。保留 Android 发布，避免 APK 更新漏入镜像；PR 检查及手动发布保留。
- actionlint 1.7.12 和 10 段 shell 语法检查通过；本次 4 个改动文件的发布路径匹配为 0，server/、Android 和 APK 打包脚本均无改动。提交附带 [skip ci]，配合路径过滤避免推送后重新构建；未手动触发 Actions、未改远端镜像标签。新架构标签从下次代码发布开始生成，原生 ARM 构建和实际提速尚未实跑验证。
- 工作流提交 05b8944 已推送；推送后 GitHub API 核实该提交 Actions 运行数为 0，GHCR latest 索引仍为 `sha256:75b906f98f09e1c18b243a36d9a84478629ed28a202a705c46e63c6237e55c33`，本次未重新构建或发布镜像。

## 会话/协议 v2 与 App 更新（2026-09-29，已发布）

- 用户“执行”授权后开始本轮，新增要求服务端每个功能块有中文注释；main/net/hub/wire/json/update 已补齐。没有启用 dsh 或子代理，没有远程部署。
- 已实现：逻辑用户与连接分离、userId/token 本地保存、最后心跳 60 秒清理、10 秒可疑状态、连接代次接管；昵称本地设置和转发、默认房名、断线灰显；Android AtomicFile / Web sessionStorage 完整房主存档，恢复保留原计时与操作去重。服务器仍全内存，重启全部失效。
- 协议 v2：17 字节共同帧、TCP/WS 二进制共用、去 CRC/业务 TID/转发表；棋局正文 Bytes 原样共享，TCP 原地解密后切片。实际边界是正文不解析/不重编码，TCP 外层仍有加解密，没有新增双层房间加密；0.5.x 不兼容。
- P2P：独立候选失败隔离、最多两轮及网络变化重协商、全局 IPv6 候选、无需等待反射登记、最近 20 条脱敏诊断（长按路线标签）；服务端 UDP 仍 IPv4。保留已认证多来源接收及中转兜底。
- 已通过：Rust 7 项定向测试；Android 桌面单元/互通 18 项（0 失败/错误/跳过，含 TCP→WS 透传、恢复接管、私有棋盘/历史/期限、重复走棋、UDP 无效 IPv6 候选与多来源 ACK，以及 TCP/HTTP 完整 APK 下载与同版本不下载）；Node 客户端恢复/帧检查；双浏览器建房开局、4 步棋、断网灰显/客人重连、房主刷新恢复暗棋和历史、昵称及移动布局联调。联调发现并修复刷新误注销问题。
- 最终本地 Rust release、Android assembleDebug / assembleRelease / lintDebug 通过（lint 0 errors、10 warnings）。两项旧 JVM 棋规/展示检查及 UDP 测试迁入 Android 测试目录，承接并行线程的旧 Java/Maven 删除；未恢复旧生产工程。
- App 更新：设置提供检查更新与自动检查开关；TCP 功能号 48–51，32 KiB 有界分块；HTTP /api/app/version 和 /api/app/latest.apk，必须携带当前 versionCode，同版或更新版本不下载。校验大小、SHA-256、包名、versionCode 和当前安装签名，使用 FileProvider 调用系统安装器，游戏中推迟自动弹出安装。未承诺静默安装。
- 按用户追问改为 Actions 构建固定签名 release APK，再生成清单并内嵌镜像；不提交 APK。Android / 服务端 / 打包脚本 / 发布工作流变化均触发镜像发布。已通过 GitHub Secrets API 加密配置 4 项 APK 签名参数，私钥未写入仓库或镜像；PR 不注入发布密钥，正式发布缺少配置直接失败。
- 本地 release APK：0.6.0 / versionCode 7，2253138 字节，SHA-256 `6cbc74f832eee32f0b2605ea6eac4a7f2c27310f37a3262005d8f097ca6c9009`，路径 android_client/app/build/outputs/apk/release/app-release.apk；apksigner 验证通过，证书与原 0.5.1 一致。Actions 构建的 APK 哈希可能不同，以附件内清单为准。0.5.x 无更新入口，首次需手动覆盖安装。
- 未验证：系统未知来源授权与真实安装流程、真实 Android 进程重启/真机系统兼容、真实 Wi-Fi/5G/IPv6 连通性与公网 NAT 改善、Linux 容器实际运行及性能变化。不得将编译/桌面检查当成这些结论；没有远程部署。
- 主改造提交 314dd52 已推送。首轮 Actions 36557834285 在 setup-android v3 阶段失败：默认请求 Google 已停止提供的 tools 包；未进入 APK 编译和镜像发布。已按上游说明改用 v4、明确 SDK 包并将 setup-java 升至 v5，修正结果见下方发布记录。
- 第二轮 36558271796 确认 SDK 37 的仓库包名已改为 `platforms;android-37.0`，不是 `platforms;android-37`；依据 Google repository2-3.xml 修正安装参数，App 的 compileSdk/targetSdk 保持 37。
- 第三轮 [Actions 36558536441](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36558536441) 对应 ca2bb9fd166b38fef72c8d98f75e08e822365cfe，test / publish 均成功，2026-09-29 19:15:45（北京时间）完成发布。Linux 检查包含固定签名 APK、清单核对、Rust 7 项及 release、Android 互通及 lint、Node 恢复。已下载 app-update 附件并验证 SHA-256 及旧版签名一致；实际 Actions APK 为 2253138 字节，SHA-256 `20318287daff4b1790bb88cbb462c60652ac5092c6e41ca67eb56795dcf619a8`，交付路径 android_client/build/deliverables/chinese-chess-flipping-0.6.0-actions.apk。APK 及下载缓存均未入库。
- 已匿名核实 ghcr.io/linhuig/chinese-chess-flipping 的 latest 与 sha-ca2bb9f 指向同一索引 `sha256:75b906f98f09e1c18b243a36d9a84478629ed28a202a705c46e63c6237e55c33`，实际包含 linux/amd64 和 linux/arm64。用户可按 docs/DEPLOYMENT.md 拉取部署；原本机服务与用户模拟器未改动，本轮回环联调服务已停止。仅保留原未跟踪 gradle-daemon-jvm.properties。

更新时间：2026-09-29（Asia/Shanghai）。新线程先阅读本文和 README.md，再检查 git status；当前代码、测试和远端状态优先于历史记录。

## 清理服务端 Java 遗留（2026-09-29）

- 按用户要求删除 server/ 内旧 Java 实现、Java 测试及客户端 JVM 互通夹具、pom.xml、Spring 配置和旧 Java/Rust 性能对比脚本；保留 Android Java 客户端与 Rust 内嵌网页。
- Actions 移除 JDK/Maven 步骤，保留 Rust 测试、构建和镜像发布；同步当前使用说明。下方 Java/Maven 验证记录为历史结果，不代表现有测试覆盖。
- 本轮 git diff --check 通过；cargo check --locked 失败：工作区另有 hub.rs 修改，register/active/disconnect/handle 与 Output 接口尚未和 net.rs 对齐（13 个编译错误）。本次未修改 Rust 源码，保留该在途改动；未执行完整回归，移除的 Android 规则和互通覆盖待统一验收补齐。未提交、推送或部署。

## 用户重连、昵称与协议简化评估（2026-09-29，仅方案）

- 用户要求减少套壳，允许破坏性更新；连接与用户解绑，连续 60 秒无有效心跳才清理。新增本地用户名、连接时上报但服务器不存昵称、默认“用户名的房间”，以及对方断线置灰提示、恢复后亮起。
- 用户再次强调尽可能减少总代码量，仅保留确有必要的抽象；本轮汇总整体实施范围，约束已同步根目录 AGENTS.md 及方案。仍未开始业务代码改造。
- 用户后续确认：断线倒计时继续，以房主为准；恢复覆盖网络波动、App 重启和网页刷新；服务器不持久化任何业务数据，重启后用户、房间与棋局全部失效。取消跨服务端重启的身份恢复/签名密钥持久化建议，改为客户端完整存档配合 60 秒内恢复。
- 已审阅 Rust 收发/房间/加密、Android 与 Web 连接和房主状态；建议及恢复边界见 [改造方案](docs/SESSION_PROTOCOL_V2_PLAN.md)。新目标取代旧文档的断线立即退出及 30 秒清理，运行代码尚未修改；具体凭据、存档格式及协议实现仍是技术建议。
- 根据用户提供的 Wi-Fi/5G 排查交接补充代码复核：确认客户端仅 IPv4、单候选发送异常会终止尝试、缺少网络变化重协商；服务端 UDP 仅 IPv4且同轮只接受首次映射，不能只延长 App 重试。方案新增阶段诊断、候选隔离、有限重协商、双栈评估、房间版本用途及五个 Rust 文件职责说明；尚未确认具体 NAT/过滤根因，未重新抓包或验证修复。
- 本轮只做评估及文档暂存，未构建、测试或测量性能，未修改业务代码、提交、推送或部署。保留已有历史排查记录及未跟踪 android_client/gradle/gradle-daemon-jvm.properties。

## 双手机一直中转的历史排查（2026-09-29）

- 约 17:12 用户把同一手机从 5G 切回 Wi-Fi，反馈直连成功；随后的模拟器短时抓包实际确认双向周期性加密探测/回应，出站选择手机局域网路径，同时可接收对端公网映射路径的包。与前面 5G 下仅出站、无入站形成对照，说明此组合的跨网 IPv4 打洞路径失败，局域网路径可用；不能据此确定某种运营商 NAT 类型，家庭/模拟器 NAT 与跨网过滤仍可能参与。现实现仅 IPv4、单服务器反射地址；目标相关映射或严格过滤可能使该地址无法用于访问另一客户端。参考 RFC 5128；未新增业务改动或宣称所有 Wi-Fi/5G 组合都有相同行为。

- 本日约 17:08 进行用户配合复现：本机 Android 0.5.1 模拟器与用户手机 5G 连续开局，两轮均一直中转。模拟器共捕获 20 个发往服务器的登记包、81 个发往手机候选地址的加密探测包，游戏 UDP 入站为 0；服务器容器捕获双方共 40 个登记包。双方服务器登记及对端地址交换已发生，但模拟器侧未收到对端直连包。不能将本次无包归因于客户端解密/防重放丢弃，也不能仅凭这一侧定位运营商 NAT、家庭网络或模拟器转发中的具体阻断点。
- 初始抓包窗口没有新协商流量；要求重新开局后才完整捕获上述两轮尝试，不能将初始空窗口当成客户端未申请直连的证据。短时 JDWP 跟踪因 Android 不支持所需栈参数读取而退出，已自动解除调试并移除 adb 转发；最终结论基于不暂停 App 的包头抓取。没有记录密钥/游戏正文，含地址的原始包头仅留临时目录，不纳入仓库。
- 限时抓包均结束，SSH 已关闭；按用户要求保留模拟器及 App 运行。本轮未改业务代码或重启服务，未证明昨晚另一位玩家的网络与这次完全相同；后续可做同一手机 Wi-Fi/5G 对照或手机侧抓包，以继续定位。

- 用户报告上一日晚间约 23:50 至本日 00:07 双方 Android 0.5.1 对战一直中转；本方 Wi-Fi，对方网络未知。未将这次问题直接归因于已修复的多路径来源过滤。
- 只读检查确认目标服务于本日 05:00 自动更新、重建容器，05:00:30 启动成功；当前容器日志无法覆盖用户报告时段，旧限时抓包也不在该时段。现有服务端未记录每次 P2P 协商/回退原因，因此无法从已有记录还原该局失败阶段。05:00 的更新发生在对局之后，不作为当时失败原因。
- 对当前服务做一次隔离的双客户端检查：通过 WSS 声明 Android UDP 能力、临时建房开局、分发会话配置、发送真实 UDP 登记，双方均收到对端地址，检查通过；临时房间已解散、连接已关闭。该检查只证明当前服务端协商及本机到服务器的登记路径正常，不等于两台用户手机可直接互通，也不证明历史时段一定正常。
- 代码核实：仅使用 IPv4 候选，开局约 10 秒内尝试直连；失败后本局不自动再次申请，错误/超时原因统一回退且无持久诊断。单个候选发送异常也会结束整次尝试。这些是待分辨的限制/风险，不作为昨晚根因的已确认结论。
- 后续需要在双方手机复现时区分配置、登记、对端探测、认证、超时及发送异常，或增加不含地址、密钥和身份信息的阶段/原因诊断。尚未修改业务代码、重新打包或部署；仅暂存脱敏排查记录，不重复全量测试。

## Android 0.5.1 UDP 多路径回退修复（2026-09-28，本地完成）

- 用户反馈同一路由器下一台模拟器与一台手机保持中转，偶尔短暂直连后回退。实际服务端收到双方 UDP 登记；模拟器为 0.5.0、局域网权限已授予，使用 TCP 连接。
- 模拟器包头抓取确认：它向手机局域网和公网候选地址发出探测，也从两条路径收到回应。UdpPeer 在第一条 PONG 后锁定来源地址，丢弃另一条地址发来的已认证数据；与双方选择不同收发路径时握手超时/回退的现象吻合。未抓取明文密钥、未修改或重启线上服务。
- 修复为接收通过同一会话认证和防重放校验的多来源包，出站保留首次成功的 PONG 路径，避免迟到 PONG 反复切换。AES-GCM 认证与防重放规则不变。双方客户端均应升级。
- 新增 UdpPeerTest，实际 UDP 套接字模拟局域网/公网两条来源，验证异来源探测、DATA、ACK，以及不会因 ACK 被丢而超时回退；定向 Maven 检查 1 项通过。Android assembleDebug 通过，仅做本次针对性检查，未重复全量回归或 lint。
- Android versionCode 6 / versionName 0.5.1；交付 android_client/build/deliverables/chinese-chess-flipping-0.5.1-debug.apk，SHA-256 `89E19D18B3011432ED43FCE8B1A554BA4E8DAC4408F83A63CC44CAC5BC0C2D2D`。模拟器覆盖安装成功并核实版本；手机待用户安装，双方升级后的真实联机尚未验证。服务端仍为 Rust 0.5.0，无需为此重建镜像。
- 临时调试连接、断点及 adb 转发已移除，限时抓包已结束；改动与记录已整理，按用户要求提交推送；真实双方联机仍待验收。

## 线上部署与 UDP 排查摘要（2026-09-28）

- 经用户明确授权，两台部署均更新到已发布的 Rust 0.5.0，保留各自 HTTP 反代、线程和既有更新策略，配置及旧镜像已在对应服务器备份。
- HTTPS、WebSocket READY/PONG 与 TCP 连接检查通过，新增 UDP 端口映射。云端规则调整后，其中一台已确认来自本机和另一台服务器的 UDP 包可到达容器；另一台的公网 UDP 仍待核实。
- 后续客户端直连排查和修复见上节。公开记录不保存实际部署地址、登录账号、密码或具体管理入口。

## 0.5.0 Rust / Android UDP P2P / 心跳延迟（2026-09-28，已发布）

- 用户已授权实施，方案见 docs/RUST_P2P_PLAN.md。Rust 生产服务包含 TCP、HTTP/WS 和 UDP 登记协助，兼容现有 TCP；Java 保留作迁移参考和验证夹具，不进入镜像。
- 安卓双方开局后尝试 UDP 直连，房主分发随机主密钥，方向独立 AES-GCM、64 包防重放窗口、操作去重和有限重试；普通 HTTP/WS 也允许密钥分发。失败中转，服务器心跳和断线判负继续保留。
- 安卓与 Web 增加服务器 RTT；安卓直连成功才显示 UDP RTT，失败隐藏。状态胶囊沿用 iOS 风格，仅更新网络文字。网络接收复用解析对象，网页和 WS 请求避免重复序列化，Rust 广播共用已编码字节。
- Rust release 编译通过；Android assembleDebug / lintDebug 通过（0 errors、9 warnings）。首次集中 Maven 64 项中 63 项通过，修正防重放测试对重复包丢弃行为的错误预期后，定向 UdpSessionTest / RustInteropTest 6 项全通过；最新报告合计 64 项、0 失败/错误/跳过，未为计数重复全量执行。
- Actions Linux 独立完整验证已通过：64 项，0 失败/错误/跳过，2026-09-28 21:15（北京时间）完成测试 job；Rust release 构建通过。镜像发布结果见下方。
- Rust 与实际 Android TCP/WS 混合房间、心跳、同 DID 替换、普通 WS 下 UDP 密钥分发和加密直连、确认超时回退及退房判负的 4 项黑盒检查首次均通过。桌面 JVM 联调不等同真机验证。
- 两台 API 37 模拟器在普通 HTTP 连接下建立直连，双方翻棋；仅阻断客人 App 的 UDP 后均回退中转、隐藏 UDP RTT，继续走子和退出判负成功。临时规则已移除，原服务器设置已恢复，两个本轮模拟器和临时 Rust 服务已停止；原本机 80/8888 服务未动。
- 实际 Rust + 双浏览器的建房/准备/四步翻棋/同步/离开/解散及桌面、手机横竖屏检查通过，服务器 RTT 可见；既有 web-review-smoke 呈现与消息边界检查通过。截图见 docs/VERIFICATION.md。
- Windows 同机、2 工作线程、102 个 TCP 心跳连接、15.01 秒轻载采样：Rust 工作集 8.42 MiB，Java 125.21 MiB，约减少 93.3%；私有内存 2.62 / 116.41 MiB。CPU 太低，无法据此给出吞吐提升倍数；并非 Linux 或容量结果。
- 复核后补正直连时房主无效操作的提示归属：只通知房主，不把错误发给客人；UDP 消息 ID 复用一次 UUID 生成结果；重新 assembleDebug / lintDebug 通过。该项只改客户端，不影响正在发布的 Rust 镜像，也未重复整套联机检查。
- 客户端补充提交 c2de7516c57807be9ef1044fd99938a71d4d7b48 已推送；[Actions 36428520194](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36428520194) test 成功、publish 跳过，验证仅客户端变更不重复打包镜像。
- 最新 APK：android_client/build/deliverables/chinese-chess-flipping-0.5.0-debug.apk，1647415 字节，versionCode 5，v2 调试签名校验通过；SHA-256：E4A45964BD32B7B638AF10595BD8191AF874F724454569EF727FA479C367A098。先前 1647390 字节版本已被替换。
- 服务端业务提交 43534f3005719ace285156471293a58fbc4ff156 已推送 origin/main；[Actions 36427114170](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36427114170) test / publish 均成功，2026-09-28 21:34:05（北京时间）完成发布。latest 与 sha-43534f3 均已匿名核实指向 sha256:83549f17242b6eae2f35d7ff76dc5402453716ecbbd9594db108a31281c0cb6c，包含 linux/amd64、linux/arm64。
- 实际镜像压缩层合计：amd64 984783 字节（0.94 MiB）、arm64 937729 字节（0.89 MiB）；上一版 Java 分别 114146085 / 111189376 字节，约减少 99.1%。解压层 tar 合计分别 1991168 / 1777664 字节。已校验层摘要、ELF 架构与无动态解释器、非 root 用户及 TCP/HTTP/UDP 端口；本机没有 Docker，未在本机运行容器。不能把解压层 tar 大小当作进程内存。
- 未远程部署；原本机服务保留旧版本。公网 NAT、实际 Android 厂商设备、HTTPS/WSS 和长期后台不在本次验证结果内。保留原未跟踪 android_client/gradle/gradle-daemon-jvm.properties；源码、协议与本阶段记录已入库，APK 和构建缓存不入库。

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
