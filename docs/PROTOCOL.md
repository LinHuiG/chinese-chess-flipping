# 通信协议 v3（赛博房间 0.7.0）

完整固定头、TCP 四条握手消息、WS/UDP 承载、七个基础功能号、字段和调用流程以 [赛博房间接入手册](CYBER_ROOM_INTEGRATION_MANUAL.md) 为准。客户端实际 API 与可运行代码入口见 [开发指南](FRAMEWORK_DEVELOPMENT_GUIDE.md)。

v3 与 0.6.x 的 v2 不兼容，需要同时更新服务端、APK 和网页。保留 17 字节固定头，控制区改为 key:value 加 LF，普通正文 JSON、大数据原始字节。房主退出直接解散；Rust 不再理解翻棋、矿工或正式业务成员。

## 附属的 App 发布接口

这四种 kind 保留用于现有安装包发布，不属于房间基础功能，也不参与游戏或模块协议。

| kind | 输入／输出 |
| --- | --- |
| 48 UPDATE_CHECK | 空控制区；JSON {"type":"UPDATE_CHECK","versionCode":当前版本整数} |
| 49 APP_VERSION | 空控制区；JSON 清单：packageName、versionCode、versionName、sha256、size、available、type；失败时 error |
| 50 APP_GET | 空控制区；JSON {"type":"APP_GET","versionCode":目标版本,"currentVersion":当前版本,"offset":字节偏移} |
| 51 APP_CHUNK | KV 控制区 type:APP_CHUNK、versionCode、offset、size、done（true/false）；正文原始 APK 字节，最多 32768 字节 |

TCP 在 READY 后加密，WS 使用统一明文帧。版本不更新不下载，下载后客户端检查长度、SHA-256、包名、版本与原签名，再由 Android 系统确认安装。

HTTP 入口仍为 GET /api/app/version?versionCode=N 与 GET /api/app/latest.apk?versionCode=N；当前版本不低于服务器版本时下载返回 204。APK 和清单在启动时一致性校验后共享内存快照，更新包替换需重启进程。网站资源按请求读取，与 Rust 二进制分离。
