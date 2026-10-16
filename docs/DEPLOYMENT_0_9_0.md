# 0.9.0 第一台部署记录

日期：2026-10-16（北京时间）。仅更新第一台；第二台未操作，本线程未关机。

## 发布与运行

- 部署前通过 GitHub API 核对 [Actions 38838088595](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/38838088595) 为 success，精确 revision `f8c70258aecbbaed001ca5d87b112cde65efb9ef`。
- 拉取标签 `ghcr.io/linhuig/chinese-chess-flipping:sha-f8c7025`，核对 revision 后为本地 latest 打同一镜像标签，再按原 Compose 重建。运行索引摘要 `sha256:06052e5296332c54c0f035588c8ba988730a6e9461a7ade50276ba7571261d56`。
- 容器 running、重启计数 0，日志 protocol=3；保留 TCP/UDP 8888、HTTP 80、原反代及网络配置。
- 备份批次 `20261016-103235`，原部署目录 backups/ 同名目录保存 Compose 与 update.sh；回滚标签 `fqgame-server:rollback-20261016-103235`，旧摘要 `sha256:bd5c1c0b148d97eb4425654ffd7b39c5fd4d6f67901712407692658de7866f78`（0.8.4）。

## 已验证

- 公网 TCP v3 完整加密握手/PONG、WSS READY/PONG、UDP 新票据发现成功。TCP/WSS READY 均验证 serverVersion=0.9.0 及 room-sync、room-broadcast、host-grant、room-descriptors 四项能力。
- 临时建房验证 CREATE metadata 原样保存非 JSON 字符串、LIST 不指定 roomType 可列出该房间；测试后主动 CLOSE，未保留测试房间。
- 公网 index.html、app.js、plugin-runtime.js、plugin-store.js、plugin-package.js、plugin-trust.json、transport.js、microphone.js、microphone-worklet.js、style.css 与目标提交逐字节一致。
- 公网 /plugins/catalog.json 的 ECDSA P-256/SHA-256 P1363 签名通过，信任公钥与提交一致；目录含三个官方 1.0.0 发布。三个插件的 web/android/windows 共九个 JSON 全部经服务器侧同一域名 HTTPS 反代完整读取，大小/散列及包内 manifest 与签名目录一致。
- 两个宿主包和电影厅两种原生组件亦完整 HTTPS 下载校验通过。为避开公网路径间歇超时，完整文件检查在服务器把该域名解析到回环反代，仍校验证书和域名；不将此称为所有大文件均从本机公网下载成功。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Android 宿主 0.9.0 / code18 | 2243828 | d87e51b5508665135e5aca1c8d056be5de95f66c36e6629aed3a0f05cd604653 |
| Windows 宿主 0.9.0 | 11811840 | ba95c80c333a96cfc7e46a64ae81949589675c117406cb3644909caba0ceca64 |
| official.chess 各平台 JSON | 182799 | bd4455569b55b65f961a97be4f21bf05b4224d2a310816ebca2c0da9b989815a |
| official.miner 各平台 JSON | 5664296 | 582e93c102ce3391627f6e56d6ee445109fe9c1640dc7c105e55d6f68ea5c6f6 |
| official.watch 各平台 JSON | 1112082 | efe3306ea7cb8023e30a88f069454922dd54265b90490602b1ea0c3c5ba3ec03 |
| 电影厅 Android 组件 | 4235437 | 8e6b1ed8565475cbfe5bcfd97b6f1d4016bd2ad179ffc76a75ea9bb9a4ce1646 |
| 电影厅 Windows 组件 | 81663488 | 82807580a6419ad4f4b1ba6a653237d85c09e82ba5a84479135a6ba7982bd460 |

JSON 路径为 `/plugins/{id}/1.0.0/{web|android|windows}-{对应散列}.json`。电影厅原生路径为 `/plugins/official.watch/1.0.0/native-{对应散列}.apk` 或 `.exe`，均与签名目录匹配。宿主沿用 /api/app/version、/api/app/latest.apk、/api/desktop/version、/api/desktop/latest.exe。

## 异常与边界

- 原 Docker daemon 代理指向本机 1080，但该端口未监听，常规 pull 失败。独立 containerd 下载可取索引，但镜像层连接重置/速度慢；已停止并清理该临时下载引用和日志。
- 本次用仅绑定服务器回环地址的临时 SSH 转发连接本机现有代理，成功拉取精确标签后立即关闭。未重启 Docker、未改全局代理或其他容器、未公开额外端口；最后确认临时监听已消失。
- **自动更新配置与 active 定时器保留，但原 Docker 代理故障仍在：恢复代理前，未来自动拉取可能继续失败并保留旧服务。** 本次部署完成不等于此运维问题已修复，需主线程知悉后安排处理。
- 初次连接/资源探测发生在容器重建完成前而命中旧版本，完成后重测通过；本机部分 JSON 下载间歇超时，改用服务器 HTTPS 完整校验通过。已停止被替代的下载检查进程。
- 未在本线程验收三端实际安装/启用插件、媒体播放或真实游戏；这些由主线程继续。本记录只暂存、不提交推送，不改主线程状态/README/验收文档，不包含凭据。
