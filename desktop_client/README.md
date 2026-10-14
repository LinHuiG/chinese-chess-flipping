# 赛博房间 Windows 客户端

Windows 10/11 x64，Rust + Tauri 2，直接内嵌 `../server/src/main/resources/web`，与 Android/网页共用大厅、玩法和观影界面。运行需要 Microsoft Edge WebView2 Runtime；Windows 安装器配置可下载缺失的运行时，可移植 EXE 不附带运行时。

默认连接 TCP / fqgame.tdcode.tech / 8888；设置保存在当前 Windows 用户的应用配置目录。升级保留设置。原生自有 TCP/WS 协议与 UDP 单播互连不使用 WebRTC/TURN。

## 构建

安装稳定版 Rust MSVC 工具链、Visual Studio Build Tools 的 C++ 桌面组件及 Windows 10/11 SDK。在仓库根目录运行：

```powershell
python scripts/prepare-desktop-media.py
cargo check --locked --manifest-path desktop_client/Cargo.toml
cargo test --locked --manifest-path desktop_client/Cargo.toml
cargo build --locked --release --manifest-path desktop_client/Cargo.toml --features custom-protocol
python scripts/package-desktop-update.py --source desktop_client/target/release/cyber-room.exe
```

程序产物为 `desktop_client/target/release/cyber-room.exe`。`custom-protocol` 默认启用，直接 Cargo 构建也内嵌共享网页，无 Node 前端构建步骤。主线程统一测试、打包；运行/包发布状态以根目录 `PROJECT_STATUS.md` 为准。

原生电影播放器使用固定散列的 libmpv，准备脚本只下载、校验和压缩，不执行上游程序。压缩库嵌入单个 EXE，首次播放在应用配置目录解包并校验，之后复用缓存；体积、来源与许可证见 [原生观影组件](../docs/WINDOWS_NATIVE_MEDIA.md)。运行库和本机缓存不提交 Git。

需要 NSIS 安装器时，可安装官方 `tauri-cli`，在本目录执行 `cargo tauri build --bundles nsis`。安装器构建会额外下载 NSIS 与 WebView2 引导程序；不能将仅生成可移植 EXE 写成安装器已经验证。

本地集成测试可以在启动前设置 `CYBER_ROOM_CONFIG_DIR`，覆盖设置目录以隔离用户配置。该目录的 `settings.json` 使用 host、port、transport、nickname、sound、motion 字段；省略字段使用默认值。测试必须预先配置本地地址，避免连接生产服务器。没有该环境变量时沿用正常应用配置目录。

## 桥接与语音

`NativeRoom.settings()` 返回同步缓存；其他同名接口返回 Promise。共享 SDK 必须等待发送结果后再决定是否中转。原生事件沿用 `native-room` CustomEvent。

- TCP 保留 P-256/HKDF/AES-GCM 原四消息握手与身份恢复；HTTP/HTTPS 使用 WS/WSS。发送与接收独立，不在读取半帧时取消读取；语音、可靠控制分别有界排队，写入阻塞关闭连接，不能截掉半个加密帧。
- UDP 单个 socket 管理各成员，加密方向与 Android 相同；仅匹配发出挑战的回复才能更新已验证路径，256 包防重放窗口，最大 32 片与 Android 一致，大于 28,800 字节的完整帧回退中转。原生发送失败目标合并进入一次 201 广播；分片不等于可靠传输。
- 语音为 CRV1 IMA ADPCM 16 kHz、单声道、20 ms 独立帧，逐帧收发不经过 WebView/Base64。每位来源独立采样时钟、序号去重、短排序和过期丢弃，原生混音。
- Windows 首先尝试系统 Voice Capture DSP 源模式，在默认输入/输出上采集并消除回声；默认输出参考包含电影与远端声音。CPAL 保持同一默认输出端点的播放流。系统 DSP 不可用时用普通麦克风并明确提示使用耳机；不宣称所有设备外放效果已经合格。
- 音频设备错误、后台、换网与恢复均闭麦；需要用户重新开麦。无麦克风/扬声器仍保留观影与弹幕。视频由内嵌 libmpv 播放器直接取 Emby，共享 HTML 提供操作界面；元数据 HTTP 桥限制到配置的单一 origin，不跟随重定向携带授权。
- Windows 仅在最小化、隐藏或会话锁定时进入后台；切换其他窗口、复制地址、系统弹窗和普通回焦不触发房间恢复。前后台事件按状态迁移去重；锁定状态由 Windows 会话查询获取，休眠恢复仍重新同步且保持闭麦。

系统回声接口依据 [Microsoft Voice Capture DSP](https://learn.microsoft.com/en-us/windows/win32/medfound/voicecapturedmo) 与 [设备索引说明](https://learn.microsoft.com/en-us/windows/win32/medfound/mfpkey-wmaaecma-device-indexesproperty)。外放多人语音、音量变化、蓝牙切换、休眠恢复及真实 Emby 兼容性需设备验收；编译通过不能代替这些检查。
