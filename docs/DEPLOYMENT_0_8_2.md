# 0.8.2 第一台部署记录

日期：2026-10-14（北京时间）。只更新第一台，未操作第二台，未安排关机。

- 发布依据：[Actions 38553293765](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/38553293765)，精确提交 `deefaaebedbe97a170f17c8c1d9850630f34457f`。通过服务器网络读取 GitHub API，确认该提交 run 为 success，APK/检查、Windows、amd64、arm64、索引五项全部 success 后才开始部署。
- 拉取并运行标签 `ghcr.io/linhuig/chinese-chess-flipping:latest`；运行 revision 与目标一致，索引摘要 `sha256:a01c8d5ca66039b8e25f50bd7b74ab464aa97b8f6b392817473ef69bd2ccaf18`。容器 running、重启计数 0，日志 protocol=3。
- 保留 TCP/UDP 8888、HTTP 80、原反代与网络、安全选项。自动更新 timer active，镜像相同且运行正常则跳过重建逻辑保留。
- 备份批次 `20261014-190907`：原部署目录 backups/ 同名目录保存 Compose 和更新脚本；回滚标签 `fqgame-server:rollback-20261014-190907`，旧镜像摘要 `sha256:b2616ff4b060eb58b20ddb8177afa774944204fe753ec52ccb613e38a5fafc49`（0.8.1）。
- HTTPS 页面显示 0.8.2；TCP v3 完整加密握手/PONG、WSS READY/PONG、新票据 UDP 登记与 WSS 地址发现事件均通过。TCP/WSS READY 均确认 serverVersion=0.8.2，能力包含 room-sync、room-broadcast、host-grant。
- APK 公网清单 0.8.2 / versionCode 15，完整下载 4538357 字节，SHA-256 `0ab120c00fc266d468bf1a8a2cb9656a47b1d46c40a8dab96fa1e6df8644cc74`，与清单一致。
- Windows 公网清单 0.8.2 / windows / x64 / portable / requiresWebView2=true，文件名 CyberRoom-0.8.2-windows-x64.exe；完整下载 12048384 字节，SHA-256 `7847bbee3c30ff1d19d5cac7cd7b0ae16ae478d8a40870424d4ac26ab3d91d56`，与清单一致。接口 /api/desktop/version、/api/desktop/latest.exe 均正常。
- 部署及基础验收无异常，未实施回滚。主线程随后完成正式 Windows 包矿工与 Android/Web 无片源语音、弹幕的公网复验，详细结果及边界见 [执行记录](../PROJECT_STATUS.md)。本文件记录部署线程的基础验收范围。
- 部署线程仅暂存此记录，未自行提交推送；未修改主线程独占的 PROJECT_STATUS.md、README.md、docs/ACCEPTANCE_0_8_2.md，保留原工作树改动。主线程业务复验后统一归档。凭据与临时探测脚本不入库。
