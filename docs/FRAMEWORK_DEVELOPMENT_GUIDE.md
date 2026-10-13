# 赛博房间客户端开发指南

2026-10-13，协议 v3 / 客户端 0.8.0。以下 API 对应仓库实际实现。新增 grant/103/201 要求客户端与服务端配套升级。逐个功能号、字段与数据流程见 [接入手册](CYBER_ROOM_INTEGRATION_MANUAL.md)。

## 1 代码放在哪里

| 文件 | 负责内容 |
| --- | --- |
| server/src/main/resources/web/transport.js | 公共帧、连接、请求关联、原样收发、NativeRoom 适配 |
| server/src/main/resources/web/room.js | 游戏与观影共用的房主准入、授权同步、密码、成员、恢复和 UDP 协商 |
| server/src/main/resources/web/game.js | 翻棋规则，暗棋真实身份只在房主 |
| server/src/main/resources/web/miner.js | 矿工规则、种子地图、商店、存档 |
| server/src/main/resources/web/miner-view.js | 原创 Canvas 绘制、动画、音效 |
| server/src/main/resources/web/app.js | 大厅、游戏与观影界面 |
| server/src/main/resources/web/watch.js、voice.js | Emby、播放同步、弹幕及语音控制；网页音频走 AudioWorklet |
| android_client/.../client/GameService.java | 受限本地 WebView、原生 TCP/WS/UDP、设置与 App 更新 |
| android_client/.../client/MediaController.java、VoiceEngine.java | 原生播放器、Emby 请求、采集/解码/混音及系统 AEC |
| desktop_client/src/ | Windows Rust/Tauri 传输、Emby API、原生音频及系统 AEC；内嵌同一网页 |

Android 构建直接把 web 目录作为本地 assets 打包，网页从同一目录提供资源。新增玩法更新这个客户端目录和 APK，不向 Rust 加入玩法分支。App 的包名保持不变，可用原签名覆盖升级。

RoomClient 是通用底座；GameRoom 是当前游戏大厅使用的房主裁判实现。新功能不要求使用 GameRoom 的游戏状态模型：文件共享或观影可以直接组合 RoomClient，自行决定业务是否需要房主裁判。

## 2 接入、创建和查询

以下示例运行在已引入模块的网页或 App 本地页面中。浏览器连接当前网站的 /ws，App 使用设置中的 TCP/HTTP/HTTPS 地址。

~~~js
import {RoomClient, object} from './transport.js';

const FEATURE = 'ecb6a20bc6e24c28be39b3d08104ad5b'; // 为自己的模块生成一次，然后固定
const A = FEATURE.slice(0, 16), B = FEATURE.slice(16);
let self, roomId, hostId;
const members = new Set();

const client = new RoomClient({
  connected(identity, resumed) {
    self = identity.clientId;
    // resumed 只表示恢复了同一服务端身份，不等于恢复了模块业务。
    showLobby();
  },
  message: receive,
  closed: reason => showStatus(reason),
  status: text => showStatus(text)
});
client.connect(); // 收到 connected 之后才能请求房间操作

async function create(name) {
  const created = await client.createRoom({roomType: A, name});
  roomId = created.roomId;
  hostId = self;
  members.clear();
  members.add(self);
}

async function list() {
  // 自动读取分页；每项包含 roomId、name、hostId。
  return await client.listRooms({roomType: A});
}
~~~

showLobby/showStatus 是接入方自己的 UI 函数。恢复 token 自动保存在当前源／服务器配置对应的本地存储。不要把它当作用户账号或模块权限。

## 3 加入房间和房主裁决

~~~js
async function join(selected) {
  const response = await client.joinRoom(selected.roomId, {feature: B});
  const decision = object(response.rawBody);
  if (response.control.from !== selected.hostId || !decision.allowed) {
    await client.leaveRoom(selected.roomId);
    throw Error(decision.reason || '未获房主允许');
  }
  roomId = selected.roomId;
  hostId = response.control.from; // 服务端根据真实连接补充
  members.clear();
  for (const id of decision.members) members.add(id);
}

function receive(message) {
  const c = message.control;
  if (message.kind === 16 && c.op === '102' && c.roomId === roomId && hostId === self) {
    const application = object(message.rawBody);
    // 人数、版本、手动批准或自动批准，都由这里决定。
    const allowed = application.feature === B;
    if (allowed) members.add(c.from);
    client.replyJoin(message, {
      allowed,
      reason: allowed ? undefined : '模块不匹配',
      members: allowed ? [...members] : undefined
    });
    if (allowed) publishMemberList(); // 接入方用 SEND 通知其他获准成员
    return;
  }
  if (message.kind === 64 && c.roomId === roomId && members.has(c.from)) {
    onModuleMessage(c.from, c, message.rawBody, message.rawControl);
  }
  // kind=18/op=104：有人释放通信关联，JSON {roomId, clientId}。
  // kind=18/op=105：房间关闭，JSON {roomId}，清理本地房间状态。
}
~~~

publishMemberList/onModuleMessage 由模块实现。示例仅展示接入；实际模块还要处理退出事件、取消或超时申请、畸形业务消息和恢复。GameRoom 有完整实现可参考。

JOIN 从加入者到服务端，再转给房主，房主回复再返回加入者，共四次发送。RoomClient.joinRoom 返回原始回应，**不会替业务解释 allowed**；GameRoom.join 才把拒绝转为错误并释放关联。若自行使用 RoomClient，申请失败、超时或取消时也应调用 leaveRoom 释放通信关联，并忽略迟到回复。

通信关联在申请时建立，服务端不读取 allowed。所有接收入口必须按房主当前获准集合判断。UUID 后半段用于模块匹配，是公开客户端代码的一部分，不能当作密码。

## 4 发消息给指定成员

~~~js
// 返回 boolean 表示本次是否交给发送链路，不代表远端已执行。
client.sendTo(roomId, targetId, {type: 'chat'}, {text: '你好'});

// 原始字节：不转 JSON，也不转 Base64（WebView 桥接内部另有编码）。
client.sendTo(roomId, targetId, {file: 'F', chunk: 0}, rawBytes);

// 扩展头也可以直接传字符串／Uint8Array，重复行与顺序都会保留。
client.sendTo(roomId, targetId, 'format:raw\ntrace:a:b\ntrace:c\n', rawBytes);

// 指定服务器转发，例如交换直连候选和密钥。
client.sendTo(roomId, targetId, {type: 'peer.offer'}, offer, 'relay');

// 只尝试已就绪直连，不通返回 false。
const sentDirectly = client.sendTo(roomId, targetId, {type: 'input'}, input, 'direct');

// 显式要求服务端入队结果，不把结果等同于对端接收或执行。
await client.request(200, rawBytes, {roomId, to: targetId});

// 离开自己；房主离开会解散。
await client.leaveRoom(roomId);
// 或由房主明确关闭房间。
await client.request(105, {roomId});
~~~

sendTo 默认 path=auto：已建立的 Native UDP 直连优先；当前共享 SDK 只对不超过 1100 字节的完整帧尝试直连，大消息走 SEND。扩展头不可覆盖 op/requestId/roomId/to/from/ok/error/grant。接收回调提供 kind、control、rawControl、rawBody；重复扩展的原始行从 rawControl 读取。

`await client.roomSync(roomId, {locked:true})` 更新锁标记并返回授权快照；只读取时省略第二个参数。`client.broadcast(roomId, [id1,id2], headers, bytes)` 一次提交指定目标，targets 为 undefined 表示全体获准者且排除自己，空数组不发送。通用转发正文由模块解释。原生语音直接使用此协议，不经逐帧 JavaScript/Base64，见 [实现契约](WATCH_ROOM_IMPLEMENTATION.md)。

浏览器目前没有 WebRTC 直连适配，始终用 WS/WSS 中转。RoomClient 本身不自动批准对等端、交换密钥或建立 UDP；当前 GameRoom 在确认成员后负责该协商。新的模块可复用其 discover/setupPeers/peerSignal 流程，或实现自己的传输适配。

基础 SEND 不去重也不做业务确认。GameRoom 的操作使用客户端 messageId：先直连，400 ms 未收到房主确认就经服务器重试；房主缓存最近 128 个结果，防止同次操作执行两遍。矿场快照为 10 Hz，seq 用于舍弃旧快照；这些字段只属于游戏模块。

## 5 Android 与 Windows UDP 适配

原生桥接提供 udpRegister(clientId,ticket,port)、openPeer(JSON配置)、sendPeer(peerId,Base64明文帧)、closePeers。openPeer 参数：

~~~json
{
  "peerId": "对端32位clientId",
  "context": "每次协商新生成的32位十六进制值",
  "master": "32随机字节的Base64",
  "initiator": true,
  "candidates": [{"ip":"192.168.1.2","port":50000}]
}
~~~

两端使用相同 context/master，initiator 值相反。GameRoom 以 clientId 较小方发起，候选与密钥通过 SEND 交换；握手属于客户端，不需要 Rust 新操作号。native-room 事件包含：

| type | 内容 |
| --- | --- |
| udpLocal | candidates：本地 IPv4 候选 |
| peer | peerId、ready、latency（毫秒，仅 ready 时显示） |
| peerPacket | peerId、data（完整明文 v3 帧 Base64） |

RoomClient 将 peerPacket 中可信来源绑定为 peerId。UDP 密钥是 HKDF-SHA256(master, salt=SHA256(UTF8(context)), info=UTF8("cyber-room/udp/v3")) 输出 72 字节；前 32 为发起方发送密钥，接着 32 为响应方发送密钥，最后两个 4 字节为对应 nonce 前缀。

适配器每数据报最多 1200 字节，256 包防重放窗口。原生适配器将完整明文帧拆为至多 900 字节片段，每片仍是统一 kind=64 加密帧；扩展头 transport:chunk、message、part（从 0 开始）、count。每帧最多 32 片，超出后返回失败供调用方中转；共享 SDK 的可靠大消息已更早回退。保留有界重组、过期和单对端发送预算。路径只有在匹配本机探测与地址的回应后才设为可用，任意认证入包不能替换出站地址。

这些分片是客户端实现，不是基础服务器功能。没有逐片可靠 ACK；当前实时快照允许丢失，操作依赖房主确认和服务器重试。文件模块需要自己加入分块确认、校验、恢复和流控，不能仅凭 sendTo 返回 true 就删除源文件。

## 6 继续开发

六人 Emby 直取、实时弹幕、语音与 Windows 已有 0.8.0 实现；需求见 [观影房方案](WATCH_ROOM_PLAN.md)，验证边界见 [执行记录](../PROJECT_STATUS.md)。[早期电影厅草案](CINEMA_ROOM_PLAN.md) 仅作历史参考。

| 模块 | 客户端需要定义 |
| --- | --- |
| 新游戏 | 房间选项、规则、输入和状态同步；是否房主裁判自行决定 |
| P2P 文件共享 | 房主的文件元数据目录、持有者 ID、下载请求、块编号、校验、进度与取消 |
| 直播／同步观影 | 媒体封装、播放器缓冲、时钟同步、弹幕、码率和拥塞处理 |
| Emby | 房主选片并提供播放授权，各端直接从 Emby 取流，客户端同步播放状态 |
| 踢人／加密房间 | 房主更新获准集合、撤销接收权限；需要保密时轮换只发给获准者的密钥 |

文件正文、编码视频块或密文都能直接放进同一帧，单帧正文不超过 64 KiB；更大对象由客户端分块。文件、直播、端到端加密房间和手动踢人 UI 尚未实现。密码房与观影已接入；翻棋／矿工继续由房主按模块、人数和开局状态准入。

网页静态目录运行时读取，新 JS/CSS/素材不改 Rust。APK 仍在服务启动时加载，经新包替换和重启可刷新更新资源；无需修改或重新编译 Rust 源码。当前 Actions 镜像把资源与程序分层，网页/Android 输入变化会重建 APK，未改 Rust 时复用已验证程序。
