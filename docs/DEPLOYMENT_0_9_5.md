# 0.9.5 第一台部署记录

2026-10-27 23:44（北京时间）。第一台部署及部署线程检查完成，随后主线程独立公网核验通过；第二台未操作。部署线程只暂存原始记录，由主线程合入下方独立结果并提交推送，之后按用户本次授权关闭本机；实际关机安排以主线程工具结果为准。

## 发布与部署

- 主线程转达本轮用户部署授权。正式提交 `c998722b84a03e7b6a27b3f70d87cf67efe6ae21`，[v0.9.5](https://github.com/LinHuiG/chinese-chess-flipping/releases/tag/v0.9.5)，[Actions 40526599271](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/40526599271)。本线程匿名API查询遇共享限流403；读取主线程提供的认证API快照，确认相同完整SHA、success及五项job全部success，不声称本线程独立认证API查询通过。
- 本机Clash下载，精确验证index `sha256:339bd36c7edd5c04d53f50bdbba02820348c494a8e609c6f3f7d8dcd5e7d147b`，从索引选择amd64实际manifest `sha256:0f42336ef7135a96689f2af9d952fa0b36cebcec82a59187538919bf85731f70`，逐层散列及完整revision通过。
- 分段使用Accept-Encoding identity，精确206/Content-Range总长度和每段字节数检查；仅覆盖整个小blob的200响应允许整块接收。三路、2MiB、有限重试、固定偏移写入。约63MiB处一段重试耗尽，停止该次下载及子进程，仅保留已经完整核验的前62914560字节并记录前缀SHA256，再补取缺失范围；新增完成范围另记录散列校验点，不复用未验证部分。最终整层96738168字节，OCI SHA256 `3f3d640cfbe0d1204f2796b3d6fb889197a95368f38e356d64e2b7ad8a71d26d`通过。
- OCI包104202240字节，SHA256 `276464506cae24899a709422c698d811f5e64434dc8a27f84716749e94ada106`。SFTP上传23.8秒，服务器再次验证同一包散列后导入精确标签 `ghcr.io/linhuig/chinese-chess-flipping:sha-c998722`。
- 导入后的image ID与上述amd64 manifest一致，revision与冻结提交一致。将已验证镜像标记为本地latest，用原Compose `up -d --no-build --pull never`重建，未按可变标签重新网络拉取。北京时间23:42:54启动，最终running、restarts=0；日志protocol=3 TCP=8888 HTTP=80 UDP=8888。

## 配置与回滚

- 原部署目录 `backups/20261027-095/` 保存compose.yaml、update.sh，与部署后文件逐字节一致，自动更新timer active。
- 回滚标签 `fqgame-server:rollback-20261027-095` 指向旧0.9.4，image ID `sha256:85205508923fd4a214c467334d1cc42322629e7906419c582942ab2e60128f07`。可重新标记为原latest，再用原Compose禁止拉取重建。该回滚保护不对外分发旧插件。
- 上传包保存于原部署目录 `backups/image-095.tar`。保留原网络、TCP/UDP8888、内部HTTP反代及NPM网站公网80/443、管理本机81绑定。
- 既有Docker代理仍返回Proxy CONNECT aborted，未修改全局代理；每日自动拉取的既有故障仍需另行处理。

## 核验

- 公网HTTPS、TCP v3完整加密握手/PONG、WSS READY/PONG、UDP新票据地址发现通过，版本0.9.5。
- Android元数据0.9.5/code23，完整公网APK下载2252503字节，SHA256 `3c5b12b87eddf642ba56a8753cfa2b07783b845c7bd22c1310ea4887371d96c8`。
- Windows元数据0.9.5，完整公网EXE下载11857408字节，SHA256 `753ac8899bfa8ae57c55d843e325ae312ebbb86a016908ff1327778a4baec085`。
- 公网十份宿主资源与冻结提交逐字节一致：index.html、app.js、plugin-runtime.js、plugin-store.js、plugin-package.js、plugin-trust.json、transport.js、microphone.js、microphone-worklet.js、style.css。
- 公网P-256市场签名及固定信任根通过，catalog SHA256 `95849ea45fd4a5a2157f7f05b2b2e71f1524ae23ca0243f774f8aee3439575a1`。仅三条：翻棋1.0.4、矿工1.0.4、电影厅1.0.5，未误删两款当前游戏。
- 全部9份跨平台JSON长度/散列/manifest及2份原生组件长度/散列通过。此11文件检查在服务器经同域名HTTPS/NPM完成，仅临时resolve到回环、仍校验TLS，不声称全部从本机公网下载。
- 只读导出运行容器目录核对，市场仅catalog和上述三个当前目录内的11个产物，没有其他旧版文件。主线程market-audit.json列出的5个电影厅1.0.4退役公网路径均返回404。
- 本线程未重复真实片源首帧、原生实机、跨端播放或完整剧集验收，不将部署检查等同播放验收。

所有下载、上传及检查任务已结束，SSH/SFTP连接关闭，未遗留后台下载。本文无服务器IP、账号、凭据、认证头或签名URL；保留原暂存与未跟踪改动。

## 主线程独立公网核验

- 正式市场生产签名与 catalog 完整 SHA256 同上，只有翻棋/矿工 1.0.4、电影厅 1.0.5。
- 9 份跨平台 JSON 完整大小及 SHA256、两份原生组件首尾共 4 次精确 Content-Range/长度及实际字节与正式产物一致。
- 14 份宿主资源与冻结 Git 对象逐字节相同，5 个旧电影厅路径均 404，Android 0.9.5/code23 和 Windows 0.9.5 元数据正确。
- 此检查从主线程本机经公网 HTTPS 访问，没有修改 hosts、服务器配置或全局代理；它不替代影片持续解码或原生实机验收。完整结果在本机 `server/target/release-0.9.5/public-market-audit.json`。
