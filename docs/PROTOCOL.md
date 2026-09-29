# 通信协议 v2（0.6.0）

TCP、Android WS 和 Web WS 共用此协议，与 0.5.x 不兼容，服务端和客户端须一起升级。服务器只存运行期用户、房间、最近结算及 P2P 信令；不保存棋面、昵称资料或恢复文件。具体检查结果见 [项目状态](../PROJECT_STATUS.md)。

## 帧布局

大端整数；长度按字节计算。固定头 17 字节，去掉 v1 的 CRC。

| 偏移 | 长度 | 字段 |
| --- | --- | --- |
| 0 | 2 | magic：FC FC |
| 2 | 4 | 整帧长度 TOTAL |
| 6 | 4 | 控制区长度 X：2–4096 |
| 10 | 4 | 正文长度 Y：0–65536 |
| 14 | 1 | version：2 |
| 15 | 1 | kind：见下表 |
| 16 | 1 | flags：0 明文，1 AES-256-GCM；其他值拒绝 |

- 明文：`header(17) | control(X) | body(Y)`，最大 69649 字节。
- TCP 加密：`header(17) | nonce(12) | AES-GCM(control + body) | tag(16)`，最大 69677 字节。
- GCM AAD 为完整 17 字节固定头。认证成功后才解释控制区，序号不匹配或认证失败关闭连接。
- WS 一条二进制消息恰好一帧，flags=0；WSS 的 TLS 在外层。拒绝多余尾部、文本业务消息和超限长度。
- 服务器控制区与控制命令正文是严格 UTF-8 JSON 对象，拒绝重复字段、尾随值。棋局正文不进入服务端 JSON 解析器。

| kind | 含义 |
| --- | --- |
| 1 / 2 / 3 / 4 | TCP 获取公钥 / 服务端 hello / 客户端 hello / 服务端握手确认 |
| 5 / 6 | 客户端确认及身份元数据 / READY |
| 16 | 客户端业务或控制命令 |
| 18 | 服务端控制事件或转发的棋局报文 |
| 32 / 33 | 应用心跳 PING / PONG |
| 48 / 49 | App 版本检查 / APP_VERSION |
| 50 / 51 | App 分块请求 / APP_CHUNK |

不再使用业务请求 TID、BUSINESS_RESPONSE 和服务端转发表；只有 TCP 握手保留 TID。控制命令返回 RESULT 或对应事件，走棋操作由房主确认。

## 接入与身份

TCP 保留 P-256 ECDH / HKDF-SHA256 / AES-256-GCM。hello 为 32 字节随机量 + DER 公钥；握手摘要为三条明文握手帧的 SHA-256。HKDF salt 为双方随机量拼接后的 SHA-256，info 为 `chess-flipping/tcp/v2` + 摘要；72 字节材料依次为客户端发送密钥(32)、服务端发送密钥(32)、对应 nonce 前缀(4+4)。nonce 后 8 字节是从 0 开始的方向序号；达到 0xffffffff 前重新建连。

TCP kind=5 控制区提交 `TID、CHL、protocol:2、userId?、token?、UDP?`，正文为握手摘要；READY 仍回摘要。WS 首帧 kind=5 用相同元数据（不要求 TID），正文为空；READY 控制区/正文均为 `{}`。CHL 允许 ANDROID / WEB / IOS；仅 ANDROID + UDP=1 声明现有 UDP 直连能力。

随后 SESSION 返回：`selfId、token、bootId、resumed、inRoom、udpPort、p2p`。

- 新用户 ID 为随机 128 位十六进制值，token 为独立的两段随机 UUID 拼接；不是可猜的时间编号。客户端本地保留 ID/token。
- 同一进程内有效 ID/token 可接管旧连接。旧代次的读取、输出和关闭回调不得改变新绑定。
- 未知或已过期 ID 分配新用户；已存在 ID 搭配错误 token 拒绝。服务器每次启动生成新 bootId，旧棋局关联全部失效。
- Android 存应用私有 AtomicFile；Web 使用当前标签页的 sessionStorage 支持刷新。网页没有可用存储时仍可作为新用户游玩，不承诺刷新恢复。
- ID/token 只是匿名会话恢复凭据，不是账号系统。普通 HTTP/WS 不保密；自定义 TCP 不验证可信服务器身份，也不提供前向保密。需要可信服务器和链路保密时使用 HTTPS/WSS。

## 在线状态和恢复

每 5 秒发 kind=32，控制区携带 `ping`，服务端 kind=33 原样回控制区，正文 `{}`。客户端约 15 秒未收到有效回应则重连；服务端仅应用心跳刷新用户期限。

- socket 关闭：解绑，状态 offline，保留房间和用户。
- 连续 10 秒无心跳：状态 suspect；连续 60 秒无心跳：退房并删除用户。关闭 socket 不额外延长这 60 秒。
- 重连后为 syncing；取得房主新快照后发 AVAILABLE，变为 online。PRESENCE 携带成员状态，界面灰显失联方。
- LEAVE / DISSOLVE / LOGOUT 是主动操作，立即处理；双方都过期不按扫描顺序给其中一人判胜。
- 正常断线期间计时继续。房主保存私有棋面、判重历史、原 deadline、操作去重结果；恢复时先判定是否已超时。存档损坏或丢失不能重新洗牌续局，按 RESTORE_FAILED 结束。
- Android deadline 使用 elapsedRealtime，覆盖同次设备启动内的 App 重启。Web 存墙钟期限并换算回 performance 时钟；本机时间被手动修改不在可信计时保证内。
- 服务端不存棋盘，不恢复重启前的房间；客户端只在服务器确认原会话仍有效后续局。

## 控制与房间

控制命令 kind=16、控制区 `{}`，正文带 type。返回事件 kind=18、控制区 `{}`。

| 命令/事件 | 内容 |
| --- | --- |
| LIST / ROOMS | ID 游标 after/next，每页最多 64 间 |
| CREATE / JOIN / LEAVE / DISSOLVE | 建房、加入、离开、解散；建房重放返回原房间 |
| ROOM | roomId、name、members、hostId、version、gameId、playing、startId、presence、p2pAvailable、可选 lastResult |
| START | 房主发起，带 operationId；只推进房间状态，不上传完整棋盘 |
| FINISH / GAME_OVER | 房主提供 winnerId/reason；服务器控制退出和过期判负 |
| PROFILE_REQUEST / PROFILE | 客户端重报 name，服务器校验 1–24 字符并转发 userId/name，不存用户名 |
| AVAILABLE / PRESENCE | 同步完成及在线状态变化 |
| LOGOUT / ROOM_CLOSED | 注销匿名会话 / 离房或解散通知 |
| RESULT | request、ok、error，控制命令处理结果 |
| ECHO | 转发无法送达时的 message/failedOperation；不代表操作已经执行 |

房名由客户端默认填写“用户名的房间”，最多 32 字符。version 是房间代次：成员、开局或结算变化时递增；重连不递增。gameId 使用开局时的 version 字符串，避免重复生成编号。状态 seq 和落子 move 由房主维护，用于防止迟到快照覆盖、旧棋面操作及跨路径重复执行。

## 棋局转发

kind=16 的控制区：`type: ACTION|HOST_REPLY|HOST_STATE、roomId、version、operationId?`。ACTION / HOST_REPLY 必须有 32 位操作编号。其余字段编码一次放正文。服务器依据绑定用户检查路由：ACTION 去房主，HOST_REPLY/STATE 只能由房主发给另一个成员；忽略客户端自报 actorId，填入可信 actorId 和当前 gameId，再用 kind=18 转发。

正文最多 48000 字节，作为 Bytes 共享切片移交，服务器不解码 action/state、不重新序列化正文。WS 入站借用已有帧；TCP 原地解密后切片，避免 drain 搬动整段正文。最终封帧、WS 掩码、链路加密与内核收发仍有复制，不能称全链路零拷贝。

本次沿用 TCP/WSS 链路保护及 UDP 现有会话加密，没有增加第二层房间包体加密；TCP 中转仍有外层解密/再加密，普通 WS 正文仍为明文。不宣称服务器无法解密。

客户端每次只挂起一项操作。直连重发、回退中转和恢复存档均沿用 operationId。房主保存最近 128 项结果；MOVE 还必须匹配当前 move。回复包含 targetId、operationId、ok 和 state/error；有效快照带 seq。房主提交结果先写完整本地存档，再回包，避免对方已见新棋面而房主重启丢失该步。

## UDP P2P

保留 CFU1 登记及现有 AES-GCM UDP 会话格式：最长 1200 字节，方向独立密钥和防重放窗口。加密 DATA 内为 `消息ID(16) | v2明文帧`，其中业务操作编号与中转一致；ACK 仅确认 UDP 送达，不能代替房主业务确认。超出 UDP 预算走中转。

协商顺序：P2P_REQUEST → 房主 P2P_OFFER / P2P_KEY → 双方 P2P_CONFIG → P2P_LOCAL / UDP 登记 → P2P_PEER → 双方 P2P_READY → P2P_ACTIVE；失败 P2P_STOP / P2P_RELAY。

- 房主生成 32 字节主密钥，服务器转发但不保存；每方独立登记 token。登记窗口 15 秒，客户端一轮探测 10 秒。
- 每方最多 8 个本地候选，加服务器观察到的反射地址。候选有一个就交换，不等待双方登记齐全。反射源地址改变可更新。
- Android 同一 socket 登记和探测；收集 IPv4 与全局 IPv6，排除 IPv6 link-local/ULA。单候选发送或解析失败不结束整个尝试。
- 服务端当前 UDP 监听 IPv4。IPv6 候选经已有控制连接交换，两端都实际可达时可以 IPv6 直连，不要求服务器 IPv6；没有实现服务端 IPv6 反射登记。
- 网络/地址变化先恢复控制连接，再新建会话重探测；相同网络每局最多两轮，间隔约 3 秒。认证后的多来源入站仍接受，保留先成功的出站路径。
- 诊断只保存最近 20 条原因及计数，可长按 Android“中转/直连”查看；不含 IP、token、密钥或完整用户标识。IPv6/IPv4 打洞均不保证穿过所有 NAT/防火墙。

## App 更新

比较递增整数 versionCode，不比较版本名称字符串。相同版本或客户端版本更高时 available=false，不下载、不降级。服务端固定 APK 与清单在编译前生成，启动时核对哈希和长度；它们是发布资源，不是业务持久化。

- TCP/WS kind=48：控制区 `{type:"UPDATE_CHECK",versionCode:当前版本}`，正文空；kind=49 返回 APP_VERSION JSON 正文，含 available、versionCode、versionName、packageName、size、sha256。
- kind=50：控制区 `{type:"APP_GET",versionCode:目标版本,currentVersion:当前版本,offset:字节偏移}`，正文空。kind=51 控制区为 APP_CHUNK，含 versionCode/offset/size/done，正文为最多 32768 字节 APK 原始切片；一次只请求一块，避免发送队列装满整个 APK。
- 目标版本不符、当前已是最新或偏移越界时，不发 APK，返回 kind=49 的 error。客户端超时、断线或服务器换包后重新检查，不拼接不同版本。
- HTTP `GET /api/app/version?versionCode=N` 返回同一元数据；`GET /api/app/latest.apk?versionCode=N` 返回 APK，已是最新时 204。两者必须携带版本，响应禁止缓存。HTTPS 使用已有反向代理。
- Android 设置中可手动检查，默认首次连接后自动检查。下载只写应用缓存，验证长度、SHA-256、包名、版本和安装签名相同后交给系统安装器；游戏中推迟自动弹出安装。普通 App 不静默安装，首次需允许此 App 安装未知应用。
- Actions 使用固定签名构建 release APK，并生成上述清单后编译镜像。0.5.x 没有此更新功能，首次升级到 0.6.0 需手动安装。

## 源码阅读入口

`main.rs` 配置/监听/统一过期调度 → `net.rs` 握手与 TCP/WS 收发 → `hub.rs` 用户/房间/权限/转发/P2P → `wire.rs` 边界与密码学；`json.rs` 只服务控制消息，`update.rs` 集中处理 APK 版本与下载。六个文件均按功能块补充中文注释，没有新增 Service/Repository/Factory 层。
