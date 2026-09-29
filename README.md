# 翻棋联机

和朋友下一盘暗棋。无需注册，创建房间、加入、准备，即可开始双人对局。

项目提供原生 Android 客户端和适配手机、电脑的网页版，支持跨端联机。服务端使用 Rust，可通过 Docker 自行部署。

## 功能

- **双人房间**：自定义昵称和房间名，双方准备后自动开局。
- **4×8 暗棋棋盘**：翻棋、走子、特殊吃法、阵亡统计，游戏内可随时查看规则。
- **每步计时**：支持 30、60、90 秒或不限时，禁止重复棋面。
- **断线恢复**：短暂断网、App 重启或网页刷新后，可在会话有效期内恢复对局。
- **直连与中转**：Android 玩家之间可尝试 UDP 直连，失败自动使用服务器中转；网页版通过服务器联机。
- **连接状态与更新**：显示网络延迟，Android 客户端支持在设置中检查更新。

完整玩法见 [棋局规则](docs/GAME_RULES.md)。

## 开始游戏

### Android

1. 打开 [GitHub Actions](https://github.com/LinHuiG/chinese-chess-flipping/actions/workflows/publish.yml)，选择最近一次成功发布的运行，下载 `app-update` 附件，解压并安装其中的 `latest.apk`。下载 Actions 附件需要登录 GitHub。
2. 打开 App，在设置中选择服务器。默认配置为 `HTTP / hgame.tudoucoding.tech / 80`，也可以改为自己部署的服务器。
3. 一人创建房间，另一人从大厅加入，双方点击“准备”开始对局。

客户端最低系统版本为 Android 8.0。后续更新可在 App 设置中检查，下载安装需要系统确认。

### 网页版

在浏览器中打开服务器的网站即可游玩，无需安装。网页与 Android 客户端连接同一台服务器时，可以加入同一个房间。

会话保留至最后一次有效心跳后 60 秒，断线期间回合倒计时继续。服务端重启会清空在线房间，需要重新创建或加入。

## Docker 部署

镜像包含服务端、网页和 Android 安装包，支持 `linux/amd64` 与 `linux/arm64`，无需另外安装 Java 或配置数据库。

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
node scripts/session-v2-test.mjs
```

运行客户端与服务端的互通测试时，先启动本地服务端，再设置 `CHESS_TEST_TCP_PORT` 和 `CHESS_TEST_HTTP_PORT` 为对应端口；未设置时跳过互通测试。

### 目录

| 路径 | 内容 |
| --- | --- |
| `server/` | Rust 服务端、Docker 配置 |
| `server/src/main/resources/web/` | 网页客户端 |
| `android_client/` | 原生 Java Android 客户端 |
| `scripts/` | APK 打包与网页检查脚本 |
| `docs/` | 游戏规则、通信协议和部署文档 |

需要开发客户端或了解消息格式，可阅读 [通信协议](docs/PROTOCOL.md)。

## 许可证

除另有声明的第三方代码和资源外，本项目采用 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**，详见 [LICENSE](LICENSE)。

允许使用、修改和商用。分发本项目或其衍生作品时，应按许可证要求提供对应源码并保留许可声明；修改后的版本通过网络向用户提供服务时，也须向这些用户提供获取该版本对应源码的方式。软件按“原样”提供，不附带担保，具体权利与义务以许可证全文为准。

第三方依赖和资源继续遵循各自的许可证，Android 客户端中收录的声明见 [第三方许可](android_client/app/src/main/res/raw/third_party_notices.txt)。
