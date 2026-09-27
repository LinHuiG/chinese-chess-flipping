# 0.2.0 验证记录

日期：2026-09-27。功能完成后集中检查；发布结果以 PROJECT_STATUS.md 的最新阶段和 GitHub Actions 为准。

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
