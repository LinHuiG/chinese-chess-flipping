# 赛博房间接入手册

> 0.9.0 扩展：READY 能力新增 `room-descriptors`；CREATE(100) 可带最多 2048 字节的 metadata 字符串，服务端不解析；LIST(101) 可省略 roomType 并返回 metadata。插件 SDK 见 [开发指南](PLUGIN_DEVELOPMENT.md)。其余 v3 帧与路由语义不变。

2026-10-14，基础协议 v3，现行客户端/服务端版本 0.8.1。已实现并完成本地 TCP/WS 互通、UDP 帧和转发检查，与旧 v2 不兼容。App 更新接口另见 [协议索引](PROTOCOL.md)。本手册只规定通信基础，不规定游戏、文件、直播或其他客户端业务协议。

0.8.0 增加 ROOM_SYNC(103)、BROADCAST(201) 和 JOIN 控制字段 grant。17 字节 v3 外壳与握手不变，服务端和客户端需配套升级；旧客户端缺少 grant 的批准回复会被拒绝。设计依据见 [广播方案](ROOM_BROADCAST_PLAN.md)，实际跨端接口见 [实现契约](WATCH_ROOM_IMPLEMENTATION.md)。

0.8.1 在 READY 成功正文增加通用能力声明，让客户端在建房、入房前识别不支持 103/201/grant 的旧服；不增加握手消息或业务专用功能号。

## 1 基础服务的边界

Rust 提供九个基础功能：创建、查询、加入、同步授权、退出、关闭、定向转发、指定广播和 UDP 地址发现。房主决定是否允许入房，服务端只记录房主声明的通用路由授权、关联代次与锁标记，不解析裁决正文、密码或玩法。路由授权不代替客户端正式成员及业务权限。

客户端可以自行扩展控制头；转发时保留扩展字段的原始字节和顺序，正文同样原样转发。Rust 不读取 type、messageId、游戏序号、文件偏移、媒体格式等业务字段。普通客户端正文可以用 JSON，大数据直接用二进制。

## 2 固定头和控制区

固定头沿用 17 字节，多字节整数为大端：

| 偏移 | 字节 | 字段 | 含义 |
| --- | --- | --- | --- |
| 0 | 2 | magic | FC FC |
| 2 | 4 | totalLength | 包含加密外壳的整帧长度 |
| 6 | 4 | controlLength | 解密后的控制区长度，0–4096 |
| 10 | 4 | bodyLength | 解密后的正文长度，0–65536 |
| 14 | 1 | version | 3 |
| 15 | 1 | kind | 包类别 |
| 16 | 1 | flags | 0 明文帧，1 原有 AES-GCM 帧 |

明文布局：`header | control | body`，总长 17+controlLength+bodyLength。加密布局：`header | nonce(12) | AES-GCM(control+body) | tag(16)`，额外增加 28 字节，完整固定头作为 AAD。TCP 与 UDP 共用这两种布局和编解码器。先检查长度，再读取和解密；认证成功后才解释控制区。

TCP 按 totalLength 读满一帧，不能假设一次 read 是一包；WS 一条二进制消息对应一帧；UDP 一份数据报承载一帧，数据报负载长度必须等于 totalLength。WS 使用 flags=0；原生 TCP 握手完成后使用 flags=1；UDP 地址登记使用 flags=0，客户端加密直连使用 flags=1。HTTPS/WSS 仍沿用浏览器和反向代理的现有部署。

控制区格式为 `key:value\n`。`\n` 表示一个真实 LF 字节，不是反斜杠加字母 n。例如：

```control
op:200
roomId:R
to:C1
type:my.custom.action
myField:any:value
```

- 每行第一个冒号分隔 key 和 value，其余冒号保留。每行包括最后一行都以 LF 结束，不接受 CRLF 或空行。
- key 使用 ASCII 字母、数字、下划线或连字符，以字母开头，大小写敏感。value 使用 UTF-8，不允许 CR、LF、NUL，不做转义或空白裁剪。基础字段再按各自格式检查。
- 空控制区长度为 0，不写 `{}`。正文紧接控制区，没有额外空行；只依据长度分区。
- 基础保留控制字段是 op、requestId、roomId、to、from、ok、error、grant，不得重复或被客户端用作其他含义。通用投递字段 discard、maxAgeMs 也不得重复。其他字段属于客户端扩展，可重复，原始顺序保留，由客户端自行解释。clientId、token 是接入正文的字段，不额外占用控制字段名。
- 转发器只扫描必要的基础字段，不把扩展字段整理成 JSON 或重新编码。仍检查整体语法、UTF-8 和长度边界；性能收益未做实测。

ID 文本统一为随机 128 位值的 32 个小写十六进制字符，token 为独立随机 256 位恢复凭据的无填充 Base64url。示例中的 R、C1、Q 为便于阅读的占位符。功能号用十进制文本，ok 用 1/0。服务端管理正文是 UTF-8 JSON 对象，客户端转发正文不解析。

## 3 kind 分别表示什么

kind 是“包的大类”，op 是“调用服务端的哪项功能”。客户端可以另用自己的 type 等扩展字段，服务端不解释。

| kind | 名称 | 含义 |
| --- | --- | --- |
| 1 | KEY_REQUEST | 客户端请求开始原有 TCP 密钥协商 |
| 2 | SERVER_HELLO | 服务端发随机量和公钥 |
| 3 | CONNECT | 客户端完成密钥协商，同时申请建立或恢复连接身份 |
| 4 | READY | 服务端返回连接身份建立或恢复的结果 |
| 16 | REQUEST | 功能请求；也用于服务端转给房主的入房申请 |
| 18 | RESULT / EVENT | 请求结果或通知；也用于房主回复入房裁决 |
| 32 / 33 | PING / PONG | 心跳请求和回应，用于测量往返耗时 |
| 64 | PEER_MESSAGE | 对端消息；可以来自直连，也可以是服务端转发 |

与早期草案不同，本版不强制再包一份内层 17 字节帧。客户端的控制头和正文就是消息本身；中转器改外层 kind、补充可信来源，业务部分原样送达。

## 4 三条协商消息，加一条接入结果

继续使用 [wire.rs](../server/src/wire.rs) 与 [net.rs](../server/src/net.rs) 中的 P-256 ECDH → HKDF-SHA256 → AES-256-GCM，不换标准 TLS 库。v3 将客户端 hello 与身份申请合并，删除单独的 KEY_CONFIRM 和后续 CONNECT；四种握手包依次编号 1、2、3、4。以下为当前实现，原生 Java TCP 与 Rust 的四消息握手已互通验证。

| 顺序 | 方向 | kind / flags | 控制区 | 正文 |
| --- | --- | --- | --- | --- |
| 1 | 客户端 → 服务端 | 1 / 0，KEY_REQUEST | 空 | 空 |
| 2 | 服务端 → 客户端 | 2 / 0，SERVER_HELLO | 空 | 32 字节服务端随机量 + P-256 DER 公钥 |
| 3 | 客户端 → 服务端 | 3 / 0，CONNECT | 空 | 客户端协商资料 + 加密的身份申请，布局见下 |
| 4 | 服务端 → 客户端 | 4 / 1，READY | ok；失败时加 error | 成功为 clientId、token、serverVersion、capabilities；失败为 {} |

READY 就是“建立或恢复连接身份”的结果，不是再发起一次握手。客户端收到 ok:1 才进入可用状态；服务端拒绝恢复时返回 ok:0/error:SESSION_EXPIRED。READY 无须再确认，也不代表房主批准入房。协商三条、结果一条，总共四条应用层消息；握手按连接顺序执行，不另加 requestId。

第三条不明文发送对称密钥。沿用 ECDH 时，客户端发送自己的临时公钥，双方派生相同的方向密钥；无需额外传输 AES 密钥。身份申请 JSON：新建为 `{}`，恢复为 `{"clientId":"C1","token":"恢复凭据"}`。0.8.1 READY 成功正文为 `{"clientId":"C1","token":"恢复凭据","serverVersion":"0.8.1","capabilities":["room-sync","room-broadcast","host-grant"]}`。

serverVersion 为展示用字符串，capabilities 为字符串数组：room-sync 表示支持 103，room-broadcast 表示支持 201，host-grant 表示按房主 JOIN grant 维护通用路由授权。客户端检查数组包含全部三项，不以版本号代替能力检查；缺少任意一项时显示“服务器缺少新版房间授权与广播能力，请升级配套服务端后重连”，不发起 CREATE/JOIN，也不恢复房间或探测调用 103。身份握手成功、列表可读取不等于支持新版房间。INCOMPATIBLE_SERVER 是共享客户端本地错误，不是服务端返回的握手错误。原生桥保留 READY 原始正文，不丢弃新增字段。

第三条正文为 `helloLength(u16) | clientHello | nonce(12) | 密文 | tag(16)`。clientHello 是 32 字节客户端随机量加 DER 公钥，helloLength 为这两项的总字节数；密文的明文是身份申请 JSON。这是握手专用混合正文：flags=0 表示不使用整帧加密外壳，身份申请本身仍必须加密。服务端先读客户端公钥派生密钥，认证通过后才读取恢复凭据。

为保留原有摘要绑定，令 P 为第三条从固定头开始、到 clientHello 结束的原始字节，T=SHA256(完整第 1 帧 + 完整第 2 帧 + P)。ECDH 共享秘密作为 HKDF 输入，salt=SHA256(服务端随机量+客户端随机量)，info=UTF8("cyber-room/tcp/v3") 加 T。输出 72 字节依次为客户端发送密钥(32)、服务端发送密钥(32)、客户端 nonce 前缀(4)、服务端 nonce 前缀(4)。第三条的 AES-GCM AAD 使用 P，READY 和后续帧沿用第 2 节的整帧加密格式。

公钥已包含在摘要 T 中，不再添加重复的“公钥摘要”字段。摘要绑定协商内容，不能单独证明服务端真实身份：若没有预先可信的公钥或指纹，攻击者仍可替换公钥做中间人。这是原有自定义握手的限制，缩减消息数量并不解决它。

nonce 为本方向前缀加 8 字节递增计数。第三条使用客户端计数 0，READY 使用服务端计数 0，两边后续各从 1 开始。按原实现检查准确的下一计数，写入统一串行封帧；达到 0xffffffff 前重新握手。新连接重新派生密钥，不能用旧密钥把计数归零。

WS 跳过 1/2，直接交换 CONNECT(3)/READY(4)，flags=0，正文直接使用上面的身份申请/结果 JSON，不套 TCP 协商资料。有效 clientId/token 可恢复身份并替换旧连接；错误或过期凭据拒绝。连接代次留在服务端内部，不增加线上字段。

握手协商资料是二进制，普通接入资料是 JSON。原有自定义握手没有标准证书身份校验，也不承诺前向保密。普通 WS 不保密；现有 HTTPS/WSS 部署不变。默认 TCP 地址继续为 fqgame.tdcode.tech:8888，升级保留设置。

## 5 服务端功能总表

普通请求固定头 kind=16，控制区含 op 和 requestId。JOIN、SEND 的路由字段放控制区，其余管理参数在 JSON 正文。响应 kind=18，控制区为原 op、requestId、ok，失败增加 error；正文为结果 JSON。空参数或空结果用 `{}`。JOIN 的申请和裁决正文属于客户端协议，服务端只透传。

| op | 名称 | 必填参数 | 可选参数 | 成功正文 |
| --- | --- | --- | --- | --- |
| 100 | CREATE | 正文 roomType、name | 正文 locked（布尔，默认 false） | roomId |
| 101 | LIST | 正文 roomType | 正文 after | rooms、next |
| 102 | JOIN 加入房间 | 控制区 roomId；正文为入房申请 | 客户端扩展字段 | 控制区 roomId、from（房主 ID）；正文为房主裁决 |
| 103 | ROOM_SYNC | 正文 roomId | 房主可传 locked、revoke（ID 数组） | roomId、hostId、version、locked、members |
| 104 | LEAVE 退出房间 | 正文 roomId | 无 | {} |
| 105 | CLOSE | 正文 roomId | 无 | {} |
| 200 | SEND | 控制区 roomId、to；正文任意字节 | 控制区 requestId、客户端扩展字段 | 有 requestId 时回 {} 表示入队 |
| 201 | BROADCAST | 控制区 roomId；正文任意字节 | 控制区 to、requestId、discard、maxAgeMs、扩展字段 | 有 requestId 时回 delivered、dropped 入队计数 |
| 210 | UDP_DISCOVER | 正文 {} | 无 | ticket、port |

字段类型：roomType/name 为字符串，roomId/hostId/to/after 为 ID 字符串；rooms 是数组，next 是 ID 字符串或 null；ticket 为 16 个随机字节的 32 个十六进制字符，port 为 JSON 整数。SEND 的 requestId 可省略，不要求每个数据块都等待服务端应答。

### 100 CREATE 创建房间

输入：`{"roomType":"A","name":"房间名"}`。roomType 最多 128 个 ASCII 字节，name 为 1–32 个 Unicode 码点。响应：`{"roomId":"R"}`。

流程：客户端发送 → 服务端创建随机 roomId，把当前 clientId 记为 hostId 并接通其通信关联 → 返回 roomId → 客户端在本地建立房主控制器。服务端不接收功能标识后半段、人数上限、玩法状态或房主审批规则。

### 101 LIST 查询房间

首次输入：`{"roomType":"A"}`；下一页输入：`{"roomType":"A","after":"R0"}`。响应例如 `{"rooms":[{"roomId":"R1","name":"朋友的房间","hostId":"C0"}],"next":null}`；有下一页时 next 为本页最后一项 roomId。

流程：服务端按 roomType 精确查找 → 按 roomId 排序，取 after 之后的一页 → 返回。每页最多 64 条；按房名和标识长度限制，结果保持在正文上限内。客户端自己决定如何展示房间，不返回服务器推算的正式成员人数。

### 102 JOIN 加入房间

这是一个完整的入房调用，不再要求客户端先 ATTACH、再另发 SEND。路由使用控制区，申请正文默认 JSON，例如 `{"feature":"B"}`；feature 是客户端示例字段，Rust 不读取。

| 方向 | kind | 必填控制字段 | 正文 |
| --- | --- | --- | --- |
| 加入者 → 服务端 | 16 | op:102、requestId:Q、roomId:R | 入房申请 |
| 服务端 → 房主 | 16 | 原控制区，追加 from:C1 | 原样申请 |
| 房主 → 服务端 | 18 | op:102、requestId:Q、roomId:R、to:C1、ok:1、grant:1 或 grant:0 | 裁决结果 |
| 服务端 → 加入者 | 18 | 原回复控制区，追加 from:C0 | 原样裁决 |

流程：服务端根据 roomId 找到房主 → 建立临时通信关联并转发申请 → 房主检查后回复 → 服务端核对来源及请求对应关系，按 grant:1 登记通用路由授权及随机 association，或按 grant:0 清理未授权的临时关联，再转回加入者。不自行批准，不读取正文中的 allowed；房主 SDK 保证 grant 与 allowed 一致。未批准的临时关联不能 SEND/BROADCAST 或读取授权快照。转发两方向禁止自带 from，统一追加可信来源；输入控制区最多 4058 字节。

客户端框架的普通裁决正文：允许为 `{"allowed":true}`，拒绝为 `{"allowed":false,"reason":"功能不匹配"}`；allowed 为布尔值、拒绝原因 reason 为可选字符串，其他所需信息由房主在正文或扩展控制字段中补充。服务端不固定这些业务字段，也可透传以后由两端协商的加密正文。

加入者从结果控制区得到 roomId 和可信 from（即 hostId），自己的 clientId 来自 READY；从正文得到 allowed 及房主附带的信息。SDK 可以将这些组成入房结果，但线上不重复加一份 hostId/clientId。ok:1 表示房主回复已返回，客户端必须读取 allowed 才能认定入房成功。

房间不存在、房主不可达或请求超时由服务端返回 kind=18/op=102、原 requestId、ok:0/error，正文 `{}`；这类失败不冒充房主回复。超时和主动 LEAVE 会结束本次请求，迟到回复丢弃；客户端框架未获准时释放通信关联。通信关联不等于正式成员，收信端仍以房主当前授权判断消息是否合法。

### 103 ROOM_SYNC 授权同步

已获准客户端发送 `{"roomId":"R"}`，返回 `{"roomId":"R","hostId":"C0","version":1,"locked":false,"members":[{"clientId":"C0","association":"随机ID","online":true}]}`。members 只含房主明确授权者，最多 16 个通用路由成员；六人限制属于观影客户端规则。短时离线仍保留授权，online 只表示当前连接情况。

房主可附加 `locked:true/false` 更新目录锁标记，或 `revoke:["C1"]` 撤销路由权限；不可撤销自身。参数全部校验后才修改。服务端不接收密码，列表中的 locked 仅供展示。授权变化和锁标记变化增加 version；退出后重新批准会产生新 association。恢复时客户端按快照校对身份与代次，不能把曾经入房当作永久许可。撤权通知使用 op:104、正文含 revoked:true。

### 104 LEAVE 退出房间

输入：`{"roomId":"R"}`。响应：`{}`。

流程：客户端调用 LEAVE → 服务端取消该客户端在此房间尚未完成的入房请求并移除通信关联 → 返回成功，并向房主推送 kind=18/op=104、正文 `{"roomId":"R","clientId":"C1"}` → 房主更新本地成员状态。通知无 requestId。关联已经不存在时可视为已退出；离开不需要房主批准。

只能退出自己，不能把别人的 clientId 作为参数。房主调用 LEAVE 时执行 CLOSE；房主撤销别人的通信权限使用 103 的 revoke。其他客户端也必须停止接受被撤权者的业务消息和 UDP，不依赖被踢者自愿 LEAVE。

### 105 CLOSE 关闭房间

输入：`{"roomId":"R"}`。响应：`{}`。

流程：验证当前 clientId 是登记房主 → 关闭通信资源并释放关联，结束未完成的 JOIN 请求 → 向原关联客户端推送 kind=18/op=105、正文 `{"roomId":"R"}`。通知无 requestId。服务端不生成游戏结算，不转移房主。

### 200 SEND 定向透传

必填控制字段为 op:200、roomId、to。to 是一个目标 clientId；来源由已认证连接确定，不接受调用者提供 from。requestId 可选，只有需要服务端入队结果时才填。

示例 kind=16 的控制区：

```control
op:200
roomId:R
to:C1
type:my.custom.action
myField:any:value
```

正文可以是 JSON，也可以是文件块或任何其他字节。服务端只执行以下流程：

1. 根据当前连接找到发送者 clientId；检查发送者与目标都得到房主对 roomId 的路由授权。
2. 读取 to，找到目标连接；不解读 type、myField 或正文。
3. 将固定头 kind 改为 64，在原控制区末尾追加 `from:真实发送者clientId\n`。原控制区所有已有行，包括 op、to、requestId 和扩展字段，都保持原字节、原顺序。
4. 重新计算外层长度，按目标链路加密并投递。正文逐字节保持原样。
5. 请求携带 requestId 时，另向发送者回 kind=18/op=200 的入队结果。没带则不回入队结果，客户端业务需要确认时自行定义回复。

接收方控制区例如：

```control
op:200
roomId:R
to:C1
type:my.custom.action
myField:any:value
from:C0
```

服务端不会丢掉、改名、补默认值或反序列化客户端扩展字段。为追加来源行，SEND 输入控制区最多 4058 字节，输出仍不得超过 4096 字节；正文仍受帧上限约束。示例 C0/C1 是缩写，正式来源行为 38 字节。

kind=64 明确表示对端消息，即使保留了发送者的 requestId，也不能误当作自己调用服务端的结果。接收方以服务端追加的 from 作为可信来源，再由客户端判断是否准入及业务是否合法。

P2P 使用同类客户端控制头和正文，具体直连适配器可以直接承载 kind=64 帧。来源由认证链路绑定；SDK 交给模块的 from 来自该链路，不能相信对方自报 ID。直连和中转的收消息接口相同，不要求再包一层客户端帧。

没有 requestId 时，目标不可达等投递失败不返回关联结果；需要反馈的调用必须携带 requestId。无论是否有回执，服务端都执行同样的路由和资源校验。入队成功不等于对端已经执行。

### 201 BROADCAST 指定目标广播

kind=16，控制区 `op:201`、`roomId:R`，正文任意字节。省略 to 表示当前全部获准成员，排除自己；`to:C1,C2` 表示逗号分隔名单，重复 ID 去重；显式空 `to:` 表示零目标。指定目标必须全部属于当前授权名单且不含发送者；非法名单整体拒绝，不先发送一部分。原控制字节、正文及可信 from 的处理沿用 SEND，正文不会按目标重编码。

每个接收目标独立尝试入队，离线或慢端不阻塞其他人。有 requestId 时返回 `{"delivered":2,"dropped":1}`，delivered 只表示成功入队，不代表送达、播放或执行。接收端仍收到 kind=64、op:201。P2P 已选择的成员从 to 中排除，剩余成员一次广播；全直连时不发送空广播。

SEND/广播均可带 `discard:1` 和 `maxAgeMs:200`；时间范围 1–2000 ms，必须成对合法。默认可靠投递不带这些字段，或仅带 discard:0。时限从服务端接收时计算，写出前过期会丢弃；不能撤回已经写入 TCP 的字节。客户端还需限制自己的发送队列和播放时效。输出同时绑定发送与接收者的 association，退出/撤权后的旧排队消息不进入重新加入的关联。

当前服务端每连接输出队列 64 项，保留 8 项控制空间；发送者仍受每秒 1,000 次请求及按扇出计费的 4 MiB/s 字节预算限制。无名单广播按最多 16 份保守计费。超额返回限制错误或丢弃无回执请求，不因正常超额直接关闭来源连接；慢端写超时可独立断开。资源限制是当前实现参数，不是服务质量承诺。

### 210 UDP_DISCOVER 地址发现

输入：`{}`。响应：`{"ticket":"登记票据","port":8888}`。发现服务器地址沿用当前服务端地址，port 是它的 UDP 端口，不是对端端口。

流程：客户端通过受保护控制连接取得 ticket → 用将来直连的同一个 UDP socket 发送登记报文 → 服务端读取 UDP 源地址 → 只向申请者控制连接推送 kind=18/op=210、正文例如 `{"ip":"203.0.113.10","port":50000}` → 客户端用 SEND 把候选交给对端。

UDP 登记同样使用第 2 节的 17 字节固定头，kind=16、flags=0，控制区只含 op:210，正文为 `{"clientId":"C1","ticket":"登记票据"}`。这是无需 requestId 的单向登记，观察结果通过上述控制连接事件返回。不再设计 CRD3 专用外壳。ticket 绑定当前会话，有效 15 秒，一次有效登记后消耗；每个会话同时只保留一份有效票据。无效、过期或重复消费的登记丢弃，服务端不在 UDP 上返回大响应。

这只是地址观察，不保证打洞成功。客户端之间的探测、密钥交换、分片和重传由客户端自行约定，全部可以通过 SEND 交换协商信息，不再新增服务端功能号。首版沿用当前 IPv4 发现能力，不宣称已支持 IPv6 反射登记。

## 6 会话和必要约束

PING/PONG 为 kind=32/33，控制区为空，正文例如 `{"pingId":"P","sentAtMs":1000}`，服务端原样回显。沿用 5 秒心跳、最后有效心跳后 60 秒回收会话的基线；宽限内可以凭 clientId/token 恢复，过期释放关联，房主过期则关闭其房间。服务端重启后会话和房间失效。

0.8.1 共享客户端恢复房间时先核对服务端能力，再读取 103 授权快照。网络超时等暂时失败不清除本地房间，在连接仍可用时 3 秒后重试；ROOM_NOT_FOUND、NOT_MEMBER、SESSION_EXPIRED 或返回的 hostId 改变表示原房间已失效。成员重新 JOIN 时被明确拒绝也退出。收到 SESSION_EXPIRED 的失败 READY 后清除旧凭据并重新申请身份；随后重复的原生 closed 通知不得取消已经安排的重连，用户主动 disconnect 则必须取消。

所有恢复和房间操作的异步结果须核对发起时的 roomId、身份、连接代次和本地房间生命周期；离房、换房或更换身份后到达的旧成功/失败结果均不能覆盖或清空新房间。这些是客户端本地检查，不为帧增加字段。媒体播放器及 Emby 结束通知的清理顺序另见 [跨端实现契约](WATCH_ROOM_IMPLEMENTATION.md#媒体与下载)，Rust 不解析该业务正文。

服务端内部需要有界连接数、包大小、速率和排队字节；不把每个内部计数和配额都变成协议字段。慢接收或资源不足时拒绝入队，不无限缓存文件。UDP 分片缓存和拥塞控制由客户端负责。

普通管理请求用 requestId 关联结果。CREATE、LEAVE、CLOSE 可在当前会话短期缓存中返回重复请求的原结果；缓存有界，不提供永久恰好执行一次保证。建房结果不确定时先检查列表，不换新编号反复盲建。JOIN 按（roomId、申请者 clientId、requestId）对应申请与房主回复：相同未完成请求只保留一份，房主处理重试时以当前授权状态答复，不把历史同意当作永久入房许可。SEND 不按 requestId 去重，业务去重由客户端扩展字段决定。

失败响应控制区含原 op、requestId、ok:0、error，正文 `{}`。主要错误包括 INVALID_ARGUMENT、SESSION_EXPIRED、ROOM_NOT_FOUND、NOT_MEMBER、NOT_HOST、TARGET_UNAVAILABLE、TIMEOUT、LIMIT_EXCEEDED、SERVER_BUSY；管理 JSON 格式错误可能返回解析错误文本。非法 TCP 帧或握手关闭连接，非法 UDP 数据报丢弃。

## 7 客户端入房流程示例

JOIN 转发流程固定，申请和裁决正文由客户端框架约定。普通 JSON 示例：

1. 模块使用固定标识 A+B，创建和查询时只提交公开 A；B 不是密码。
2. 加入者调用 JOIN 入房接口，控制区带 roomId、requestId，JSON 正文带 B 及模块需要的信息。
3. 服务端直接向登记房主转发申请，并补充可信 from，房主据此知道申请者是谁。
4. 房主裁决并回复同一个 op=102/requestId，正文是 `{"allowed":true}` 或 `{"allowed":false}`，可以附带客户端所需信息。
5. 服务端把回复返回加入者；客户端取得可信 hostId、房主决定及附带信息，确认 allowed:true 后才显示入房成功。房主在本地维护获准 clientId 集合。

无需额外 JOIN_APPROVE 功能号或 joinId 字段，沿用本次 JOIN 的 requestId。基础服务不要求 OFFER/COMMIT、成员代次、状态序号或传输许可字段。服务端通信关联和房主获准集合使用同一个 clientId；前者用于送达消息，后者才表示正式入房。

文件块、游戏 tick、直播时间戳等都可放在客户端扩展头或正文里，Rust 不读、不改、不校验其业务含义。将来实现 3A 游戏也不为它修改基础功能号。

## 8 TCP、UDP 共用一套包格式

UDP 直接使用第 2 节固定头、控制区和正文，不再套 CFP1 等另一种专用外壳。包格式、kind、控制字段编码和加密布局共用；发送端只选择 TCP、WS 或 UDP 承载。[UdpSession.java](../android_client/app/src/main/java/com/chessflipping/protocol/UdpSession.java) 已实现统一 v3 帧；客户端分片、探测与重组在 UdpPeer.java，具体约定见开发指南。

| 链路 | 承载方法 | 接收处理 |
| --- | --- | --- |
| TCP | 连续发送完整协议帧 | 按 totalLength 处理拆包和粘包 |
| WS | 一条二进制消息一帧 | 检查消息长度与 totalLength 一致 |
| UDP | 一份数据报一帧 | 检查数据报负载长度与 totalLength 一致 |

UDP 地址登记为 kind=16/op=210；P2P 客户端消息为 kind=64，控制头和正文与中转消息使用同样约定。统一格式不要求把服务端 TCP 身份握手原样搬到 UDP：客户端通过已有 SEND 协商对端地址和直连密钥，之后用统一帧收发。服务器 UDP 入口本轮只承担地址发现，服务端消息中转继续走已接入的 TCP/WS 连接。

UDP 默认按 1200 字节负载预算分包（包括本协议头、控制区、nonce 和 tag），遇到更小路径限制再调小；不是把 TCP 支持的 64 KiB 正文直接放进一份数据报。大消息由客户端拆成多个完整小帧，分片标记、ACK、重传、重组、节流和拥塞控制都可通过客户端扩展控制头约定，不增加 Rust 功能号。丢包和乱序不会因为共用格式而消失。[UDP 消息大小与可靠性要求](https://www.rfc-editor.org/rfc/rfc8085.html#section-3.2)

加密 UDP 复用 `header | nonce(12) | 密文 | tag(16)`。直连密钥按对端协商和绑定，不能与客户端到服务端的 TCP 密钥共用后各自从 0 计数。nonce 已含 8 字节加密计数，不必再增加一个基础序号字段；TCP 严格顺序校验，UDP 客户端用重放窗口接受合法乱序、过滤重复密文。业务消息号由客户端另行定义，重加密必须使用新 nonce；不能把同密钥下每包 nonce 固定为 0。[AES-GCM nonce 重用风险](https://www.rfc-editor.org/rfc/rfc5116.html#section-5.1.1)

扩展控制头和正文透传的原则不变：需要哪些业务字段由客户端决定。模块调用示例见 [开发指南](FRAMEWORK_DEVELOPMENT_GUIDE.md)，总体范围见 [方案](GENERIC_GAME_PLATFORM_PLAN.md)。已实现基础服务、App/Web 共用客户端、翻棋和多人矿工；未做公网 NAT、真实大文件/媒体模块或吞吐压力验收。
