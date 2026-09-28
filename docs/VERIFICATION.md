# 验证记录

日期：2026-09-28。功能完成后集中检查；发布结果以 PROJECT_STATUS.md 的最新阶段和 GitHub Actions 为准。

## 0.5.0 Rust 与 Android UDP

- Rust release 构建通过；Windows 可执行文件 1987584 字节（约 1.90 MiB，不能当作 Linux 镜像大小）。生产镜像使用 Rust，Java 保留为对照与验证夹具。
- 首次集中 Maven verify 执行 64 项，63 项通过。唯一失败为测试把已接收序号应直接丢弃误写成必须抛异常；改正后仅定向复查 UdpSessionTest 和 RustInteropTest，6 项通过。最新报告覆盖 64 项且无失败/错误/跳过，不是再次完整执行 64 项。
- 新增检查包含真实 Android TcpClient/WsClient 与 Rust 双向混合房间、心跳 RTT、同 DID 替换、静态资源边界；普通 WS 分发密钥后的实际 UdpPeer 加密通信、1200 字节边界、ACK 超时回退和退出判负；UdpSession 防重放/乱序/篡改/方向与会话隔离；HostController 同操作 ID 不重复走子。
- Android assembleDebug、最终 lintDebug 成功，0 errors、9 warnings。调试 APK 1647390 字节，versionCode 5，签名 v2 校验通过；SHA-256：3808AAE0EF0C1F46650B129DE126A1EC8F681491060C8AB1E8D79DA50CEC0A29。交付路径 android_client/build/deliverables/chinese-chess-flipping-0.5.0-debug.apk，APK 不入库。
- 两台 API 37 模拟器连接临时 Rust 服务，经普通 HTTP/WS 成功进入 UDP 直连，显示约 1–2 ms 的直连 RTT，房主和客人各翻一子。仅在客人模拟器临时阻断该 App 的 UDP，双方自动显示中转、隐藏直连延迟；后续双方继续翻棋，房主退出、客人胜利。该规则已精确移除，原连接设置已恢复，本轮模拟器与临时服务器已关闭。此结果不代表公网 NAT 打洞成功率。
- scripts/web-smoke.cjs 对真实 Rust 服务完成双浏览器房间、准备、无限时、四步轮流翻棋、双方棋面一致、服务器 RTT、手机横竖屏无溢出、离开判负和解散；scripts/web-review-smoke.cjs 的消息边界、发送失败和既有棋盘呈现检查通过。视觉检查后修正网页页脚版本文字为 0.5，没有为文字修改重复联机检查。
- 截图：[Android 直连](screenshots/v0.5/android-direct.png)、[UDP 中断后中转](screenshots/v0.5/android-relay.png)、[Web 手机布局](screenshots/v0.5/web-mobile.png)。界面使用浅色分组与状态胶囊，网络数字变化仅更新文字。

### 同环境资源采样

脚本 scripts/measure-resources.ps1 在 Windows 同机启动 Rust release 与原 Java 参考 JAR，两者 2 个工作线程，各 102 个真实 TCP 加密心跳连接；稳定后采样 15.01 秒。Java 使用 -Xms16m -Xmx128m、SerialGC、16 MiB 直接内存上限、512 KiB 栈。原始日志位于忽略的 server/target/resource-v05/。

| 指标 | Rust | Java |
| --- | ---: | ---: |
| 工作集 | 8.42 MiB | 125.21 MiB |
| 私有内存 | 2.62 MiB | 116.41 MiB |
| 单核 CPU 时间占采样窗口 | 0.000% | 0.833% |

此场景工作集约减少 93.3%。Rust 的 CPU 数值低于该次计时分辨率，不能解释为不消耗 CPU，也不能用它计算吞吐提升倍数。这是轻载短采样，不是压力测试、Linux 内存、最大连接数或真机功耗结论。Linux 镜像的压缩层大小以发布后 OCI 清单为准。

未验证公网不同 NAT、IPv6 直连、多厂商真机、长期后台及公网 HTTPS/WSS。首版 IPv4 打洞失败会中转；重连仍按原规则回大厅。所有远端部署由用户执行。

## 0.4.0 最终提交前复核

用户要求检查后提交推送。修复最终吃子被等待页截断、网页重复棋盘更新和 WS 消息校验问题；减少心跳临时数组、服务端正则编译和 WS 输出重复编码。只对源码中可确认的路径作优化，没有新的性能压测，也没有量化节省承诺。

- 最终 Maven verify：57 项通过，0 失败/错误/跳过，JAR 打包成功，包含双向 TCP / 实际 Android WS 混合联调。
- Android assembleDebug lintDebug：成功，0 errors、9 warnings。
- scripts/web-review-smoke.cjs：实际传输模块的非法 body 拒绝、合法握手与发送失败返回值；Edge/Chromium 隔离呈现的起点/中间/终点、吃子淡出、重复状态、动画开关、减少动态效果、结束清理；确认消息引起的棋盘 DOM 变更为 0；最终吃子在 GAME_OVER / ROOM / 等待 STATE 后仍播放，结算后回等待并清理动画。全部通过，无页面错误。
- 上述脚本需要 Node 和可用 Playwright 浏览器，在根目录执行，使用本地源码路由和隔离状态，不连接或影响已有玩家。没有重复整套手工联机、真机或容量检查。
- 最新 APK 仍为 android_client/build/deliverables/chinese-chess-flipping-0.4.0-debug.apk，1622147 字节，SHA-256：132804776234C9F57CB4B7222C338BCE3273ED7568230D020F8AFD4EBAEFB24E。以下旧大小/hash 为先前构建。

[Actions 36318713210](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36318713210) 已通过 test / publish，镜像对应源码 61a32a5。已确认 amd64 / arm64 清单，摘要见 DEPLOYMENT.md。本地 80 端口尚未更新，公网证书、真机与容器实际运行仍是未验证项。Gradle 启动脚本执行位已恢复为 100755；该文件内容没有变化。

## 0.4.0 跨端检查

后续走子过渡补充：原网页版只有落点缩放，现改为 220 ms 实际位移、280 ms 吃子位移与被吃棋子淡出。使用 Edge/Chromium 的隔离呈现夹具检查起点/中间帧/终点位置、结束清理、重复快照不重播、动画关闭与系统减少动态效果，全部通过；不是新的完整联机/规则回归。JS 语法检查与 `mvn -DskipTests package` 成功。本地服务更新被自动审批拦截，当前 80 端口仍为旧资源，待用户确认重启；尚未发布。

- 服务端 Maven verify 集中检查 56 项全部通过（49 项原有检查、3 组 CHL 握手和 4 项 HTTP/WS 检查），没有失败或跳过。HTTP/WS 覆盖静态资源与私有路径、三种 CHL、分片 HELLO、两端房间转发、PING、非法渠道、同 DID 替换和异源拒绝。
- 随后扩展 ClientInteropTest，将实际 Android WsClient 与 TcpClient 编译到独立类加载器，以 TCP 房主 / WS 客人和 WS 房主 / TCP 客人两种参数执行，定向 2 组通过，覆盖开局、翻棋、时钟、会话替换、房主迁移及清理。没有再重复全量执行，不能将两次计数简单相加成独立测试总数。
- 最终 `mvn -DskipTests package` 成功，打包网页 10 个资源；三个 JavaScript 模块语法检查通过。服务端 0.4.0 的实际 JAR 同时监听 8888 和 80。
- Android `assembleDebug lintDebug` 最终成功，0 errors、9 warnings。期间 lint 曾发现新设置页使用硬编码 ID，已改为系统生成 ID 后复查通过；剩余为工具版本、属性、图标、构造器和文字国际化等提示，不等于全系统兼容验收。
- Playwright/Chromium 双浏览器：创建/加入、计时同步、准备开局、四步轮流翻棋、棋面一致、设置、完整规则、退出判负及解散通过，无页面或控制台错误。手机横竖屏没有横向溢出，布局修正后重查并保存最终截图。
- API 37 模拟器实际安装新版 App，HTTP 连接本机 80 成功；Android 房主与浏览器客人真实联机，通过准备、开局、双方各翻一子、红黑分配、客人退出后 Android 获胜和解散。实际 TCP 与 HTTP 都已连接；HTTPS 分段选择及自动填入 443 已检查，尚未做公网 WSS 连接。
- 以上保留可复现辅助脚本 scripts/web-smoke.cjs、scripts/android-web-smoke.cjs。前者需要 Node、Playwright 和已启动本地服务；后者另需 Windows adb、pwsh，以及已用 HTTP 创建“Android-smoke”无限时等待房间的模拟器。脚本不属于用户端运行依赖。

### 交付与截图

0.4.0 / versionCode 4 调试 APK：android_client/build/deliverables/chinese-chess-flipping-0.4.0-debug.apk，1622112 字节，apksigner v2 验证通过。SHA-256：12229F57171433F4745B12733D30C646F7E5D5CF9AAAE8DA401F39F64C63ACD6。APK、缓存、本机配置不入库，新增 OkHttp/Okio/Kotlin 的许可随包保留。

- [网页桌面大厅](screenshots/v0.4/desktop-lobby.png)、[桌面棋盘](screenshots/v0.4/desktop-game.png)
- [手机竖屏](screenshots/v0.4/mobile-game.png)、[手机横屏](screenshots/v0.4/mobile-landscape.png)
- [Android 与网页实际联机](screenshots/v0.4/android-with-web.png)、[Android 协议设置](screenshots/v0.4/android-settings.png)

设置截图显示待保存的 HTTPS 选择，顶部仍是当时的 HTTP 已连接状态，不能作为 HTTPS 握手证据。模拟器已恢复原 TCP 192.168.0.108:8888 设置。

公网证书/WSS、iOS Safari 真机、多厂商 Android、长时间后台/弱网和新 Docker 低端口配置未验证；本机未进行新的容量压测。网页房主可能被浏览器后台冻结，断线仍判负，不支持无损恢复。当前未提交或推送本阶段代码，现有 latest 镜像不能代表本地 0.4.0。

## 0.3.0 本地检查

本轮先完成 UI、图标、反馈和有明确复现条件的问题修复，再集中检查。该次本地验收时尚未发布；后续 b47535f 已推送，Actions 36313268361 的 test/publish 均成功，最新发布信息见 [部署记录](DEPLOYMENT.md)。

- 修复转发请求过期后房主业务 seq 已增长、服务端仍要求严格连续，导致后续全量快照一直被拒绝的问题。完整快照改为严格递增，仍拒绝相同/倒退版本，仍校验房间版本/gameId；加密 Nonce 规则不变。
- 补齐 START 快照的 48000 字节上限，与后续 STATE 一致；拒绝时不进入对局或广播。通知图标改为透明底单色，避免整块实心色显示。
- Maven test 共 49 项通过，0 失败/错误/跳过：在原 42 项基础上，增加 RoomHub 2 项、HostController 定时 2 项、BoardTransition 3 项。停止占用 JAR 的旧本地服务后，-DskipTests package 成功；本轮没有再次运行全量 verify。
- Android assembleDebug、assembleDebugAndroidTest、lintDebug 最终成功，0 errors、7 warnings。警告为 API 属性、工具版本、v26 资源目录/单色图标提示、自定义构造器及端口数字国际化；API 33 专用图标资源实际含 monochrome。没有把 lint 通过当作全版本兼容通过。
- API 37 单模拟器：竖屏夹具 10 项通过；横屏补充音效加载断言后 11 项通过。等待控件复用、初始/重复/恢复不追播、吃子开始与结束、关闭动画、最后吃子后胜负弹层及三段 SoundPool 资源加载均检查通过。截图包括大厅、等待、棋盘、阵亡角标、设置和胜负页。该测试使用仅存在于测试 APK 的隔离状态夹具，不是本轮双端联机验收。
- 新本地 JAR 以 TCP 8888 启动，新版 App 已实际完成加密连接并进入空大厅。此前 0.2.0 的双模拟器完整玩法验收保留为历史记录；本轮未重复全部人工联机流程，也未听取真机音效。

### 资源与交付

原生 Canvas/ValueAnimator 与 SoundPool，无新增运行时 UI/动画库。翻棋/移动 210 ms、吃子 260 ms、结算 260 ms；只在真实相邻状态变化时播放，停止/退后台释放音效和取消动画。三段 22050 Hz、单声道 16 位 PCM 共 58784 字节，最长 0.65 秒，最多两路播放。倒计时按秒显示，房主计时按截止时间预约，不再 200 ms 轮询；等待页和列表复用控件/版本标记，绘图对象与数组复用。

调试 APK、API 37 x86_64 模拟器、2 核/2 GiB、SwiftShader 软件 GPU，横屏无限时棋盘，夹具最后留出 30 秒静止窗口，在其中取约 3 秒样本：

| 指标 | 本次读数 |
| --- | --- |
| gfxinfo 渲染帧数 | 132 → 132，没有新增帧 |
| top 进程 CPU | 两次均为 0.0%，精度有限 |
| PSS | 68041 KiB，约 66.4 MiB |
| RSS | 213616 KiB，包含共享页，不等于应用独占内存 |

这只是未联网 UI 夹具的静止短测，不代表真实对局/后台心跳功耗、容量、真机帧率或相对旧版节省比例。累计渲染 132 帧中 gfxinfo 报告 24 帧 janky（18.18%），样本混合软件渲染、截图、页面切换和动效，未进行真机帧时间测量，不宣称已达到固定帧率。

交付 APK：client/build/deliverables/chinese-chess-flipping-0.3.0-debug.apk，1051580 字节（约 1.00 MiB），比上一版增加 86293 字节。0.3.0/versionCode 3，调试签名 v2 验证通过；SHA-256：3506F77F0AC5EF4EEB74744A9FBFA7CA5BFD20275B3A8D644B651038EA660BB1。测试 APK 不作为用户安装包交付。

### 本轮截图

- [竖屏棋盘](screenshots/v0.3/game.png)
- [等待页](screenshots/v0.3/waiting.png)
- [胜利弹层](screenshots/v0.3/victory.png)
- [横屏棋盘](screenshots/v0.3/landscape.png)

以上为 UI 夹具画面，不是用户实际对局结果。实机听感、各厂商省电策略、Android 全版本与长时间弱网未验收。以下为 0.2.0 历史记录。

## 0.2.0 历史检查

## 自动检查

| 检查 | 结果 |
| --- | --- |
| GameEngineTest | 8 项通过：初始数量/定色、普通吃法矩阵、车马炮特殊吃法/暗棋、重复棋面、胜负/计时、随机局不变量 |
| KeyExchangeTest | 4 项通过：密钥交换、派生和握手校验 |
| ProtocolTest | 21 项通过：拆粘包、限制、CRC/GCM、Nonce/会话、握手、非法通信、仅有效 PING 延长心跳期限 |
| RoomHubTest | 5 项通过：并发入房、同 DID 替换/旧连接关闭、转发权限/旧消息、房主转移、清理/分页/解散顺序 |
| ClientInteropTest | 4 项通过：编译实际 Android 网络/房主源码，以真实 TCP 与 Netty 联调，包括房间、开局、翻棋、超时和断线 |
| Android assembleDebug lintDebug | 成功；Lint 0 errors、7 warnings，主要为版本提示、适配属性提示、构造器和文本国际化提示 |

本地 Java 21、Windows 环境的最终 Maven 测试合计 42 项，0 失败、0 错误、0 跳过。该次 verify 的测试阶段成功，后续 Spring Boot repackage 因测试服务器占用同名 JAR 而失败；停止该进程后，执行 -DskipTests package 成功，并以新包重新启动完成联调。CI 将在干净环境再次执行完整 verify。

后续 CI 核实：代码提交 5a165bf 的 [Actions test 作业](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/36308099105) 已完成并成功，完整 Maven verify 在干净 Linux 环境通过。镜像发布状态另见部署文档。

Android 调试包为 client/app/build/outputs/apk/debug/app-debug.apk，版本 0.2.0、versionCode 2。未创建或提交正式发行签名。独立 server/ 构建缺少 client/ 时按设计不运行 Android 源码相关检查。

APK 大小 965287 字节，SHA-256：04DBB9E80A6826B576F6030C424FC77744A68AF7B54C2A2A0E16C0C140777028。

## 双模拟器联调

本机原无设备，已安装 Android 17/API 37 Google APIs x86_64 系统镜像并建立 ChessFlip37、ChessFlip37Guest。每台 2 GiB 内存、2 核，通过 WHPX 和软件 GPU 运行。App 内配置 10.0.2.2:18888，连接本机 Java 服务。

- 连接权限、设置页保存地址/端口、大厅创建/刷新/加入、两人准备、房主选择计时。
- 随机先手与首次翻棋定色、轮流翻棋、实际走子吃子、两端棋面同步。
- 棋盘左右红黑阵亡栏初始灰显；发生红方马和黑方卒阵亡后，对应图标点亮且各显示数字 1。另一次对局确认马斜向吃子及炮阵亡。
- 大厅、等待页与游戏均有右上角规则入口，规则内容可滚动查看。
- 1080×2280 竖屏和 2280×1080 横屏。横屏将对局信息与操作置左，棋盘仍为竖向 4×8，避免顶部信息挤压棋盘。
- 30 秒实际倒计时到期：双方显示相反胜负结果，回等待页且都未准备，可再开局。
- 游戏中客人退出：房主获胜并回未准备等待状态；房主随后解散：回大厅并删除空房。
- 房主 App 退后台并锁屏约 2 分钟；另一台仍可操作，房主恢复后状态一致。
- 本地服务停止再启动：两台自动重连并回大厅，旧房间/棋局不恢复。

以上是模拟器上的有限场景验证，不等于真实手机厂商策略、全部 Android 版本、长时间 Doze 或弱网环境已经验收。

验收后已关闭两台测试模拟器和本地 TCP 服务，避免继续占用资源；虚拟设备配置、APK 和截图保留。需要继续联调时按 README 启动本地服务和已有虚拟设备。

## 界面记录

- [大厅](screenshots/lobby.png)
- [等待页](screenshots/waiting.png)
- [棋局与双方阵亡角标](screenshots/game.png)
- [规则弹窗](screenshots/rules.png)
- [横屏棋局](screenshots/landscape.png)

截图中的局域网地址仅用于本地联调；未修改新安装 App 的默认 hgame.tudoucoding.tech:8888。

## 资源短测

条件：Windows、Java 21.0.7、2 个 Netty 工作线程，JVM 参数为 -Xms16m -Xmx128m -XX:+UseSerialGC -XX:MaxDirectMemorySize=16m -Xss512k。

使用 ResourceProbe 建立 100 个真实加密 TCP 连接，每 5 秒发送心跳、持续 8 个周期；另有 2 个模拟器连接。稳定阶段前后确认 102 个已建立连接，采样 15.02 秒：

| 指标 | 采样值 |
| --- | --- |
| 工作集 | 124.4 MiB |
| 私有内存 | 115.0 MiB |
| 进程 CPU 增量 | 0.046875 秒，约一个逻辑核的 0.31% |
| 线程数 | 18 |

探针正常完成，未观察到连接错误。该结果只反映本机心跳/大厅轻负载，不是峰值、最大容量、真实对局吞吐、Linux 容器测量或优化前后对比。JVM 最大堆 128 MiB 不等于进程或容器总内存。

已采取小型 Netty 堆缓冲池、有限待处理请求/输出队列、按到期时间检查心跳、房间列表分页与索引清理；不保存服务端棋盘、不做每秒全房广播。客户端展示倒计时不产生每秒网络请求。

## 未验证边界

- 厂商真机、Android API 26 至 36 逐版本运行、长时间锁屏/省电/进程回收、复杂弱网。
- 公网服务器实际部署、Linux 容器运行资源和大规模连接/对局容量。
- 本机没有 Docker；镜像的多架构构建由 Actions 完成，发布成功与否单独核实。
- 自定义加密协议没有可信服务端身份认证，无法抵御主动中间人；房主为裁判，不防修改客户端作弊。没有账号、持久化、历史对局恢复。
