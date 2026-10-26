# 0.9.4 第一台部署记录

2026-10-27 01:30（北京时间）。第一台部署及发布主线程独立公网核验完成，第二台未操作。部署线程只暂存原始记录，由发布主线程合入验收结果并提交推送，随后按本轮用户授权关机；实际关机安排以工具结果为准。

## 正式版本与镜像

- 主线程转达本轮用户部署授权，直接查询 [Actions 40360043136](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/40360043136) success 和完整提交 `7fa8a6e232bd7adc28e9394b79655cffe21fcfbd`。[v0.9.4](https://github.com/LinHuiG/chinese-chess-flipping/releases/tag/v0.9.4)。未部署首轮候选。
- 本机通过既有 Clash 下载 OCI。精确验证 index `sha256:d484ee3576836e55a4a774abb6c52740563fa863ca42d989acdeca6ea2a5baa9`，按索引选择 amd64 实际镜像 manifest `sha256:85205508923fd4a214c467334d1cc42322629e7906419c582942ab2e60128f07`，逐层散列及完整 revision 均通过。
- 目标大层长度 96738049，摘要 `sha256:e652fbb2fd47233073f3378cf5a24268f87e2654b4999d93a17288ca65bb0e87`。首次整流多次低速超时；混用早期断点的分段下载完成后整层散列不符，局部重下仍不符，均未导入。最终从偏移0重新分段下载整个大层，两路并发、2MiB分段、有限重试、逐段核对Content-Range及长度并按固定偏移写入，完整OCI摘要通过。未确认前两次损坏的具体原因，不将其解释为上游镜像错误。
- 最终镜像包104202240字节，SHA256 `712a3a2943bd515449df20cba67050a4a691eaf2ad346507da3a94f245f1fa2e`，SFTP上传26.1秒。服务器再次核对包散列，导入 `ghcr.io/linhuig/chinese-chess-flipping:sha-7fa8a6e`，image ID与上述实际manifest一致，revision与冻结提交一致。
- 给已核验镜像标记本地latest，再用原Compose `up -d --no-build --pull never`重建，未按可变标签重新网络拉取。容器北京时间01:24:35启动，最终running、restarts=0，日志protocol=3 TCP=8888 HTTP=80 UDP=8888。

## 配置与回滚

- 原部署目录 `backups/20261027-094/` 保存compose.yaml、update.sh，与部署后文件逐字节相同。timer active，原网络、TCP/UDP8888、内部HTTP反代保留；NPM网站80/443公网绑定、管理81本机绑定保留。
- 回滚标签 `fqgame-server:rollback-20261027-094` 指向旧0.9.3，image ID `sha256:2a0fe8b6993b9e83fd5966f03f104d26a124eb0bcd36de5e8f9b4d0bf62c7d82`。需要回滚时可将其重新标记为原latest，再用原Compose禁止拉取重建。回滚镜像只保留在部署备份中，不对外分发旧插件。
- 新镜像包保存在原部署目录 `backups/image-094.tar`。
- 既有Docker代理探测仍返回Proxy CONNECT aborted，未改全局代理；每日自动拉取的代理故障仍需另行处理。

## 已验证

- 公网HTTPS、TCP v3完整加密握手/PONG、WSS READY/PONG、UDP新票据发现通过，版本0.9.4。
- Android元数据0.9.4/code22，完整公网下载2252499字节，SHA256 `85e1b533d4fbe145f3776a352a00522f4b8f9c49682a0c15d9c509a5b5efc68d`。
- Windows元数据0.9.4，完整公网下载11857408字节，SHA256 `52a32370c63f9773ec6100ddfff678cd78a15b8cd78f828064d0106f40ab3577`。
- 公网十份宿主资源与冻结提交逐字节一致：index.html、app.js、plugin-runtime.js、plugin-store.js、plugin-package.js、plugin-trust.json、transport.js、microphone.js、microphone-worklet.js、style.css。
- 公网市场P-256签名通过，信任根与冻结提交一致，catalog SHA256 `e8cfa208a307bfb6e35802bbc70eff40f5399fbb2c39c7748553c8575b1a6c65`；仅三个1.0.4发布。
- 当前9份跨平台JSON长度/散列/manifest及2份原生组件长度/散列全部通过。此11文件在服务器经同域名HTTPS/NPM读取，仅临时resolve到回环，仍验证TLS；不声称这些全部从本机公网下载。
- 导出运行容器文件目录检查：app/plugin-market/只有catalog及三个1.0.4目录下的11份当前产物，无旧目录及未引用文件。新镜像没有shell，因此使用docker export只读枚举。
- 部署前保存的44个旧插件JSON/APK/EXE公网路径逐一返回404；旧版本不再对外提供。保留的签名安全元数据不等于旧包分发。
- 公网资源首轮读取超时，串行重试后通过；旧清单读取脚本首次因Windows默认GBK报错，显式UTF-8后44路径检查通过。这两项没有修改产品逻辑或超时。
- 本线程未进行Android实体机流畅度、真实跨端业务及正式EXE电影播放验收，不将文件和连通检查等同这些验收。

下载任务均结束，上传和SSH连接关闭后由主线程继续公网核验。本文不含服务器IP、账号、密码、认证头或签名URL，原有暂存和未跟踪改动保留。

## 发布主线程独立公网核验

- HTTPS 首页与更新元数据、TCP v3 完整加密握手/PONG、WSS READY/PONG、UDP 新票据发现通过。APK/EXE 全量公网下载大小、散列与正式 CI 及公开发布附件相同。
- 公网签名目录与正式目录逐字节相同，生产 P-256 签名、仅三个 1.0.4 发布、9 份 JSON 完整大小/散列通过；当前两个原生组件首尾共 4 次 Range 206 的 Content-Range 及字节与本地正式文件一致。
- 独立遍历原 44 个下载路径全部返回 404；14 份宿主网页资源逐字节匹配冻结提交。
- 真实公网双浏览器检查通过：安装三个签名插件、按房间补装翻棋、插件存储/原生对象隔离、双方准备开局、房主刷新恢复、退出解散。使用独立测试房间，结束后浏览器已关闭，无页面脚本错误；不代替原生客户端或 Android 实机验收。
- 初轮 HTTPS 请求发生 WinError 10054 连接重置，市场两轮 45 秒读取超时；连通针对性检查恢复后，安装包与协议复验通过。市场改为逐文件下载并使用有界重试，最终全部通过；调整仅在忽略目录的验收脚本，不改变产品超时。
- 证据目录：`server/target/release-0.9.4/final/`；完整结果为 `public-health-retry.log`、`public-market-audit.json`、`public-market-audit-serial.log`、`public-plugin-smoke.log`，首次失败日志同目录保留。
