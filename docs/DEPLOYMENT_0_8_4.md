# 0.8.4 第一台部署记录

日期：2026-10-16（北京时间）。只更新第一台，第二台未操作；本线程未安排关机。

- 发布依据：[Actions 38773156362](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/38773156362)。部署命令首先验证精确提交 `cbd3f72af45ce0eccd8c1db3e9fd0b85dd3f892a`、run success，以及 APK/检查、Windows、amd64、arm64、多架构索引五项全部 success，条件满足后才备份和部署。
- 运行标签 `ghcr.io/linhuig/chinese-chess-flipping:latest`，运行 revision 精确匹配；索引摘要 `sha256:bd5c1c0b148d97eb4425654ffd7b39c5fd4d6f67901712407692658de7866f78`。容器 running、重启计数 0，日志 protocol=3。
- 保留 TCP/UDP 8888、HTTP 80、原反代网络和安全配置；自动更新 timer active，相同镜像跳过重建逻辑保留。
- 回滚备份批次 `20261016-011053`：原部署目录 backups/ 同名目录保存 Compose 和 update.sh；标签 `fqgame-server:rollback-20261016-011053`，旧摘要 `sha256:54db37241e7a547fc6b137dfe8f8a875f57b69716e60d2afc02464ac29206d3f`（0.8.3）。
- TCP v3 完整加密握手/PONG、WSS READY/PONG、UDP 新票据地址发现均通过；TCP/WSS READY 均验证 serverVersion=0.8.4 与 room-sync、room-broadcast、host-grant 三项能力。
- APK 0.8.4 / versionCode 17，完整公网下载 9303496 字节，SHA-256 `2d75a767f0de2acf30a457fa07eca98307d2ad167dd7cfb19c8f9d4554fd9574`，与接口清单一致。
- Windows 0.8.4 / windows / x64 / portable / requiresWebView2=true，文件 CyberRoom-0.8.4-windows-x64.exe；完整公网下载 94045696 字节，SHA-256 `759e7ce7553c611afae898a24afa3e767237d01c8178a987aaeb269fd756b5a2`，与清单一致。
- 服务器侧经公网 HTTPS 读取 index.html、app.js、watch.js、watch-save.js、miner.js、miner-view.js、voice.js，七项 SHA-256 均匹配目标提交中的原始文件。初次从本机额外检查网页遇到一次读取超时，后续服务器侧验证通过；本机 HTTPS 页面/版本与两包完整下载均成功。
- 原更新 SSH 通道返回结果延迟，另开只读连接确认部署已完成，再核验实际运行 digest/revision、回滚标签、日志与配置，未重复部署。未发现容器运行异常，未执行回滚。
- 本线程未复验片源播放、连续跳转、全屏、存档及三端业务；第三方 Web 转码间歇失败边界沿用主线程说明，不将基础连接和包校验通过表述为全部播放问题解决。
- 仅暂存本记录，未提交推送；未修改主线程负责的状态/README/验收文档，保留原工作区改动，凭据不入库。最终业务复验、归档与用户本机关机由主线程负责。
