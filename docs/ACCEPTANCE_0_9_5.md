# 0.9.5 Emby S02E01 播放修复与验收

2026-10-27 晚间，正式发布、第一台部署及独立公网核验完成。用户授权客户端修复和验证后直接提交推送发布，再通知既有“部署线程”部署第一台 fqgame.tdcode.tech；随后直接追加部署及公网核验成功后关闭本机，未完成或失败不得提前关机，第二台不操作。未使用子代理或 dsh。凭据仅在内存使用，原始本机存档未修改。

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
- 正式 CI/产物验证见下文。排查工具位于本机忽略目录 `server/target/emby-diagnosis/`，未将授权数据写入脚本。

## 发布与部署

正式版本：宿主/服务端 0.9.5，Android code23，电影厅 1.0.5；翻棋、矿工保持 1.0.4。原生源码未改，Android 沿用不可变 v103，市场继续只分发每个插件当前最新版。更新电影厅后重建旧房间。

冻结代码 `c998722b84a03e7b6a27b3f70d87cf67efe6ae21` 已推送 main；[Actions 40526599271](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/40526599271) 五项全部成功。[v0.9.5](https://github.com/LinHuiG/chinese-chess-flipping/releases/tag/v0.9.5) 已公开，Git 标签指向冻结代码，三份附件的 GitHub digest、大小和内容散列均与正式 CI 产物匹配；公开 SHA256SUMS.txt 已独立下载并逐字节核对。匿名 API 随后限流，正式状态通过带认证 API 核对，不将限流误认为构建失败。既有部署线程已完成第一台更新及核验，主线程独立公网检查通过。

- [x] 本地相关回归、真实浏览器首帧与短时持续播放。
- [x] 冻结提交、推送 main、正式 Actions 完成。
- [x] APK/EXE、市场签名与所有文件散列、脚本源码一致性、镜像摘要验证。
- [x] GitHub 正式发布，通知既有部署线程部署第一台。
- [x] 第一台部署完成及主线程独立公网核验。

## 正式产物

| 文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| CyberRoom-0.9.5.apk | 2252503 | `3c5b12b87eddf642ba56a8753cfa2b07783b845c7bd22c1310ea4887371d96c8` |
| CyberRoom-0.9.5.exe | 11857408 | `753ac8899bfa8ae57c55d843e325ae312ebbb86a016908ff1327778a4baec085` |
| SHA256SUMS.txt | 174 | `6785492adfb1128a68c1fb00eb9db5e561714e3555b14f8b1265d8ae27b7e324` |

- 正式归档完整 SHA 与 Actions digest 相同，ZIP CRC 通过；APK 0.9.5/code23、EXE PE 文件版本与产品版本均 0.9.5。APK 的 v2 证书身份与 0.9.4 相同（`13f2ad7aca152212b823bb65551dcd5cadf1c65576b071413ae1c678f711ecb8`），签名密码学校验由成功 CI 的 apksigner 完成；14 份内置宿主资源与冻结 Git 对象逐字节相同。
- 市场仅 3 条当前发布、11 文件，生产 P-256 签名和全部完整大小/散列通过；9 个平台脚本与冻结源码 fresh bundle 完全相同，无测试注入。catalog SHA `95849ea45fd4a5a2157f7f05b2b2e71f1524ae23ca0243f774f8aee3439575a1`。Android v103 的版本/包名/入口/源码指纹/散列不变，四条不可变包名约束继续保留；五条旧电影厅下载路径已从归档删除，两款当前游戏未误删。
- 镜像 `ghcr.io/linhuig/chinese-chess-flipping:sha-c998722`，index `sha256:339bd36c7edd5c04d53f50bdbba02820348c494a8e609c6f3f7d8dcd5e7d147b`。amd64 构建 digest `sha256:143b09c176b815dab1e2798f4dcb730925b375be83cad220406024db71e66011`、实际 manifest `sha256:0f42336ef7135a96689f2af9d952fa0b36cebcec82a59187538919bf85731f70`；arm64 构建 digest `sha256:d744341ca14889c93b99a73fa3c91ee022d7ff3aa8451e53c31d6285fc479e88`、实际 manifest `sha256:3c3da2b053b6fc2edce94d524e4b5b36debedab7c81fc956cdb025ee7e5ee96a`。注册表完整字节摘要、两个架构及 config revision 与冻结源码和 CI 匹配。
- 市场 96,683,979 字节归档首轮有一个约 3 MB 的子范围超时；复用已完成范围，只重新请求缺失范围，精确 Content-Range/长度及完整最终 SHA 通过后才解压核验。镜像查询首轮网络错误，重试成功；未修改产品网络设置或超时。证据和正式附件位于本机 `server/target/release-0.9.5/`，诊断授权未入库。

## 第一台部署与公网结果

- 部署线程校验每个镜像层、最终 OCI 包及上传服务器后的完整散列，导入上述固定镜像。北京时间 23:42:54 启动，容器 running/restarts=0、revision 正确；原配置和端口保留，本地 0.9.4 回滚准备就绪。下载中某个分段重试耗尽，保留已核对范围后只补缺失数据，最终 OCI 摘要通过；完整过程见 [部署记录](DEPLOYMENT_0_9_5.md)。
- 部署线程公网 HTTPS、加密 TCP 握手/PONG、WSS READY/PONG、UDP 发现、APK/EXE 完整下载散列通过；服务器经同域 HTTPS 读取全部 11 份当前市场文件并完整核对散列，不冒充全部由主线程从本机公网完整下载。
- 主线程独立验证生产市场签名/完整 catalog SHA、9 份 JSON 完整大小及 SHA、两份原生文件首尾共 4 次精确 Range 206 字节、14 份宿主资源与冻结源码逐字节、5 个旧电影厅路径 404；Android 0.9.5/code23 和 Windows 0.9.5 元数据正确。两款当前游戏 1.0.4 保留，电影厅 1.0.5，无旧电影厅分发。报告为本机 `server/target/release-0.9.5/public-market-audit.json`。
- 全部下载、上传、检查和 SSH/SFTP 连接已结束。第二台未操作，既有 Docker 每日自动拉取代理故障未修改、另行处理。本次没有新增原生设备、完整剧集或公网观影房间业务联测；保留前述真实片源浏览器解码通过的实际范围。
- 归档提交推送后按用户本次直接授权关闭本机，实际执行安排以本线程工具结果为准。
