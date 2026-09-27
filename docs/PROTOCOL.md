# TCP 二进制加密协议 v1

状态：2026-09-27 本地已实现加密通信、房间、事件推送和房主裁判协议，已完成本地自动检查及双模拟器联调。远端代码及镜像以实际提交和 Actions 结果为准。与原有“换行分隔明文 JSON”及 19 字节二进制包头协议不兼容，两端必须一起更新。

这是应用层加密握手，不是 SSL/TLS。公钥每次连接从网络获取，没有证书或预置可信密钥，所以不提供可信服务器身份认证，不能抵御主动中间人攻击。服务端启动密钥在进程生命周期内复用；若该私钥泄露，已记录的本次进程历史会话也可能被解密（不提供前向保密）。它也不替代用户登录认证。

## 1. 报文布局

所有整数使用网络字节序（大端序）。长度按字节计算，不按字符计算。

| 偏移 | 长度 | 字段 | 含义 |
| --- | --- | --- | --- |
| 0 | 2 | MAGIC | 固定标识字节 0xFC 0xFC |
| 2 | 4 | TOTAL | 整个线上报文长度，包含固定头、Nonce 和认证标签 |
| 6 | 4 | X | 解密后控制头长度；明文握手时是明文控制头长度 |
| 10 | 4 | Y | 解密后包体长度；明文握手时是明文包体长度 |
| 14 | 1 | VERSION | 固定为 1 |
| 15 | 1 | TYPE | 包类型，见下表 |
| 16 | 1 | FLAGS | 0x00 明文握手；0x01 AES-256-GCM |
| 17 | 4 | CRC32 | CRC32 原始 32 位结果，按大端写入 |

固定包头始终为 21 字节，保持明文，以两个固定标识字节 0xFC 0xFC 开始。标识不匹配直接关闭连接，不扫描后续数据重新同步。TOTAL 包含这两个标识字节。FLAGS bit 0 表示加密；其余位保留为 0，首版不启用压缩，不支持的标志直接拒绝。

明文握手报文：

```text
固定头(21) | 控制头(X) | 原始握手包体(Y)
TOTAL = 21 + X + Y
```

加密报文：

```text
固定头(21) | Nonce(12) | AES-GCM(控制头 || 包体)的密文(X+Y) | Tag(16)
TOTAL = 21 + 12 + X + Y + 16
```

- 控制头和包体合并后一次加密，不在密文内部另外插入分隔符。认证解密成功后按 X/Y 拆分。
- GCM 的附加认证数据 AAD 为固定包头的 byte[0..16]。CRC32 字段不纳入 AAD，避免与密文/标签形成循环依赖。
- CRC32 输入为 byte[0..16] || byte[21..TOTAL-1]；不包含 byte[17..20] 自身。先完成加密，再计算 CRC32。
- 接收顺序：校验固定头与长度上限 → 收齐报文 → 校验 CRC32 → 校验 Nonce 序号和 GCM 标签并解密 → 解析控制头及包体。
- X 范围为 2–4096；Y 范围为 0–65536；总包长上限为 69681 字节。无符号长度超过这些范围也会被拒绝，不按对方提供的任意长度分配内存。
- CRC32 只用于报文差错检测。抗篡改由 GCM 认证承担，重新计算 CRC32 也不能绕过 GCM。

## 2. 控制头与包体

控制头为 UTF-8 JSON 对象，字段名区分大小写：

| 字段 | 用途 |
| --- | --- |
| TID | 必填，32 位小写十六进制字符串；响应原样返回。同一握手的所有报文复用一个 TID；每个后续请求生成新 TID |
| CODE | 服务端响应必填整数；0 成功，400 请求错误，413 响应过大 |
| MSG | 错误描述，如 INVALID_JSON；成功时省略 |
| CHL | 客户端加密确认时必填，目前为 ANDROID |
| DID | 客户端加密确认时必填，32 位小写十六进制安装标识 |
| APP | 客户端加密确认时必填，非空包名，最多 256 字符 |
| VER | 客户端加密确认时必填，非空版本名，最多 64 字符 |

DID 使用随机 UUID 去除连字符后保存于客户端私有偏好，不读取手机硬件标识；清除应用数据/重装后会变化。应用备份被禁用，Android 12+ 迁移也排除偏好数据。DID 只用于在线去重，不是账号认证凭据。新连接完成验证后清理同 DID 旧连接，再登记新会话。

包体的编码由 TYPE 决定：

- 业务请求/响应、心跳请求/响应、错误：UTF-8 JSON 对象。
- 获取公钥、交换公钥及握手确认：原始 byte[]，不经 JSON、Base64 或十六进制文本转换。

| TYPE | 十六进制 | 方向 | 包体 |
| --- | --- | --- | --- |
| PUBLIC_KEY_REQUEST | 0x01 | 客户端→服务端 | 空数组 |
| SERVER_HELLO | 0x02 | 服务端→客户端 | 服务端随机数(32) || 服务端公钥 DER |
| CLIENT_KEY | 0x03 | 客户端→服务端 | 客户端随机数(32) || 客户端公钥 DER |
| SERVER_FINISHED | 0x04 | 服务端→客户端 | 握手摘要(32) |
| CLIENT_FINISHED | 0x05 | 客户端→服务端 | 握手摘要(32) |
| READY | 0x06 | 服务端→客户端 | 握手摘要(32) |
| BUSINESS_REQUEST | 0x10 | 客户端→服务端 | JSON 对象 |
| BUSINESS_RESPONSE | 0x11 | 服务端→客户端 | JSON 对象 |
| BUSINESS_EVENT | 0x12 | 服务端→客户端 | 主动事件 JSON；独立生成 TID，不消耗客户端等待请求 |
| PING | 0x20 | 客户端→服务端 | JSON 对象，客户端发送 {} |
| PONG | 0x21 | 服务端→客户端 | {"type":"PONG"} |
| ERROR | 0x7f | 服务端→客户端 | {}，错误码与说明在控制头 |

仅前三种初始密钥交换报文使用 FLAGS=0，其余均使用 FLAGS=1。

## 3. 握手与密钥派生

1. 服务端启动时通过安全随机源生成 P-256（secp256r1）ECC 密钥对，只保存在内存，重启后重新生成。
2. TCP 建立后客户端发送 PUBLIC_KEY_REQUEST。明文控制头只有 TID，包体长度为 0。
3. 服务端返回 SERVER_HELLO，控制头含相同 TID 和 CODE=0；包体为本连接新生成的 32 字节随机数和服务端公钥。公钥格式为 X.509 SubjectPublicKeyInfo DER。
4. 客户端为本连接生成临时 P-256 密钥对和随机数，发送 CLIENT_KEY，控制头只有相同 TID。
5. 双方验证公钥曲线及点，执行 ECDH，再通过 HKDF-SHA256 派生收发方向独立的 AES 密钥及 Nonce 前缀。
6. 服务端发送加密 SERVER_FINISHED；客户端验证成功后发送加密 CLIENT_FINISHED（此时控制头包含 CHL/DID/APP/VER）；服务端验证后返回加密 READY。
7. 客户端验证 READY 后才报告“加密连接已建立”，开放业务发送并启动心跳。

每次 TCP 连接都执行完整握手，不缓存服务端公钥，不包含 MD5 或 SM2/SM4 字段。服务端尚未完成 CLIENT_FINISHED 验证时拒绝一切业务包。

派生细节，所有拼接均是原始字节：

```text
transcript = SHA256(PUBLIC_KEY_REQUEST完整线上报文
                  || SERVER_HELLO完整线上报文
                  || CLIENT_KEY完整线上报文)
salt = SHA256(serverRandom32 || clientRandom32)
info = ASCII("chess-flipping/tcp/v1") || transcript
material = HKDF-SHA256(ECDH共享秘密, salt, info, 72字节)

material[0..31]  = 客户端→服务端 AES-256 密钥
material[32..63] = 服务端→客户端 AES-256 密钥
material[64..67] = 客户端→服务端 Nonce 前缀
material[68..71] = 服务端→客户端 Nonce 前缀

Nonce = 方向对应的4字节前缀 || 8字节大端序号
```

两个方向的序号分别从 0 开始，并包含加密握手报文。首个服务端加密包 SERVER_FINISHED 使用服务端序号 0，READY 使用序号 1；首个客户端加密包 CLIENT_FINISHED 使用客户端序号 0。接收方只接受下一个精确序号；重复、跳号、跨会话报文均拒绝。每方向最多发送 2^32−1 个包，达到限制关闭连接，需重新握手。

服务端启动密钥之外，会话密钥全部按连接隔离。断开时清理会话密钥数组，不在日志中输出密钥。

算法参考：[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)、[Android Cryptography](https://developer.android.com/privacy-and-security/cryptography)。实现使用平台标准 JCA/JCE，不固定安全提供者，也没有新增运行时加密库。

## 4. 业务示例及错误处理

以下仅展示解密后数据，在线上传输的是整体密文：

```json
控制头：{"TID":"0123456789abcdef0123456789abcdef"}
业务包体：{"type":"ECHO","message":"你好，翻棋！"}

响应控制头：{"TID":"0123456789abcdef0123456789abcdef","CODE":0}
响应包体：{"type":"ECHO","message":"你好，翻棋！"}
```

- 业务 JSON 格式错误、未知业务、已建立连接上的不支持包类型：返回加密 ERROR，连接仍可使用。
- 固定头不合法、CRC32/GCM 校验失败、控制头不合法、握手顺序不符、密钥无效、握手后明文包：关闭连接，不继续处理可疑会话。
- 不再发送原有明文 WELCOME；握手完成由 READY 和客户端状态表示。
- TCP 连接超时：客户端 8 秒。握手绝对时限：两端均 10 秒，零碎输入不能延长。
- 客户端每 5 秒发送加密 PING；服务端握手完成后连续 30 秒未收到有效 PING 关闭。业务消息不刷新此期限。客户端连续 30 秒未收到 PONG 或任一请求超过 15 秒未响应会关闭；socket 读超时为 35 秒。
- 客户端最多 128 个等待请求；房主转发每用户最多 8 个，8 秒超时。前台每次连接或握手失败完全结束后等待 3 秒重连，成功回大厅。后台维持已有连接但不重连。
- ECHO 保留供通信检查；房间及棋局业务见下节。无账号和断线恢复棋局。

## 5. 房间与棋局业务

所有业务放在 BUSINESS_REQUEST/RESPONSE 中，服务端事件用 BUSINESS_EVENT。事件也使用有效的随机 TID 和 CODE=0，但不对应客户端请求；响应原样带回请求 TID。

| 请求 type | 主要字段 | 处理 |
| --- | --- | --- |
| LIST | after，可省略，默认 0 | 仅大厅可查；返回 ROOMS、rooms 数组及 next 游标；最多 64 条，next=0 表示结束 |
| CREATE | name | 去首尾空白后 1～32 Unicode 码点，可重名，不允许控制字符；创建者入房 |
| JOIN | roomId | 校验当前用户未入房、房间等待且未满 |
| LEAVE | 无 | 直接由服务端退出当前房间，游戏中判负 |
| DISSOLVE | 房间上下文 | 仅房主，游戏中先按房主认输再解散 |
| ACTION | 房间上下文、action | 服务端关联原发起者和 TID，发 FORWARD 给当前房主 |
| HOST_REPLY | 房间上下文、requestId、ok、state 或 error | 校验房主及仍有效的转发，成功后发布状态，再回复原请求 |
| HOST_STATE | 房间上下文、state | 房主主动同步状态 |
| START | 房间上下文、state，seq=0 | 校验房主、两人成员和等待状态，分配 gameId；发 ROOM 再发 STATE |
| FINISH | 房间上下文、winnerId、reason | 校验房主、本局、胜方成员及正常结束原因；发 GAME_OVER 再回等待 |

房间上下文为 roomId、version、gameId。version 在成员或等待/游戏状态变化时递增；等待 gameId 为空，开始时分配 UUID。身份只能来自当前连接。旧版本、旧本局和失效转发拒绝执行。

常规结果为 RESULT，含 request、ok，失败附 error。错误业务 JSON 和线协议错误沿用上节处理；已解析的房间请求业务错误用 RESULT 返回。

| 事件 type | 内容 |
| --- | --- |
| SESSION | selfId，服务器为本连接分配的临时 UUID；在 READY 之后发送 |
| ROOM | 房间上下文、name、hostId、playing、按加入顺序的成员 ID 数组 members |
| FORWARD | 房间上下文、requestId、actorId、action；actorId 由服务端填写 |
| STATE | 房间上下文及房主公开 state |
| GAME_OVER | 房间上下文、winnerId、reason |
| ROOM_CLOSED | LEFT 或 DISSOLVED，返回大厅 |

公开 state 包含 seq、seconds、ready；棋局中另含 board（32 个整数）、colors（按成员顺序的两种颜色）、turn、remaining（毫秒，-1 为无限）、move、captured、lastFrom、lastTo、winner（-1 为未结束）。正数为红棋、负数为黑棋，绝对值 1～7 对应将士象车马炮兵，0 为空格，99 为暗棋。暗棋真实身份不发送给其他成员；captured 按真实颜色和种类记录，包括误吃己方暗棋。

每个房间版本的 seq 从 0 开始，房主每次生成快照加 1；服务端接受严格大于已接受序号的完整快照，拒绝重复或倒退。允许跳号是为了在转发请求过期、迟到回复被拒绝后，由后续 SYNC 快照恢复，不改变房间版本或 gameId 校验。此规则仅适用于业务快照 seq；加密 Nonce 仍必须严格连续。服务端只保留序号，不保留棋盘或准备详情；开局和后续状态体都必须小于 48000 字节（UTF-8 JSON）。ACTION 的 action.type 包含 READY（ready 布尔值）、TIME（seconds=0/30/60/90）、SYNC 和 MOVE（from、to、move）。from=-1 表示翻棋，move 是行动版本，过期走棋不重复执行。SYNC 不重置计时；改变时间取消准备。

房主以单调时钟统一裁决操作和超时，收到开局 ROOM 后启动计时；动作以房主处理时刻判定是否超时。客户端使用快照剩余时间及本地单调时钟显示倒计时，不每秒广播；显示值受传输延迟影响，最终以房主为准。正常结束原因 TIMEOUT、NO_PIECES、NO_MOVES；服务端强制结束原因 LEFT、DISCONNECTED、HOST_DISSOLVED。

房主移交仅重建剩余成员的等待状态，不迁移进行中的棋局。关闭、退出、替换和超时共用清理流程；迟到旧连接回调不得删除新会话。所有输出加密及发送均在连接 EventLoop 顺序执行。

## 6. 代码与验证

两端保持独立工程，Docker 构建上下文仅为 server/。三个平台无关协议类在两端各保留一份，完整仓库中的 ClientInteropTest 会检查源码完全一致，并在独立类加载器中编译/运行实际 Android TcpClient，与真实 Netty TCP 端口联调。

- 服务端：server/src/main/java/com/chessflipping/server/。
- 协议实现：server/src/main/java/com/chessflipping/protocol/ 和 client/app/src/main/java/com/chessflipping/protocol/。
- Android 网络层：client/app/src/main/java/com/chessflipping/client/TcpClient.java。
- 完整仓库验证：mvn -f server/pom.xml verify，包含协议测试、HKDF 官方向量和 Android 网络代码 JVM 联调。
- 独立 server/ 或 Docker 上下文没有 client/ 时，跳过 ClientInteropTest，其他协议测试继续运行；GitHub Actions 在完整仓库执行互通测试。
- Android 构建与静态检查：在 client/ 执行 gradlew.bat assembleDebug lintDebug。
- JVM 联调不等同于 Android 系统加密提供者、模拟器、手机安装和厂商真机验证。
