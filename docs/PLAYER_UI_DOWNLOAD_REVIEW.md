# 电影厅、界面和下载修复（2026-10-16，本地未发布）

## 实现

- 保留深空深色风格，补齐三个插件的 SVG 封面、市场预览、大厅创建按钮和房间加入入口。封面随签名目录和插件包分发；目录刷新后重绘房间封面。
- 全屏使用浏览器 Fullscreen API，宿主 iframe 明确允许 opaque origin 全屏；iPhone 支持时走视频原生 `webkitEnterFullscreen`，避免直接调用受限的元素 API。Android 电影厅全屏请求横屏，退出恢复原方向。
- 全屏控制条空闲后隐藏，鼠标移动或触摸唤出，操作设置和进度时保持显示。原生视频通过裁剪露出 HTML 控件，保留视频原始尺寸；Windows 同时处理 mpv 子窗口上的鼠标活动。
- 后退 10 秒、前进 30 秒；房主桌面空格暂停/播放，左右短按跳转，长按右键临时 2 倍速、松开恢复原速及播放状态，长按左键连续后退。输入框、弹窗及访客排除播放快捷键。
- 网页视频播放申请 Screen Wake Lock，暂停、结束、移除片源或页面隐藏释放；返回可见页面重新申请。异步申请完成时再次核对播放状态。拒绝时只提示一次，不反复申请；后续手势允许重试。iframe 明确允许 `screen-wake-lock *`。不伪造触摸、不播放隐藏视频。
- 修复转码 URL 的实际 `StartTimeTicks`：PlaybackInfo 返回的地址可能缺失该参数或固定为 0，必须与本地时间偏移保持一致，包含切换画质和每次转码跳转。保留 mpv、Media3、hls.js 的现有成熟播放内核。
- Web、Windows、Android 插件下载显示字节进度，按签名载荷散列保存断点；重试用 Range，严格核对 Content-Range，服务器回 200 则重新下载；完整大小及 SHA-256 通过后才安装。服务端资源增加单范围 206/416。Android 部分文件保存在系统缓存，系统清理缓存后需重新下载。
- Android 原生电影厅改用独立不可变包名 `com.cyberroom.watch.v101`，电影厅插件 1.0.1；未更改客户端发布版本，未发布市场、安装客户端或部署。

## 已验证

- `scripts/watch-quality-native-test.mjs`：本地 HTTP 片源 + 实际 WatchRoom + 生产 Rust Player/libmpv，无窗口、静音。修改前复现：60 秒切 1080p，实际流请求从 0 秒开始，断言失败。修改后通过：原画 60 秒 → 1080p → 90 秒 → 30 秒 → 60 秒 → 解码继续前进；逐次核对实际 HTTP 请求起点。日志位于忽略目录 `server/target/quality-regression/player.log`。这是真实解码的受控本地片源，不是用户 Emby 验收。
- `scripts/ui-player-smoke.cjs`：后台 Edge，大厅真实渲染、签名目录、安装进度、插件和房间封面，1440/390/844 宽布局；按键、长按恢复、输入排除、访客隔离、全屏尺寸、隐藏/唤出及设置保持。通过真实 PluginRuntime 建立 opaque iframe，实际全屏和 Wake Lock 申请/释放均通过。
- `scripts/player-wake-test.mjs`：播放/暂停、隐藏/返回、系统释放、pagehide/pageshow、申请期间暂停、权限拒绝及恢复、移除片源。
- `scripts/plugin-download-test.mjs`：网络中断保存前缀、Range 续传、字节进度、200 回退及错误 Content-Range。
- Windows 宿主 `download::tests::interrupted_download_resumes_and_verifies_hash`：真实本地 TCP 响应中断，重试续传并通过完整散列验证。
- `watch-player-test.mjs`、`watch-seek-test.mjs`、`watch-native-player-test.mjs`、`watch-load-race-test.mjs`、`plugin-test.mjs`、桌面 `fullscreen-bridge-test.cjs` 通过；三个插件 esbuild bundle 通过。
- Windows 原生组件常规测试 23 项通过；2 项参数化诊断默认跳过，其中新增 headless quality 诊断已由上述 Node 驱动实际运行。Windows 宿主 cargo check 通过，新增下载测试通过。
- Android 宿主及电影厅组件 assembleDebug 通过。Rust 服务端 10 项通过，包含新增范围解析；更新包测试因本地未配套 `app-update/latest.apk` 未通过，后续定向运行显式跳过该项，不计作完整服务端验收。
- 截图位于忽略目录 `server/target/ui-review/`，不是线上截图。

## 尚未验证与发布边界

- 未切换用户正在观看的影片、访问其片源、操纵当前播放器窗口或重启服务。没有使用真 iPhone/Android 设备，也未做本轮 Windows 可见原生全屏控件的端到端验收。
- iOS 原生视频全屏、不同机型旋转、实际长时间不熄屏仍需真机验证，不能用 Edge 或 API 模拟代替。系统低电量/权限限制可能拒绝或释放常亮。
- Safari 16.4 起支持 Screen Wake Lock；添加到主屏幕的 Web App 的相关缺陷在 Safari 18.4 修复。来源：[WebKit 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)、[WebKit 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)。
- 本次未生成正式签名市场和最终 release 安装包，未提交、推送、发布、远程部署、通知其他线程或关机；不沿用历史任务授权。用户当前运行的版本不会因本地源码修改自动更新。

## 本地真实解码复现

运行 `node scripts/watch-quality-native-test.mjs` 前设置 `WATCH_TEST_MEDIA`（至少 120 秒的本地 MP4）、`FFMPEG`、`MPV_DLL_DIR` 以及组件构建需要的 `CYBER_ROOM_MPV_ARCHIVE` / `CYBER_ROOM_MPV_MANIFEST`。这些机器路径只通过环境变量传入，不写入代码。测试只允许 127.0.0.1 播放地址，Player 无窗口且静音。
