# 0.8.3 Emby 播放对照诊断

日期：2026-10-15。此记录区分客户端验收和测试片源限制；**不能据此宣称用户要求的 PC＋Web 同片有声观影已经全部通过**。未修改 Emby 管理配置，也未关闭浏览器安全限制。

## 已观察结果

| 对象与条件 | 实际结果 | 能说明什么 |
| --- | --- | --- |
| 影片 128223，H.264＋E-AC-3 六声道；Windows mpv | 主线程已验证真实画面和非零音频 PCM | PC 本机解码路径有效；不是浏览器能力证明 |
| 用户打开的 Emby Theater 3.0.20，同集 | 实际窗口可见画面和中文字幕，mpv 子窗口使用静态原始流；本机启动日志确认外部 mpv.exe。用户反馈有声音 | 与原生解码路径一致，不能代替服务端转码验收；工具未进行真人听音 |
| 同片，Android API 37 模拟器受控原生直流能力探测（不经过生产协商） | 约 5 秒真实首帧/截图；audioSupported=false、audioSelected=false、音频输出缓冲及 PCM=0；独立 MediaCodecList 无 E-AC-3 解码器 | 仅证明该模拟器缺少 E-AC-3 解码，不泛化全部 Android；生产客户端仍需 AAC/HLS。证据在 `android_client/app/build/real-android-media-check/`，测试已清理 |
| 同片，片源自带 Emby Web 4.10.1.0，独立默认 Edge，UI 登录后点播放 | 播放观察 18 秒，进度 16.52 秒、1920×1080、视频解码 16,135,287 字节；未静音、音量 1，音频解码 **0 字节** | 官方网页也没有成功解码该音轨；有画面不等于有声音。未以模拟器/计数器代替真人听音测试 |
| 官方网页的真实网络请求 | PlaybackInfo 的预检和播放请求均返回 E-AC-3、DirectPlay/DirectStream=true、Transcoding=false、无 TranscodingUrl；媒体 302 至 `*.115cdn.net` 后返回原始媒体 206 | 官方网页走原始流，没有获得 AAC 转码；未发现它使用另一个可工作的 AAC 地址 |
| 按官方 Web 请求格式协商 | 标量置于 query，body 仅 DeviceProfile，禁用直放/直流并要求 H.264/AAC；结果仍是上述标志，remote=true，RequiredHttpHeaders 为空 | 未证明是本客户端的 body/query 位置或缺少服务端声明的请求头导致失败 |
| 官方 HLS 接口，仅转换音轨 | 允许 H.264 视频复制、要求 AAC 双声道、不限分辨率、30 Mbps 上限；master/variant 均 200，声明 AAC，含 432 段；**首个 TS 请求 18 秒超时** | 取消额外视频重编码后仍未得到媒体字节；清单成功不代表转码可用 |
| 此前强制 H.264/AAC 或 720p 转码 | 清单 200，TS HTTP 500 或超时 | 不能把清晰度、烧录字幕或 Web 音频转码在该真实源上记为通过 |
| AAC 影片 124642，房主＋晚加入的两个 Web | 双方 1080p、有非零音频解码；晚加入在 4.14 秒完成真实 seek 并继续播放 | 双端真实直放和晚加入跳转通过 |
| 同 AAC 影片三个 Web | 前两端播放正常；第三端媒体 302 后 `net::ERR_BLOCKED_BY_ORB`，MediaError 4，metadata/seek 前失败；账号 SimultaneousStreamLimit=0 | 已确认第三路响应被浏览器拦截；**不能据此断言 CDN 恰好限制两路**，上游实际状态/内容仍需日志 |

客户端已通过本地故障注入验证：同影片仅一次自动兼容回退；失败后房主同步消息不会反复重建播放；错误不会被自动播放提示覆盖；主动重试才再次协商。

## 下一步与发布边界

没有证据支持继续盲改播放器参数。最小外部检查是取该 item/session 对应的 Emby/FFmpeg 转码日志及远程源读取日志，确认服务端能读取这个 115 远程文件、转换 E-AC-3 为 AAC 并返回首段。也可提供含兼容 AAC 音轨的同片版本复验。三端 ORB 需同时核查源网关/CDN 的响应状态、Content-Type、Range 和并发行为；根因尚未由服务端日志确认。

用户随后确认：使用 HTTP 入口，片源属于第三方、没有管理权限；不再提问，片源问题修不好则先发布本版、通知部署线程部署并在完成后关机。因此上述真实源限制保留在发布记录，不再作为等待外部管理员的发布前置条件；客户端检查和正式构建仍需完成，不能把限制项改写为通过。

## 安全复跑与清理

- `scripts/emby-web-reference.cjs`：独立临时 Edge context，真实官方 Web 登录/详情/播放，最多观察 18 秒；默认浏览器安全设置。输出仅脱敏请求摘要、播放器计数器和播放截图。只把 `IsPlayback=true` 的会话作为清理目标，关闭浏览器并发送该会话 Stopped；已知 device/session 时再定向停止其转码。携带 token 的清理请求拒绝重定向；缺少画面或音频解码证据时输出报告后以退出码 2 结束，不能当作验收通过。
- `scripts/emby-compatibility-probe.cjs`：默认 `EMBY_MODE=metadata` 仅验证官方 query/body 格式；`audio-only` 最多请求两份清单及一个上限 8 MiB 的分片，每请求超时 18 秒，最后 Stopped 及仅本 device/session 的 ActiveEncodings 清理。TS 响应成功仍需另外验证解码，不能据此自动判为播放通过。
- 输入仅通过临时 `EMBY_BASE`、`EMBY_USER`、`EMBY_PASSWORD`、`EMBY_ITEM` 环境变量提供。官方 Web 脚本允许可选 `EMBY_SERVER_ID`；缺省读取公开服务器标识。不得把凭据、完整播放 URL、Cookie 或 token 写入命令输出/归档。运行 Playwright 脚本需要本机已配置的 Node 依赖及 Edge。
- 本次仅音频转换实验：Stopped、限定 device/session 的 ActiveEncodings 均返回 **204**。官方 Web 对照已关闭独立浏览器及页面连接，实际播放为直流，诊断记录中的 Stopped 返回 **204**。运行时脚本曾以最后一次 PlaybackInfo 覆盖 session，故不单凭该 204 宣称实际播放 session 已单独核验清理；归档版已改为仅记录 IsPlayback=true 的 session。没有继续保留播放上下文，也未改用户既有浏览器或 Emby 管理配置。
- 本地安全证据位于被忽略的 `server/target/emby-web-reference/result.json`、`player.png`，以及 `server/target/watch-playback-real/{result,failure}.json`；不包含完整授权 URL。最终归档脚本做了语法检查，归档整理后未再次请求远端媒体。

## 参考

- [Emby 官方 HLS 接口与结束转码要求](https://dev.emby.media/doc/restapi/Http-Live-Streaming.html)
- [Emby PlaybackInfo 请求字段](https://dev.emby.media/reference/RestAPI/MediaInfoService/postItemsByIdPlaybackinfo.html)
- [官方 Emby Web 播放管理源码](https://github.com/MediaBrowser/emby-webcomponents/blob/master/playback/playbackmanager.js)。本次还只读对照了测试服务器实际提供的 4.10.1.0 `modules/common/playback/playbackmanager.js` 与 `modules/emby-apiclient/apiclient.js`，并以真实 UI/网络结果为准。
