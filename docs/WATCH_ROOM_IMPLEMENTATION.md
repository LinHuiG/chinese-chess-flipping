# 观影房跨端实现契约

2026-10-14，本文记录 0.8.1 三端共同使用的接口，包括旧服能力检查、恢复和异步媒体清理修复。实际验证与打包结果以 [执行记录](../PROJECT_STATUS.md) 为准。业务规则见 [观影方案](WATCH_ROOM_PLAN.md)，通用投递边界见 [接入手册](CYBER_ROOM_INTEGRATION_MANUAL.md)。

## 分工

- 服务端与共享网页：`server/`、`scripts/client-test.mjs`。
- Android：`android_client/`。
- Windows：`desktop_client/`。
- 主线程：根文档、发布工作流、打包脚本、跨端测试及整体验收。

开发期间不同时编辑别路文件，不提交本机 SDK 配置、密钥、构建缓存或二进制产物。版本统一为 0.8.1，Android versionCode 为 14。工作分支为 `codex/watch-room-implementation`。

## 服务端能力与恢复

READY 成功正文除 clientId、token 外，新增 `serverVersion:"0.8.1"` 和 `capabilities:["room-sync","room-broadcast","host-grant"]`。原生 TCP/WS 桥原样透传正文，不改变 v3 外壳及原有握手。版本号仅供说明；共享客户端必须检查三个能力均存在，缺少任意一项时，在创建、加入或恢复房间前提示升级配套服务端，不发送 CREATE/JOIN/ROOM_SYNC。旧服仍可能完成身份握手并提供列表，这不表示可使用新版房间功能。

恢复时网络超时等暂时失败保留当前房间，连接仍可用时每 3 秒重试；ROOM_NOT_FOUND、NOT_MEMBER、SESSION_EXPIRED 或房主标识改变才视为原房间失效。重新申请入房被房主明确拒绝时退出。每个异步操作绑定发起时的 roomId、身份、连接代次和本地房间生命周期，旧恢复、登录、搜索或播放器结果不能修改后来的房间。离房关闭片源对话框、清除本地授权和录音状态，迟到的麦克风许可须立即释放；未建立房间与身份时不能判定为房主。

## 原生语音控制

共享界面通过 NativeRoom 发控制，逐帧音频在原生层处理，不经 JavaScript/Base64 回环。Windows 同名接口可以异步，页面必须处理真实的返回结果。

| 接口 | 参数与语义 |
| --- | --- |
| voiceConfigure | JSON：roomId、selfId、获准接收成员 members（ID 数组）、当前 directTargets（ID 数组）、enabled、codec；首版 codec 为 ima-adpcm-16k-v1 |
| voiceMicrophone | 布尔值；请求开关麦克风，成功与失败以原生状态事件反映 |
| voiceStop | 停止录音、播放和本次房间音频状态，清除旧帧 |
| voiceStatus / peer 事件 | 实际能力/采集状态及可用时的 loss、jitter、queuedMs 等质量统计；不把入队等同送达 |

首次接入、退后台、离房和恢复时均保持麦克风关闭，不能把历史开麦设置作为恢复后自动采集授权。语音收发能力与 UDP 能力分别检测。

## CRV1 音频帧

采用成熟 IMA ADPCM 算法，16,000 Hz、单声道、每帧 320 个 PCM16 样本（20 ms）。每帧独立包含解码起点，单帧丢失不破坏下一帧。压缩载荷约 64 kbit/s；包含下表小头部为 72 kbit/s，再叠加房间控制头、加密和网络开销。此前 32 kbit/s 负载表只是方案估算，不能当作本次编码的实际码率。

| 字节偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 4 | ASCII CRV1 |
| 4 | 4 | stream，流代次，无符号小端 |
| 8 | 4 | seq，帧序号，无符号小端 |
| 12 | 4 | sampleClock，音频采样计数，无符号小端，按环绕比较 |
| 16 | 2 | 首个有符号 PCM16 样本，小端，作为初始 predictor |
| 18 | 1 | 初始 IMA stepIndex，0–88 |
| 19 | 1 | 保留为 0 |
| 20 | 160 | 剩余 319 个样本的 4 位 IMA 差分，低半字节先；最后的高半字节填 0 |

总长度固定 180 字节。未支持的长度、magic、索引、保留位或来源拒收；流代次、序号与采样计数不代替传输加密 nonce。接收端每位说话者独立排序、去重和有界缓冲，本地混音不回送自身。静音与没有发送音频不等于网络丢包。

## 通用中转扩展

实现阶段由服务端与共享 SDK 同步定义：ROOM_SYNC(103) 读取通用授权快照及房主修改锁标记/撤权；JOIN 裁决控制区 grant 声明通用授权，服务端不解析正文的 allowed；BROADCAST(201) 可指定接收目标，并与关联代次一起校验。房主仍决定入房，Rust 只执行声明的通用路由权限。

可丢弃音频使用通用控制元数据 `discard:1` 与 `maxAgeMs:200`。200 ms 是服务端最大排队时间，不是端到端时延保证；发送前与播放端仍须丢弃过期音频。播放端以 stream/sampleClock 和本机单调时钟建立时间映射，后续包到达不能不断推迟旧声音。新流第一帧本身已经产生的单向时延无法仅凭该时钟获知。控制消息不因此变为可任意丢弃。

原生选路的 loss/jitter 是路径探测丢失与 RTT 变化，尚不是接收者反馈的真实媒体统计，也没有带宽容量估计器。Android 另记录音频接收序号窗口供诊断；直连质量恶化或本地发送失败时回退，短暂保持中转避免频繁切换。Windows UDP 使用非阻塞 socket，无应用发送队列，queuedMs:0 不代表内核或网络没有积压。

Android 使用系统 AcousticEchoCanceler；Windows 使用 Voice Capture DSP 默认播放设备参考；网页请求浏览器 echoCancellation。当前未加入独立 SpeexDSP，也未宣称真实设备外放效果通过。平台 AEC 不可用时仍能使用普通麦克风并提示耳机，观看与弹幕不受影响。

## 媒体与下载

原生媒体 API 通过配置的 Emby origin 限制请求，远端页面不能访问 NativeRoom。Android 初始播放地址仍须同源，播放器内部允许 HTTP(S) CDN 跳转和后续分片；跨源剥离 Emby/Authorization/Cookie 等账号头与 api_key，保留 CDN 自身签名参数，禁止 URL 用户信息。播放请求固定在当前媒体代次，停止/换源会取消请求并禁止旧播放器再请求分片。媒体字节由各客户端直取，不经过赛博房间服务端。Android 原生播放器、Windows/网页 HTML 播放器应各自报告真实的格式与播放能力。

切片、换源或离房时，先清除本地播放状态并调用原生 playerStop，再使用停止前捕获的 session、地址和授权提交 `Sessions/Playing/Stopped`，有 LiveStreamId 时同时提交 `LiveStreams/Close`。两项通知并行、最多等待 2 秒，之后才允许下一次 mediaConfigure；重复 stopMedia 复用正在进行的清理，不再次取消通知。此顺序适配 Android playerStop/configure 会取消旧媒体请求的行为。断网时通知只能尽力发送，超时不得一直阻塞切片；它不承诺 Emby 已成功释放远端会话。

Android 对有明确视频解码证据的初始化/运行时错误允许一次软件解码回退，包括 MediaCodec.flush 被包装为意外运行时错误的情况。回退保留播放位置等状态并释放原播放器；仍失败则显示错误，不循环重试。播放验收要求实际首帧及无终止错误，不能只检查时长和进度。

Windows 可移植程序为 `desktop_client/target/release/cyber-room.exe`，内嵌共享网页，运行需要 WebView2 Runtime。主线程通过 `scripts/package-desktop-update.py` 生成 `server/desktop-update/latest.exe` 与清单，服务端提供 `/api/desktop/version`、`/api/desktop/latest.exe`。包缺失时服务端继续运行，页面不显示可用的假下载。

## 验收结果与边界

主线程已统一执行规则/恢复检查、Rust/Java/Rust-PC 协议互通、CRV1 固定向量、指定广播权限与过期边界、六人浏览器观影/弹幕/模拟语音及打包清单核对；Windows、Android、网页已通过本地样片和获准真实 Emby 的三端同步播放。每 5 秒在线列表刷新通过实际浏览器检查。真实账号六路同时播放、真人外放回声、蓝牙、跨公网 NAT 和多厂商设备仍未验收，详细证据和产物信息见执行记录。
