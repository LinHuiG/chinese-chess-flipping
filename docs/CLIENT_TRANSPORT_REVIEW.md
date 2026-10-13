# 客户端与传输优化待办

> 0.8.0 实施状态（2026-10-13）：R1 通过房主声明授权及关联代次快照修复；R2 取消旧重连；R3 关键回执可靠中转；R4 匹配挑战与来源后选路；R5 以大消息回退中转和有界分片规避，未实现可靠 UDP。O1–O4 已减少重复序列化/快照/存储，O5 已按活动模块调度高频时钟，其他性能候选按测量需要保留。语音改为原生快速路径，普通游戏消息仍使用 Base64 桥。验证边界见 [执行记录](../PROJECT_STATUS.md)，下文保留原问题证据，不代表修复后现状。

2026-10-13，基于代码提交 `c07c047`，续接文档提交 `8e19612`；讨论定稿补充 Windows、语音和生命周期接入事项。用户要求只分析、记录并推送，后续另开线程实施。本文件中的问题和优化均未修复，不改变现行 v3 协议。新增界面、密码、观影与桌面需求见 [观影房与 Windows 客户端实施方案](WATCH_ROOM_PLAN.md)。

处理顺序建议：先保证恢复、退出和操作回执正确，再减少重复传输与复制，最后根据测量决定是否调整协议。不要为了“零拷贝”引入更复杂的通用框架。

基于最新 `d2c70cc` 的独立源码复核、相对复杂度和新增六人语音包率/队列缺口见 [新增待办评估](TODO_ASSESSMENT.md)。评估不代表问题已修复。

后续用户将语音调整为成员 UDP 单播互连，新增可指定成员的通用服务端广播作为中转，详见 [广播与互连方案](ROOM_BROADCAST_PLAN.md)。该调整消除旧星形方案集中在房主的发送压力，R1–R5、广播授权及慢端队列边界仍需处理。

## 需要先处理的正确性问题

### R1 房主恢复后出现幽灵成员

房主离线期间，成员 LEAVE 或会话过期后，Rust 已删除通信关联，但给离线房主的通知会丢失。`GameRoom.connected` 只检查房间存在，继续发布旧名单，可能拒绝新成员并提示房间已满。

用户要求恢复后重新取得 Rust 端成员状态。当前 Rust 的 routes 是通信关联，JOIN 裁决前就会加入，不等于获准名单；现有正式成员仍在客户端。实施时需明确正式成员、待审批、拒绝、暂时掉线、退出与过期的状态契约，避免直接把 routes 作为正式名单。此要求与历史“服务端不管理正式成员”的边界存在调整，具体接口留待实施线程，不预定功能号。

入口：`server/src/hub.rs` 的 `join`、`leave`、`event`、`expire`；`server/src/main/resources/web/room.js` 的 `connected`、`joinRequest`。验收：离线期间离开或过期者不再占座，仍有效的掉线成员可恢复，未获准者不自动入房，快照与增量事件不会互相覆盖。已有真实 GameRoom 方法加模拟目录/缺失通知的定向复现，未做完整网络端到端复现。

### R2 主动断开仍触发自动重连

`RoomClient.disconnect` 调用 `finish` 时，如果已经处于重连等待窗口，`finish` 提前返回，未清理 retry。旧回调随后调用 `connect`，再次将 enabled 设为 true。应在主动断开时无条件取消 retry，并在重试回调执行前检查允许重连的状态与连接代次。

入口：`server/src/main/resources/web/transport.js` 的 `disconnect`、`finish`、`connect`。已有真实 RoomClient 方法与可控定时器的复现。验收覆盖等待期应用内主动断开、切换服务器和之后再次主动连接。最新要求移除 App 常驻通知，其断开动作及前台服务启动入口同步清理，不再将通知栏断开作为保留功能。

### R3 经中转重试的操作仍通过失效 UDP 返回

客人 `action` 首发 auto，400 ms 后经 relay 重试；房主 `hostAction` 的回执仍使用默认 auto。在客人到房主可达、房主到客人的 UDP 单向失效时，房主已执行动作，中转重试也已到达，但回执和状态继续走失效 UDP。客人 5 秒后报超时，静态棋局可能一直停留在旧状态。

用真实 GameRoom、可控定时器与模拟丢包路径复现：房主执行次数 1，房主 move=1、客人 move=0，两个回执都选择 auto，客人最终超时。不是实际公网 UDP 验收。

入口：`room.js` 的 `action`、`hostAction`，`transport.js` 的 `sendTo`。建议让中转重试获得中转回执，或对关键命令建立可靠的确认策略；沿用 messageId 去重，不能重复执行。删减回执快照时必须保留丢包后的状态修复能力。还需避免本地入队成功被当作对端已经收到。

### R4 UDP 路径可能被未经双向验证的地址替换

`UdpPeer.receive` 收到任意通过认证的包就执行 `peer.remote=address`，随后才区分 ping、pong 或业务包。另一个候选地址只证明能向本端发送，也可能覆盖已有可用出站地址；旧 pongAt 尚未过期时仍会显示 ready。

这是源码确认的路径选择风险，尚未用真实 NAT 网络复现。建议探测响应回原地址，业务出站优先选择经过对应探测验证的路径；切换候选后重新判断可用性。不要恢复到只允许接收单一来源地址的限制。

入口：`android_client/app/src/main/java/com/chessflipping/client/UdpPeer.java` 的接收循环、`tick`。定向验收用两个候选，其中一个只能单向到达，确认业务不会被切到不可用路径。

### R5 大帧分片数量超过 UDP 防重放窗口

`UdpPeer` 每片约 900 字节，允许最多 80 片；`UdpSession` 只接受最近 64 个序号的乱序包。使用现有 Java 协议类，将 65,536 字节正文对应的 73 片全部逆序交付，结果为 64 片接受、9 片拒绝，模拟网络没有丢包。该结果说明极端乱序边界，不代表一般公网必然失败，也不是 AES-GCM 错误。

入口：`UdpPeer.send`、分片重组；`android_client/app/src/main/java/com/chessflipping/protocol/UdpSession.java` 的 `decrypt`。优先让较大可靠消息走中转，或明确限制直连帧大小；若需要大帧 UDP，再统一规划有界乱序窗口、分片超时、重传与拥塞控制。不能关闭防重放，也不能把只扩大窗口写成已经获得可靠传输。观影视频直接取自 Emby，无需解决电影经此分片传输的问题。

## 优先减少重复状态与序列化

| 待办 | 当前证据 | 建议与验收方向 |
| --- | --- | --- |
| O1 减少全量快照 | `room.js publish` 对每位成员分别 JSON 编码；矿工快照包含静态物体属性、成员和持续变化状态 | 相同广播正文只序列化一次。先去重复发送，再评估模块内静态数据与动态数据分开；保留加入、重连和丢包后的全量同步 |
| O2 减少动作重复快照 | 三人矿工一次客人动作产生两个 state，再向操作者回复一个完整 snapshot | 明确状态确认序号与补同步规则后缩减回执；不得破坏 R3 的恢复路径 |
| O3 降低本地存储写入 | 客人每次 `apply` 都 `checkpoint`，连不断变化的 room.seq 也持久化；10 次样例 apply 产生 10 次 localStorage 写入 | 持久化真正影响恢复的身份和房间字段，合并写入；不要每帧存瞬时进度。保留退出、后台和断线时必要存档 |
| O4 复用存档序列化结果 | `saveMine` 调用 `engine.save()` 后，`checkpoint` 又调用一次；矿工 save 内部深复制 | 一次构建存档供必要的保存入口使用；验证读取方不会修改共享对象 |
| O5 降低空闲唤醒 | GameRoom 在大厅和棋局也始终执行 33 ms tick；UDP 已连通与失败候选均以约 600 ms 周期处理，失败 offer 还会反复重建 | 游戏需要时才运行高频时钟；区分发现、稳定连接、失败退避；不要删掉必要保活。后台、断线和恢复要能重新启动 |
| O6 减少绘制临时对象 | `miner-view.js` 平滑插值按物体/帧创建对象与字段集合 | 先用采样确认 GC/掉帧占比，再改复用结构。已有背景缓存、DOM 缓存与隐藏时停止绘制，应保留 |

定向样例：GoldMine 种子 42、三位玩家、关卡 1/500/1000 的快照正文约为 6,040 / 10,021 / 10,396 字节。若按每秒 10 次、两位接收者估算，仅正文约 118–203 KiB/s；实际实现受 33 ms tick 和 `>100 ms` 条件影响，不保证恰好 10 Hz。此处是序列化体积和计算结果，不是网卡带宽或 CPU 基准，不包含包头、加密和重试。

同一动作的样例正文为 state 6,012 字节、state 6,012 字节、reply 6,035 字节；客人连续 10 次 apply 写入共 5,860 个字符。没有测量设备磁盘耗时、闪存写放大或续航收益。

## Android 复制与桥接

`WireProtocol.decode` 复制整帧，`Frame.payload` 再复制；`split` 分出 control/body 后，`Packet` 构造器再次 clone。输出也经历 control/body 合并、加密结果分配、nonce 合并和外壳合并。可先明确数组所有权，让内部解码使用带偏移的视图或一次性移交缓冲区，减少重复防御性复制；公开可变数组不能直接取消所有保护。

`SecureSession` 与 `UdpSession` 可共用少量 AEAD/缓冲辅助逻辑，但 TCP 的严格递增与 UDP 的乱序防重放必须分别保留。JCA `Cipher` 提供输入偏移与调用方输出缓冲区的重载，可评估一次输出分配；实际 Provider、线程归属和 nonce 更新仍需核对，不能跨线程共用可变 Cipher。[Android Cipher API](https://developer.android.com/reference/javax/crypto/Cipher)

`GameService` 当前把完整协议帧转为 Base64，通过 JSON 和 evaluateJavascript 送到页面，页面发回时再解码、拆帧与重打包。Base64 本身把 n 字节编码为 `4 × ceil(n/3)` 字符，还增加字符串转换和两侧分配。优先减少帧重组次数；二进制桥接作为后续候选。

AndroidX WebKit 提供 ArrayBuffer 消息能力，但需要检查 `WEB_MESSAGE_ARRAY_BUFFER` 是否受当前 WebView 支持，并保留兼容路径及可信页面来源检查。当前工程没有这套二进制桥接，不能把引入后描述成进程边界也零拷贝。[WebMessageCompat](https://developer.android.com/reference/androidx/webkit/WebMessageCompat)

## Rust 与协议精简

| 待办 | 入口 | 处理建议 |
| --- | --- | --- |
| O7 去掉散列前的整段拼接 | `server/src/hub.rs handle` 的 `[op, body].concat()` | 分次更新 SHA-256。对没有写入 memo 的 op 是否省略散列，要先保留 requestId 冲突校验语义 |
| O8 去掉更新元数据往返 JSON | `server/src/update.rs chunk` 生成 JSON 字节，`server/src/net.rs process` 再解析为 Value 并转 KV | 直接返回结构化元数据或最终控制头，统一客户端旧 type 字符串与 kind 映射，删除失效注释；APK 字节继续保持二进制 |
| O9 优化目录翻页起点 | `hub.rs command(101)` 对 BTreeMap 每页从头 filter | 用 after 对应的 range 起点，保持房间类型筛选与分页语义；没有规模证据前不加索引层和分片架构 |
| O10 优化 APK 分块等待 | AppUpdater 当前 32 KiB 一问一答 | 100 ms RTT 下仅按等待估算上限约 320 KiB/s。后续可小窗口流水线，或使用已明确配置的 HTTP 下载地址；不能从 TCP 8888 猜 HTTP 端口 |
| O11 清理无效字段与回调 | `room.js connectedNow`、`lastSeen` 只写不读；TcpClient.Listener 部分默认回调无调用方实现 | 核对所有引用后删除死状态或把它接入实际功能；保留 TCP/WS 两实现需要的 GameConnection 边界 |

Rust 已对 TCP 密文原地解密，再把原始 Vec 转为 Bytes 切片；正文转发共享 Bytes，APK 启动快照的分块也使用 slice。`Bytes.clone/slice` 可共享底层存储，但向不同 TCP 会话发出时仍需按各自密钥和 nonce 加密。不能把一个连接的密文直接转发给另一个连接，也不能把端到端路径称为完全零拷贝。[Bytes 文档](https://docs.rs/bytes/latest/bytes/struct.Bytes.html)

后续若测到接收分配/清零占比显著，可再评估安全的 BytesMut/read_buf 接收缓冲策略。不要先引入 unsafe、全局缓冲池或复杂租借体系。全局 Hub 锁、过期扫描与静态资源读取也属于测量候选，本轮没有证据认定它们是主要瓶颈。

现行 17 字节外壳的总长、控制长度、正文长度存在可推导冗余，但少一个 4 字节字段对 6 KB 快照只节省约 0.07%，还会影响 Rust/Java/JS 三端兼容。建议先保留 v3 外壳。kind、op 和客户端 type 分别表达帧类别、基础功能和模块消息，不应只因层数而删除。观影相关字段放模块正文或扩展控制区，不增加服务端电影/弹幕/语音专用指令。

控制命令、最新状态、语音和下载的排队需求不同。保持已有有界队列与背压；实时状态可在客户端合并为最新值，过期语音可丢弃，可靠命令要确认。不要仅扩大队列，也不要让 Rust 解析玩法 type 来决定丢哪个快照。UDP 的可靠性和拥塞处理边界参考 [RFC 8085](https://www.rfc-editor.org/rfc/rfc8085.html)。

## 观影与 Windows 接入时需同步处理

以下为定稿方案的代码接入检查点，均未实施。继续使用自有协议与现有中转，不再沿用早期 WebRTC/TURN 建议。

- `room.js message` 当前对正文统一调用 `object(m.rawBody)`；音频接入前区分 JSON 模块消息与二进制音频，底层 rawBody 的字节能力可以复用。语音不能照搬游戏动作重试与全量快照回执。
- `transport.js` 依赖同步 `NativeRoom.settings()` 和 `sendPeer()` 返回值；Windows Tauri 的异步调用需要薄适配层，明确入队与送达的区别。用实际能力协商代替 `!!native` 推断 UDP/音频能力，普通网页仍走 WS 中转。
- 原生端高频音频尽量在原生层采集、编解码和传输，避免逐包通过 Base64/JSON 与 UI 回调。客户端在发送前丢弃过期音频并限制积压；已经进入 TCP 字节流的内容无法撤回，先实测弱网表现再决定是否增加通道复杂度。
- `MainActivity` 与 `GameService` 的 startForegroundService/startForeground、通知更新和权限路径需一起调整。移除通知不等于继续使用无通知的前台服务；后台与锁屏按已确认规则暂停、闭麦和恢复，不误发 LEAVE。
- 密码锁标识属于公开目录元数据；准入与 Emby 播放授权只交给获准成员。R1 恢复流程需保留有效身份，修改密码不能使现有成员的有效恢复失效。

## 本轮验证范围与接续顺序

本轮扩展分析只有源码阅读、JS 离线模拟和 Java 协议类定向检查。为 R5 单独编译现有 WireProtocol、KeyExchange、SecureSession、UdpSession，并在本机运行分片乱序样例；生成物留在忽略目录 `server/target/review-20261013/`，不是 Android App 编译。R3 与快照/存储样例使用真实 JS 类加模拟传输，没有新增业务源码或正式测试文件。

更早的拉取分析已运行一次 `node scripts/client-test.mjs`，四组既有检查通过；本轮未重复运行。未做 Rust 构建、全量 Android 构建、实际 UDP 弱网、真机、CPU/内存压测、Windows 构建或 Emby/语音联调。R4 仍为待验证的源码风险。讨论定稿只更新文档并核对一致性、链接及 Git 差异，没有增加功能验证结论。

后续建议按 R1/R2/R3、R4/R5、O1–O4、Android 复制、Rust 小范围简化的顺序处理。每个阶段只做相应定向检查；是否开展完整验收由后续实施任务决定，不把本清单作为本轮自动修复授权。
