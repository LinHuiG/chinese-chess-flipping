# 赛博房间

和朋友开一个房间，玩翻棋、一起淘金，或看一场电影。游戏准备后开局，电影厅随时入座。

项目提供 Android、Windows 和适配手机、电脑的网页版，共用一份界面与玩法，支持跨端联机。Rust 只管理通用房间、房主声明的路由授权与不透明转发，可通过 Docker 自行部署。

## 功能

- **可选玩法的房间**：翻棋 2 人，黄金矿工 2–3 人；自定义昵称和房间名，凑齐人数并准备后自动开局。房主退出直接解散。
- **电影厅**：1–6 人，房主选择 Emby 片源并控制播放、暂停和进度，成员直接取流并随时加入；实时弹幕不补历史，支持多人开麦。音频不可用仍可观看、发弹幕。
- **房间密码**：默认无密码，可由房主设置和修改；现有获准成员的有效恢复不受改密影响。
- **多人黄金矿工**：每人一只爪子、独立积分，金块、石头、钻石、仓鼠、钱袋、狗屎和 TNT；9 种商店道具，1,000 关、10 个矿区主题，原创画面、动画与合成音效。
- **房主存档**：矿工每 5 秒自动保存，也可手动保存；重新建房可继续，按加入顺序恢复座位财富与装备。
- **4×8 暗棋棋盘**：翻棋、走子、特殊吃法、阵亡统计，游戏内可随时查看规则。
- **每步计时**：支持 30、60、90 秒或不限时，禁止重复棋面。
- **断线恢复**：短暂断网、App 重启或网页刷新后，可在会话有效期内恢复对局。
- **直连与中转**：Android、Windows 获准成员之间可尝试 UDP 直连；声音由说话者直接分发，剩余接收者通过一次指定广播中转，房主不代转别人声音。网页通过服务器联机。
- **连接状态与更新**：显示网络延迟，Android 客户端支持在设置中检查更新。
- **房间列表自动刷新**：在线且停留列表页时每 5 秒刷新，进入房间、退后台或断线后停止；手动刷新仍可使用。

翻棋规则见 [棋局规则](docs/GAME_RULES.md)，矿工操作和道具说明在游戏内“?”。基于底座开发新功能见 [赛博房间接入手册](docs/CYBER_ROOM_INTEGRATION_MANUAL.md) 与 [客户端开发指南](docs/FRAMEWORK_DEVELOPMENT_GUIDE.md)。

0.8.1 已实现电影厅、密码、指定广播、Windows 运行包、选择面板及 App 常驻通知移除。接口见 [实现契约](docs/WATCH_ROOM_IMPLEMENTATION.md)，逐项检查及实机边界见 [0.8.1 验收记录](docs/ACCEPTANCE_0_8_1.md)，发布进度见 [执行记录](PROJECT_STATUS.md)。优化待办中未实施的性能建议继续保留，不以编译通过代替真机验证。

## 开始游戏

### Android

1. 打开服务器网页，点击顶部的“下载 App”获取 Android 安装包。也可从 [GitHub Actions](https://github.com/LinHuiG/chinese-chess-flipping/actions/workflows/publish.yml) 最近一次成功发布的运行中下载 `app-update` 附件，解压并安装其中的 `latest.apk`（下载 Actions 附件需要登录 GitHub）。
2. 打开 App，在设置中选择服务器。默认配置为 **TCP / fqgame.tdcode.tech / 8888**，也可以改为自己部署的服务器。
3. 房主选择翻棋或黄金矿工并创建房间，朋友从大厅加入，大家点击“准备好了”开始。

0.8.1 保留 v3 外壳，并通过 READY 能力声明检查房主路由授权、同步和广播契约；连接旧服务时会明确提示升级，需配套更新服务端与客户端。更早的 v2 客户端不能通过当前 TCP 协议自助更新，请从网页手动安装。

客户端最低系统版本为 Android 8.0。后续更新可在 App 设置中检查，下载安装需要系统确认。

升级会保留已保存的服务器设置。需要切换到默认服务器时，在设置中点击“恢复默认值”，再点击“保存设置”。

### 网页版

在浏览器中打开服务器的网站即可游玩，无需安装。网页、Android 和 Windows 连接同一台服务器时，可以加入同一个房间。浏览器开麦需要 HTTPS（localhost 测试例外）及麦克风许可；Emby 必须允许该网页跨域访问，HTTPS 页面应使用 HTTPS 片源。

### Windows

网页检测到服务器有运行包时显示“下载 Windows”。下载后运行 `.exe`，设置服务器即可；默认同为 TCP / fqgame.tdcode.tech / 8888，需要 Microsoft Edge WebView2 Runtime。当前提供 x64 可移植程序，详细构建说明见 [Windows 客户端](desktop_client/README.md)。

### 一起看电影

房主创建电影厅，打开“Emby 片源 / 选片”，输入服务地址及观影专用账号，确认向获准成员共享该账号的播放权限后选片。成员不必再次登录，但各自会占用 Emby 的独立播放连接；账号权限、并发限制和转码能力由 Emby 决定。当前共享访问令牌不是只准看一部电影的临时票据，请使用权限受限的专用账号。

点击“加入观影 / 开启声音”允许本机播放；麦克风默认关闭，可独立开关。系统回声处理的效果取决于设备，外放开麦仍需实机验证。App 退后台关闭麦克风、暂停本机，房主后台暂停全房；回来重新同步且不会自动开麦。客户端已移除自建常驻通知，不承诺系统长期保活。

会话保留至最后一次有效心跳后 60 秒，翻棋断线期间倒计时继续。矿工房主进入后台自动暂停，可由房主继续。服务端重启会清空在线房间，需重新创建；房主的矿工本地存档仍可继续。

## Docker 部署

发布工作流将服务端、网页、Android 安装包及 Windows 运行包放进镜像；服务端支持 `linux/amd64` 与 `linux/arm64`，无需另外安装 Java 或配置数据库。新工作流尚需实际 Actions 运行确认，当前是否已发布见执行记录。

安装 Docker 和 Docker Compose 后，下载 [compose.yaml](server/compose.yaml)，放入一个新目录。在同一目录创建 `.env` 文件：

```dotenv
SERVER_IMAGE=ghcr.io/linhuig/chinese-chess-flipping:latest
TCP_PORT=8888
UDP_PORT=8888
HTTP_PORT=80
HTTP_BIND_ADDRESS=0.0.0.0
HTTP_PUBLISH_PORT=8080
TCP_WORKER_THREADS=2
```

在该目录执行：

```sh
docker compose pull
docker compose up -d --no-build
docker compose logs --tail=50 server
```

启动后，在浏览器中访问 `http://服务器地址:8080`。Android 客户端可选择 HTTP、填写服务器地址和端口 `8080`，也可选择 TCP、使用端口 `8888`。

| 对外端口 | 用途 |
| --- | --- |
| TCP 8080 | 网页、WebSocket 联机和 App 更新 |
| TCP 8888 | Android TCP 连接 |
| UDP 8888 | 协助 Android 玩家建立直连 |

在服务器防火墙和云平台安全组中放行所需端口。TCP 与 UDP 需要分别放行；UDP 不可达时仍可通过服务器中转游玩。修改 UDP 端口时，保持容器内外端口一致。

公网部署建议配置 HTTPS/WSS。使用同机反向代理时，可将 `HTTP_BIND_ADDRESS` 改为 `127.0.0.1`，由代理转发网页和 WebSocket 请求。

更新到最新镜像：

```sh
docker compose pull
docker compose up -d --no-build
```

更新会中断当前对局，建议在无人游玩时操作。更多端口设置、HTTPS 配置、版本回退和 UDP 排查方法见 [部署说明](docs/DEPLOYMENT.md)。

## 本地开发

### 环境

- Rust 稳定版工具链。
- Android Studio、JDK 25、Android SDK 37（SDK 包名 `platforms;android-37.0`）和 Build Tools 36.0.0。
- Python 3，用于生成 Android 更新资源；运行网页检查另需 Node.js。

### 构建并运行

以下命令在仓库根目录的 PowerShell 中执行。服务端启动需要 Android 安装包及版本清单，因此先构建客户端：

```powershell
.\android_client\gradlew.bat -p android_client assembleDebug
python scripts/package-app-update.py

$env:TCP_PORT = "18888"
$env:HTTP_PORT = "18880"
$env:UDP_PORT = "18888"
$env:TCP_WORKER_THREADS = "2"
cargo run --locked --release --manifest-path server/Cargo.toml
```

浏览器访问 `http://localhost:18880`。Android Studio 打开 `android_client/`，安装客户端后连接电脑的局域网地址；Android 模拟器使用 `10.0.2.2` 访问宿主机。HTTP 端口填 `18880`，TCP 端口填 `18888`。

调试 APK 位于 `android_client/app/build/outputs/apk/debug/app-debug.apk`。调试包与正式包签名不同，不能直接覆盖安装正式包。

### 常用检查

```powershell
cargo test --locked --manifest-path server/Cargo.toml
.\android_client\gradlew.bat -p android_client lintDebug testDebugUnitTest
node scripts/client-test.mjs
```

运行客户端与服务端的互通测试时，先启动本地服务端，再设置 `CHESS_TEST_TCP_PORT` 和 `CHESS_TEST_HTTP_PORT` 为对应端口；未设置时跳过互通测试。

### 目录

| 路径 | 内容 |
| --- | --- |
| `server/` | Rust 服务端、Docker 配置 |
| `server/src/main/resources/web/` | App/Web 共用客户端与玩法 |
| `android_client/` | Android 壳、原生传输与打包 |
| `scripts/` | APK 打包与网页检查脚本 |
| `docs/` | 游戏规则、通信协议和部署文档 |

需要开发客户端或了解消息格式，可阅读 [通信协议](docs/PROTOCOL.md)。

## 许可证

除另有声明的第三方代码和资源外，本项目采用 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**，详见 [LICENSE](LICENSE)。

允许使用、修改和商用。分发本项目或其衍生作品时，应按许可证要求提供对应源码并保留许可声明；修改后的版本通过网络向用户提供服务时，也须向这些用户提供获取该版本对应源码的方式。软件按“原样”提供，不附带担保，具体权利与义务以许可证全文为准。

第三方依赖和资源继续遵循各自的许可证，Android 客户端中收录的声明见 [第三方许可](android_client/app/src/main/res/raw/third_party_notices.txt)。
