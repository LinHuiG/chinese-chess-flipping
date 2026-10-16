# 插件开发与发布（API 1）

赛博房间 0.9.0 将翻棋、矿工和电影厅放在 `plugins/chess`、`plugins/miner`、`plugins/watch`。宿主只包含大厅、市场、连接、权限网关、私有存储和设备桥接。Rust 继续处理通用 v3 帧，不运行插件，也不解析游戏、Emby 或语音正文。

## 开发入口

每个插件目录提供 `manifest.json`、JavaScript 入口和 `view.html`，可带 `rules.txt`、`assets/` 及平台原生组件。`plugin_sdk/transport.js` 是公开通信接口；`room.js` 和 `ui.js` 是可选的房主房间助手及现成等候室。它们被打进插件包，升级不要求替换宿主。三端可以共用一个入口，也可以声明不同入口；缺少的端不会获得安装或入房资格。

最小清单示例（新插件需自行生成随机 `roomFeature`，不可复用示例）：

```json
{
  "schemaVersion": 1,
  "id": "example.dice",
  "key": "dice",
  "name": "骰子房",
  "description": "一起掷骰子",
  "version": "1.0.0",
  "hostApi": 1,
  "protocol": "dice/1",
  "roomFeature": "0436975303e74f78b2b5bb9db3c575d0",
  "room": { "minMembers": 1, "maxMembers": 6 },
  "targets": { "web": { "entry": "app.js" } },
  "permissions": ["room.messaging", "storage.private"],
  "license": "AGPL-3.0-only"
}
```

`id` 在市场内唯一，版本使用三段数字；`protocol` 表示业务协议。`roomFeature` 是 32 位小写十六进制：前半用于公开发现，后半交房主验证。`hostApi` 必须与宿主相容，人数范围为 1–16，插件可以收窄。首批平台名固定为 `web`、`android`、`windows`，不表示已经支持 iOS/macOS/Linux。

## 少量核心接口

从 `../../plugin_sdk/transport.js` 导入；入口模块会先等待宿主提供绑定的 MessagePort，再开始执行。不要直接调用父页面或原生对象。

| 接口 | 用途与约束 |
| --- | --- |
| `bootstrap` | 当前清单、发布绑定、平台、启动命令、非敏感连接信息。没有服务器恢复凭据。 |
| `new RoomClient(callbacks)` | `connected`、`closed`、`message`、`native`、`path`、`status` 回调。`connect()` 等待连接；`requireCompatible()` 检查服务能力。 |
| `createRoom({name,locked})` | 宿主注入插件标识与发布版本；一个实例只能绑定一个房间。 |
| `joinRoom(roomId,application)` | 宿主注入平台与插件绑定，接受房主裁决后核对服务端授权。 |
| `replyJoin(request,decision)` | 房主准入回复。必须等待完成后给新成员发送消息；`decision.room.plugin` 必须保持原绑定。 |
| `roomSync(roomId,change)` | 查询获准成员或由房主执行通用撤销。宿主更新路由范围，拒绝过期的成员快照覆盖新授权。 |
| `sendTo(roomId,to,headers,body,path)` | 指定获准成员发送；`path` 为 `auto` 或 `relay`。不能覆盖 roomId、op、to 等路由控制字段。 |
| `broadcast(roomId,targets,headers,body)` | 一次指定成员广播；省略 targets 发给当前获准成员。 |
| `leaveRoom(roomId)` | 退出；房主退出解散。更换插件必须先退出并重新建房。 |
| `storageGet(key,fallback)`、`storageSet(key,value)`、`storageFlush()` | 当前插件命名空间内的 JSON，合计最多 512 KiB。set 更新缓存并排队写入；必须 await flush 才能确认写盘成功。 |
| `secureRead()`、`secureWrite(jsonText)` | 原生端每插件一份最多 256 KiB 的加密 JSON 文档。Android Keystore / Windows DPAPI；写入字符串 `null` 删除。Web 应明确提示用户后使用私有浏览器存储。 |
| `asset(name)` | 返回当前包内资源的 data URL；不依赖宿主资源路径。 |
| `onHostEvent(callback)`、`call('plugin.close')` | 监听 background/foreground、连接、dispose 等生命周期，或退出插件。 |

`room.messaging`、`storage.private`、`network`、`media`、`voice` 分别控制通信、存档、网络、媒体、语音能力。原生设备方法需由组件的 `exports` 显式声明。网页采集使用 `call('microphone.start', generation)` / `call('microphone.stop')` 和 `audio-input` 事件，原始 PCM 为 16 kHz、单声道、每帧 320 样本，含采集时间；编码及路由由插件实现。退出、断线、后台都会停止采集。系统麦克风许可仍由系统询问。

插件收到了 `dispose` 时，应先停止业务、保存数据并等待 `storageFlush()`，最后 `call('plugin.disposed')`；宿主最多等待 5 秒，随后清理房间、通道、原生组件。不要用卸载页面后的异步写入作为唯一保存途径。

## 复用房间助手

三个官方插件示范 `mount(rules, view)`：`rules` 管规则，`view` 管 UI，不把业务方法塞入宿主 API。

- `rules.start(g)` / `restore(saved)` / `snapshot(g)`：创建、恢复及公开状态；不要在公开快照里放隐藏棋子或片源凭据。
- `rules.perform(g,who,action,member,payload)`：仅房主执行动作，返回错误文本或 null；助手处理重复动作、确认及状态同步。
- `rules.canJoin(g)`：等待室/进行中的准入策略。密码、容量、成员恢复由助手提供。
- `rules.actionData(g)`：给动作补充业务版本，例如矿工关卡号。
- `rules.tick(g,now,dt)` / `save(g,notify)` / `background(g)` / `memberLeft(g)`：按需实现；不要为不用的能力创建空转调。
- `view.render()` / `event(event)` / `native(event)` / `round()`：业务 UI 和生命周期。异步保存返回 Promise。

可直接参考翻棋的 `rules.js` 和 `app.js`。玩法可完全自定义界面并直接用 RoomClient，无须复制所有电影厅代码。当前打包器给官方插件合并共享等候室/对话框；独立入口同样通过 SDK 挂载自己的界面。

## 隔离及信任边界

脚本运行于没有 same-origin 权限的 iframe；不能读取宿主 DOM、localStorage、连接凭据或 NativeRoom。CSP 限制远端脚本、子 frame、表单和导航；无 network 声明时外部图片、媒体和连接均不放行。插件能访问其声明的网络目标，因此安装只来自受信任签名市场；这不是任意不可信代码的完整资源配额沙箱。原生组件属于经过审核的可信代码，不声称具有 OS 权限隔离。

Android 原生组件为单独 APK，经系统安装、宿主同签名、版本和完整文件 SHA-256 核对后，使用 `NativeExtension` 接口和组件资源加载。为兼容 Android 8.0 与内嵌画面，组件在宿主进程内执行。UI 调用在主线程，`receive` 可能在网络线程与 close 并发，组件必须自行同步。第三方网页脚本不能自行加载任意原生代码。

Windows 组件是独立 EXE，通过私有标准输入输出交换有界 JSON；宿主校验文件，管理子进程和房间路由，故障自动退出当前插件。组件事件带实例代次，旧进程迟到事件不会污染新房间。进程隔离不等于低权限沙箱。第一版只分发官方电影厅原生实现。

Android 的同一 `packageName` 必须对应不可变 APK。打包器依据原生源码指纹复用旧 APK，改变原生源码需改 applicationId、组件 Java 包名和清单入口，使旧组件可以与新组件共存；不能让系统升级覆盖仍被旧房间使用的二进制。打包器拒绝同包名不同散列。Windows 按散列保留 EXE。

## 打包和市场

```powershell
npm ci
# 先编译 watch_extension APK 和电影厅 Windows release 组件
node scripts/package-plugins.mjs --development
node scripts/check-plugin-market.mjs
node scripts/plugin-test.mjs
```

生产使用环境变量 `PLUGIN_SIGNING_KEY_FILE`，APK 选 `PLUGIN_APK_VARIANT=release`。本地开发 key 位于忽略的 `server/target/`；公钥固定在宿主 `plugin-trust.json`。已有公钥不匹配时构建失败，不自动换信任根。私钥不能加入仓库或插件。

市场是独立静态目录 `server/plugin-market/`，可随当前镜像分发或单独托管。开发者提交源码、清单、支持端、许可证和测试；维护者审核后构建签名。第一版没有开放自助上传、账号、付费、评分或审核后台；协议和目录支持后续接入它们。

catalog 使用 ECDSA P-256 / SHA-256，签名格式 P1363；平台 JSON 包与可选 APK/EXE 均带完整 SHA-256、字节数和固定路径。一个 release 散列覆盖清单及全部端产物。房间锁定 `{id,version,release,protocol}`，安装更新只影响后续打开，不能把已有房间切到新代码。未安装的加入者会确认下载精确发布；平台不支持或版本撤回时拒绝。

更新先下载、验签、校验散列并准备原生组件，最后事务更新安装指针；失败保留旧安装。离线可读已验证的缓存；刷新市场后撤回版本不能再打开。网络离线不构成撤回通知的实时保证。按当前用户决定，本版没有“更新增加权限时重新同意”的流程。

发布工作流先取 GitHub `plugin-market` Release 的历史归档，保留旧发布及文件，再追加新发布、验证并回存归档；不依赖会过期的 Actions 附件保留历史。归档本身不是线上市场，只有已完成镜像发布/部署的内容上线。撤回须由维护者修改签名目录的 revoked 标记并重新签名，不删除仍需回滚的文件。

卸载删除脚本安装记录和缓存，保留私有存档。Android 系统组件可在系统应用管理中另行卸载；Windows 原生文件保留在本地缓存供旧版本恢复，退出时不保留运行进程。首版未做磁盘缓存自动淘汰。共享房间数据在进程内，服务重启仍需重建房间。

## 服务端兼容

READY 新增 `room-descriptors` 能力。CREATE(100) 接受可选 UTF-8 `metadata` 字符串（最多 2048 字节），服务端原样存放；LIST(101) 可省略 roomType 获取全部房间，并返回 metadata。宿主使用其携带插件公开绑定；服务端不理解该字符串。旧服务会被宿主明确提示升级；旧 0.8.x 客户端不能进入新的插件房间。
