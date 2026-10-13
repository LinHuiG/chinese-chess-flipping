# 0.8.1 第一台部署记录

日期：2026-10-14（北京时间）。仅更新第一台，未操作第二台、未关机。由开发线程统一整理最终交付；本记录不修改其负责的状态、README 和验收文档。

- 发布前核验 Actions 38443429352：APK/检查、Windows、amd64、arm64、多架构索引五项全部成功。部署提交为 `5b1813ab4d17a01fcd5e0c031c87908ef821b622`。
- 运行镜像索引：`sha256:b2616ff4b060eb58b20ddb8177afa774944204fe753ec52ccb613e38a5fafc49`。容器 running、重启计数 0，日志 protocol=3；原 TCP/UDP 8888、HTTP 80、反代网络和自动更新配置保留，timer active，相同镜像跳过重建逻辑保留。
- 回滚备份批次 `20261014-021853`：服务器原部署目录下 backups/ 同名目录保存 Compose 和更新脚本，旧镜像标签 `fqgame-server:rollback-20261014-021853`。旧摘要 `sha256:da7ca88e61b635561e5f6495e66924e7794bc9cb63cbe69b1e369307e3743f0d`。如回退须同时考虑旧服务端缺少新客户端能力，不能承诺新客户端继续兼容。
- HTTP 返回 301，HTTPS 页面显示 0.8.1；TCP v3 完整加密握手和 PONG、WSS READY/PONG 均通过。两种 READY 均验证 serverVersion=0.8.1，capabilities 包含 room-sync、room-broadcast、host-grant。UDP 新票据登记并收到 WSS 地址事件成功。
- APK 公网版本清单为 0.8.1 / versionCode 14；完整下载 4534497 字节，SHA-256 `3ac547baca37feb20771729d22bbce7e8c67bd6da652c3d7f1531b2502bfa792`，与清单匹配。
- Windows 公网清单为 0.8.1 / windows / x64 / portable，requiresWebView2=true，文件名 CyberRoom-0.8.1-windows-x64.exe；完整下载 12048384 字节，SHA-256 `c07ccc88d5b5a5d50e225ebb1285014693136d31152c2b315dc2a23db3c60a0c`，与清单匹配。接口为 /api/desktop/version 和 /api/desktop/latest.exe。
- 异常：等待发布期间原 SSH 空闲连接失效，首次更新命令未执行；重连核对容器启动时间、镜像、备份目录和进程后确认无部分部署，再执行成功。未发生重复重建或回滚。
- 部署线程完成基础公网检查后，开发线程以本地最终 PC 包及线上下载的正式 Windows EXE 分别验证默认 TCP 建房、房主连接用户提供的 HTTP Emby 并取得片库、网页 WSS 成员加入及权限、两人计数、房主退出解散，均通过。正式 EXE 下载散列和实际启动亦通过。临时检查脚本和登录信息不入库；本记录由开发线程统一收录提交。
