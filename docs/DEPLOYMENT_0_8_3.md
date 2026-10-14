# 0.8.3 第一台部署记录

日期：2026-10-15（北京时间）。只更新第一台，第二台未操作；本线程未安排关机。

- [Actions 38615519118](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/38615519118)：部署前通过 GitHub API 确认精确提交 `2c904b4cbf77b8fe95934c0a9c6715fe2b0890c2`、conclusion=success。
- 拉取部署 `ghcr.io/linhuig/chinese-chess-flipping:latest`，运行 revision 与目标一致。镜像索引摘要 `sha256:54db37241e7a547fc6b137dfe8f8a875f57b69716e60d2afc02464ac29206d3f`，容器 running、重启计数 0，日志 protocol=3。
- 保留原 TCP/UDP 8888、HTTP 80、反代及自动更新；timer active，相同镜像跳过重建逻辑保留。
- 回滚备份批次 `20261015-025431`：原部署目录 backups/ 同名目录保存 Compose 和 update.sh；旧镜像标签 `fqgame-server:rollback-20261015-025431`，旧摘要 `sha256:a01c8d5ca66039b8e25f50bd7b74ab464aa97b8f6b392817473ef69bd2ccaf18`（0.8.2）。
- 公网 HTTP 301，HTTPS 页面 0.8.3，静态资源与版本接口正常。TCP v3 完整加密握手/PONG、WSS READY/PONG、新票据 UDP 地址发现均通过。TCP/WSS READY 均验证 serverVersion=0.8.3，能力含 room-sync、room-broadcast、host-grant。
- APK 0.8.3 / versionCode 16，完整公网下载 9293698 字节，SHA-256 `d3a9c784ef2b0a7666f49c52b4daf960589e7b252fe17b9b3fb944baf60c6059`，与接口清单匹配。
- Windows 0.8.3 / x64 / portable / requiresWebView2=true，文件 CyberRoom-0.8.3-windows-x64.exe；完整公网下载 93937152 字节，SHA-256 `415139fdacef22bcc72019892b1b5e111a786f3eeed487f02d7a92c50b664bc6`，与清单及主线程指定正式包匹配。
- 部署与基础验收无异常，未回滚；未在本线程启动正式 EXE，也未验收具体片源播放。已知第三方 EAC3 片源在网页/部分 Android 仍需兼容转码，本次用户已接受带限制发布，不将基础下载/连接通过表述为音频兼容问题已修复。
- 部署线程产出时仅暂存，交由主线程汇总提交；未修改主线程负责的 PROJECT_STATUS.md、README.md 和验收文档。原有工作区改动保留，凭据不入库。最终业务复验、归档和本机关机由主线程负责。
