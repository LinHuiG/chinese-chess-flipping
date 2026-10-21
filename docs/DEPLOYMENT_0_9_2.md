# 0.9.2 第一台部署记录

2026-10-21 08:43（北京时间）。第一台部署完成，第二台未操作。本线程不关机，由发布主线程独立公网核验并收尾。仅暂存本文，不提交推送。

## 发布与镜像

- 发布主线程转达用户完成后发布并部署的授权；本线程直接核对 [Actions 39519265770](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/39519265770) 的 completed/success 和完整提交 `1a21902a32eaead42cc6e80028556af5159cfe07`。[v0.9.2](https://github.com/LinHuiG/chinese-chess-flipping/releases/tag/v0.9.2)。
- 通过本机 Clash 下载，精确验证多架构 index `sha256:c4bfc6757b1270e1decca3165495b0cfb79ead2349bbdea48bf9c76a6a91005d`，由此选择 linux/amd64 manifest `sha256:5ab0de20d4fbda867360732804ecf20b92289d41706977d92e226cab4ee1ccc4`，逐层校验并核对 config revision。
- 本机无需 Docker，OCI 镜像包 297543680 字节，SHA256 `97058e2a58bc819494629e331963ae0517a0176510543310e6e3692093850377`；SFTP 上传 70.9 秒。服务器再次核对包散列后导入精确标签 `ghcr.io/linhuig/chinese-chess-flipping:sha-1a21902`。
- 导入后验证 image ID 为上述 amd64 摘要、revision 为完整提交；将此已验证镜像标记为本地 latest，原 Compose 使用 `up -d --no-build --pull never` 重建，因此本次没有按可变标签重新从网络取镜像。
- 容器 08:42:21 启动，最终 running、restarts=0；日志 `cyber-room protocol=3 TCP=8888 HTTP=80 UDP=8888`。

## 配置与回滚

- 原部署目录 `backups/20261021-092/` 备份 compose.yaml、update.sh；旧镜像回滚标签 `fqgame-server:rollback-20261021-092`，旧 ID `sha256:31ea85b6cbc790761425e28a54557c1fde5e4a082dd1c378233b93164b3e3392`。
- 新包保存在原部署目录 `backups/image-092.tar`。需要回滚时将回滚标签重新标记为原 latest，使用原 Compose 的禁止拉取方式重建。
- compose.yaml、update.sh 与备份逐字节一致，自动更新 timer active。保留 TCP/UDP 8888、1panel-network 和 HTTP 内部反代；NPM 的网站 80/443 为公网绑定，管理 81 为本机绑定。
- 既有 Docker 代理虽然有监听，但探测返回 Proxy CONNECT aborted，因此本次采用本机下载上传，未修改全局代理。每日自动更新的既有代理故障仍需另行处理。
- 首条检查 SSH 因空闲断开，已关闭失效连接并重新登录。部署命令在失效连接上未执行，重连后完整执行成功。

## 验证结果

- 公网 HTTPS、TCP v3 完整加密握手/PONG、WSS READY/PONG、UDP 新票据地址发现通过；协议声明版本 0.9.2。
- 公网 Android 元数据 0.9.2/code20，APK 完整下载 2250299 字节，SHA256 `c42c260228229470b7677bfcfd4080cc20ce5290bd8524dfbbff7abb78bbb3fd`。
- 公网 Windows 元数据 0.9.2，EXE 完整下载 11853312 字节，SHA256 `68714b45e3294bed2fb2ba2abdb53b4f0fd19ff13e381280e3a637bbc6242495`。
- 公网十份资源与精确提交逐字节一致：index.html、app.js、plugin-runtime.js、plugin-store.js、plugin-package.js、plugin-trust.json、transport.js、microphone.js、microphone-worklet.js、style.css。
- 公网市场 P-256 签名通过，信任根与提交一致；catalog SHA256 `0e661e3707a7fc3104928e537d004815e9a4898c2f26a57065e88e35dad865cf`。三种插件各 1.0.0、1.0.1、1.0.2 共九条精确发布，旧六条保留。
- 全部 27 份跨平台 JSON 的长度、散列和 manifest，以及 6 份原生组件的长度和散列通过。这部分全文件下载在服务器经同域名 HTTPS/NPM 验证，域名仅临时 resolve 到回环，仍检查 TLS 证书；不声称全部从本机公网下载。
- 未重复真机安装或真实第三方片源播放测试；不扩大主线程对第三方 Emby 的验收结论。

本文无服务器 IP、账号、密码或授权 URL。原有暂存与未跟踪改动均保留。

## 发布主线程独立复核

2026-10-21 08:48（北京时间）补录，以下均从发布主线程本机经公网域名重新检查，结果通过：

- HTTPS 页面与版本，APK/EXE 完整下载及散列与正式 CI 原件一致；TCP v3 完整加密握手/PONG、WSS READY/PONG、UDP 地址登记。
- 10 份宿主资源与发布提交 Git 对象逐字节一致。catalog 散列精确匹配，P-256 生产签名通过；27 份插件 JSON 完整散列通过，6 份原生包的 Range 206、总长度与首段字节通过。没有把部署线程从服务器完成的原生完整下载冒称为主线程公网完整下载。
- 实际公网双浏览器完成签名安装三个插件、缺失补装、隔离、开局、刷新恢复、房主退出解散，无 pageerror。

本机证据在忽略目录 `server/target/release-0.9.2/audit/` 的 public-health.log、public-market.json、public-web.log。验收边界见 [0.9.2 验收](ACCEPTANCE_0_9_2.md)。用户需升级宿主及三个 1.0.2 插件后新建房间。主线程归档提交推送后按本次授权安排本机关机；部署线程未执行关机。
