# 0.9.5 Emby S02E01 播放修复与验收

2026-10-27 晚间，发布前验证中。用户授权客户端修复和验证后直接提交推送发布，再通知既有“部署线程”部署第一台 fqgame.tdcode.tech；第二台不操作，本次不关机。未使用子代理或 dsh。凭据仅在内存使用，原始本机存档未修改。

## 问题与实测

此前 FRP 入口故障已恢复，不沿用该判断解释后续故障。Emby 元数据确认条目 144160 是《赛博朋克：边缘行者》S02E01 / 第 1 集，源为 1080p H.264、双 E-AC-3 音轨及内嵌 SRT；本机保存的画质为 1080p，会请求兼容转码。

22:45:34、22:47:36 的 CyberRoom 请求里，PlaybackInfo 和 master/main.m3u8 均携带 `SubtitleStreamIndex=-1`，均 HTTP 200，但没有显式 SubtitleMethod。该 Emby 仍生成 `subtitles@` 默认字幕烧录过滤器。22:46:11、22:47:11、22:48:12 等分片返回 HTTP 500 / Error starting ffmpeg，关联日志含上游 HTTP 403、Failed to load fontconfig fonts 及退出码 137。退出码不足以证明 OOM；上游 403 在成功转码中也可能出现，不能单独认定为致命根因。

独立临时设备/会话只读取少量媒体，不干预用户房间：

- 原参数对照：master/main 200，首分片 500、2326 字节，无 MPEG-TS。
- 增加 `SubtitleMethod=External`：两轮 master/main 200，首分片 200、各读取 262144 字节，验证连续三个 TS 同步字节，约 1.8 秒返回。对应日志没有字幕烧录过滤器，实际编码输出约 91 帧 / 3.9 秒。
- 每轮对自己的 PlaySessionId 上报 Stopped 并删除该独立设备的 ActiveEncodings，均 204。没有修改用户账号、服务器设置或原始存档。
- 原画只读探测协商允许直放，但媒体接口返回 302 至另一入口；未在本次探测中继续携带 Emby 授权跳转，不能宣称原画实际解码通过。

官方接口区分 [External 独立字幕与 Encode 烧录](https://dev.emby.media/reference/pluginapi/MediaBrowser.Model.Dlna.SubtitleDeliveryMethod.html)，[HLS 接口](https://dev.emby.media/reference/RestAPI/DynamicHlsService/getVideosByIdMasterM3u8.html)支持显式指定 SubtitleMethod。对照测试支持客户端明确声明所需传输方式来规避当前服务默认烧录行为。

## 修改与本地检查

所有转码 URL 统一设置 SubtitleStreamIndex 和 SubtitleMethod。关闭或文字字幕使用 `-1 / External`，图片字幕明确需要烧录时使用所选索引和 Encode；大小写重复旧参数删除。覆盖自建备用 HLS 与 Emby 返回的 TranscodingUrl，直放路径不变。

- 回归先在旧实现失败：备用 HLS 未提供 SubtitleMethod；服务器返回混合大小写 Encode 参数未规范化；所选图片字幕未规范化。
- 修改后 `watch-player-test.mjs` 与 `watch-load-race-test.mjs` 全部通过，后者 19 项，覆盖上述情形及跳转、换片、恢复、授权、有限重试与会话清理。
- `node scripts/regression.mjs` 全部 20 个确定性检查通过；`node scripts/package-retention-test.mjs` 当前市场清理、APK 指纹复用、不可变包名及失败保留检查通过。未扩展无关界面/实机检查。
- 使用实际修复的 WatchRoom.load、HLS.js、无头 Edge 和真实条目，在独立本地房间夹具中完成首帧与连续播放：1920×1080、readyState=4，3.009→5.438 秒，视频解码字节 287300→2130011，音频 49866→83679，无页面/播放器错误，3 个分片均 200。测试静音，未验证扬声器输出、完整剧集、PC 原生或 Android 实机；这不是公网房间联机验证。独立测试会话已清理，原始存档未改。
- 正式 CI/产物验证尚待完成。排查工具位于本机忽略目录 `server/target/emby-diagnosis/`，未将授权数据写入脚本。

## 发布与部署

预备版本：宿主/服务端 0.9.5，Android code23，电影厅 1.0.5；翻棋、矿工保持 1.0.4。原生源码未改，Android 沿用不可变 v103，市场继续只分发每个插件当前最新版。更新电影厅后重建旧房间。

- [x] 本地相关回归、真实浏览器首帧与短时持续播放。
- [ ] 冻结提交、推送 main、正式 Actions 完成。
- [ ] APK/EXE、市场签名与所有文件散列、脚本源码一致性、镜像摘要验证。
- [ ] GitHub 正式发布，通知既有部署线程部署第一台，公网核验。

本次没有关机授权，任何发布或部署结果不得提前写成通过。
