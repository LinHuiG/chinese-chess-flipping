# 翻棋联机

Java 21 + Spring Boot + Netty TCP 服务端，原生 Java Android 客户端。一个仓库中的 server/ 和 client/ 是独立工程；Docker 镜像仅包含 server/。

接续开发先阅读 [项目状态](PROJECT_STATUS.md) 和 [协作说明](AGENTS.md)。完整业务依据：[房间方案](docs/ROOM_MANAGEMENT_PLAN.md)、[棋局规则](docs/GAME_RULES.md)、[通信协议](docs/PROTOCOL.md)。当前实施记录见 [实施记录](docs/IMPLEMENTATION_PLAN.md)，自动检查、双模拟器联调与资源采样见 [验证记录](docs/VERIFICATION.md)。

## 当前功能

- 加密 TCP 握手、每 5 秒心跳、30 秒有效心跳超时、前台断线后间隔 3 秒重连；重连回大厅。
- 无账号、两人房间、创建/加入/退出/解散、准备、房主转移、同 App 新连接替换旧连接。
- 房主维护完整棋局和正常胜负；服务端管理会话、成员、状态、操作转发和退出判负，不存棋盘或战绩。
- 4×8 翻棋、随机先手、首次翻棋定色、自定义普通与特殊吃法、禁止重复棋面、每步 30/60/90 秒或无限。
- 大厅、等待页和游戏右上角规则按钮。棋盘左红右黑阵亡栏，灰显、点亮和数量角标。
- 原生浅色分组界面与红黑双棋子图标；翻棋、走子、吃子短动画，吃子与胜负短音效，设置中可分别关闭动画和音效。
- 默认服务器 hgame.tudoucoding.tech:8888，设置页可保存域名/IP 和端口。

## 本地运行

1. IDEA 打开 server/pom.xml，JDK 21。设置环境变量 TCP_PORT=18888、TCP_WORKER_THREADS=2，运行 ServerApplication。
2. Android Studio 打开 client/，使用 IDE JDK，安装 SDK 37、Build Tools 36.0.0。
3. 模拟器内打开服务器设置，填写 10.0.2.2、18888；真机填写电脑局域网 IP。手机和电脑须能互通，防火墙允许所选 TCP 端口。
4. 一人创建房间，另一人加入；房主选择每步时间，双方准备后自动开局。更改时间会取消双方准备。

切后台/锁屏不主动离房，连接服务通过常驻通知运行。通知可断开连接；从最近任务移除 App 会关闭连接。后台不主动重连，回前台再尝试。系统仍可能终止进程，厂商设备行为需真机验收。

## 构建与检查

~~~powershell
# 服务端：Java 21 和 Maven
mvn -f server/pom.xml verify
# Android：在 client/ 中执行
gradlew.bat assembleDebug lintDebug
~~~

调试 APK：client/app/build/outputs/apk/debug/app-debug.apk。正式发行签名需要自己的密钥，不应提交密钥。

完整仓库的 Maven 检查包含实际 Android 通信代码、房主控制器的真实 TCP 联调和棋局规则检查。独立 server/ 构建会跳过缺少客户端源码的检查。Android 最低 API 26，compile/target API 37，不依赖 Google Play 服务、厂商 SDK 或原生 .so。

## 镜像与部署

推送 main 后，根目录 .github/workflows/publish.yml 先运行 Maven verify，再构建并发布 linux/amd64、linux/arm64 镜像：

~~~text
ghcr.io/linhuig/chinese-chess-flipping:latest
~~~

另提供 sha-* 标签。客户端和文档的 main 推送也会触发此流水线。发布结果以实际 Actions 运行和镜像清单为准。

用户自行部署的完整配置和命令见 [服务器部署](docs/DEPLOYMENT.md)。示例对外端口为 8888；进程本身未设置 TCP_PORT 时仍默认 9000。

## 通信与资源边界

21 字节明文固定头以 0xFC 0xFC 开始，控制头和包体整体 AES-256-GCM 加密，P-256 ECDH + HKDF 派生会话密钥。业务包体为 JSON，握手为原始字节。两端必须同时更新，旧明文协议和无固定标识的旧协议不兼容。

公钥交换没有预置可信身份，不能抵御主动中间人攻击；不提供前向保密或账号认证。房主拥有棋局裁判权，不防修改客户端作弊。详见协议及方案。

服务端只保存在线会话和最小房间信息；房间列表分页，转发请求有数量与时间上限，慢连接关闭并清理。Docker 默认 JVM 初始堆 16 MiB、最大堆 128 MiB、Serial GC；最大堆不等于进程总内存。可通过 JAVA_TOOL_OPTIONS 调整，实测记录见项目状态。
