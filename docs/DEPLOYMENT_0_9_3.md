# 0.9.3 第一台部署记录

2026-10-23 01:40（北京时间）。第一台部署完成，第二台未操作，不关机；主线程已另行独立公网核验，统一提交归档。

## 发布与镜像

- 发布主线程转达用户本轮发布后部署授权，直接查询确认 [Actions 39818993890](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/39818993890) success，完整提交 d35c7333c1b0ad2ad556f36f697d6c9588cea669。[v0.9.3](https://github.com/LinHuiG/chinese-chess-flipping/releases/tag/v0.9.3)。
- 本机经 Clash 下载，验证 index sha256:d7f7f8da2e64a858649ad0c7fac6eaa8dbd40e3e623806c2bf76dabe3cc2cb2f，由该索引选取 amd64 sha256:2a0fe8b6993b9e83fd5966f03f104d26a124eb0bcd36de5e8f9b4d0bf62c7d82，逐层校验并核对完整 revision。
- OCI 包 394280960 字节，SHA256 b38dbd903ea4bc384c095e2c459af26f9750d87d4dc68323f69b0c76ae7a8307。下载首次停滞，停止本次唯一 curl 后增加总超时并续传成功。SFTP 上传 98.6 秒，服务器校验包散列一致后 docker load。
- 校验导入标签 ghcr.io/linhuig/chinese-chess-flipping:sha-d35c733 的 image ID 和 revision，再为本地 latest 打同一标签，原 Compose 使用 up -d --no-build --pull never 重建；未从可变标签重新网络拉取。
- 启动时间 01:39:18，最终 running、restarts=0；日志 protocol=3 TCP=8888 HTTP=80 UDP=8888。

## 配置与回滚

- 原部署目录 backups/20261023-093/ 保存 compose.yaml、update.sh，均与部署后文件逐字节一致；自动更新 timer active。网络、TCP/UDP 8888、内部 HTTP 反代保留，网站公网80/443及管理本机81绑定保留。
- 回滚标签 fqgame-server:rollback-20261023-093，旧版0.9.2 image ID sha256:5ab0de20d4fbda867360732804ecf20b92289d41706977d92e226cab4ee1ccc4。回滚可将该标签重新标记为原 latest，再用原 Compose 禁止拉取重建。
- 新镜像包保留在 backups/image-093.tar。
- 既有服务器 Docker 代理探测返回 Proxy CONNECT aborted，未改全局代理；每日自动拉取的既有故障仍未修复。

## 已验证

- 公网 HTTPS、TCP v3 完整加密握手/PONG、WSS READY/PONG、UDP 新票据地址发现通过，版本0.9.3。
- Android code21，完整公网 APK 下载2250299字节，SHA256 540194ef86adce494857b71d9eecdd0c5eac2dcd629d3774ab73487229519257。
- Windows0.9.3，完整公网 EXE 下载11853312字节，SHA256 0cbc906288229004e8ea14016e37939a5d8d9a815ee82762fff8b5283a01a2c9。
- 公网十份宿主网页资源与冻结提交逐字节一致：index.html、app.js、plugin-runtime.js、plugin-store.js、plugin-package.js、plugin-trust.json、transport.js、microphone.js、microphone-worklet.js、style.css。
- 公网市场P-256签名通过，信任根与提交一致；catalog SHA256 790a5734567cde26c281f096c6aeb8541f03852d13c8c5604def66f86240df08。三个插件各1.0.0至1.0.3共12条，旧9条保留。
- 全部36份跨平台JSON的长度/散列/manifest、8份原生组件的长度/散列通过；此44文件检查在服务器经同域名HTTPS/NPM执行，仅临时resolve到回环，仍验证TLS，不声称全部从本机公网下载。
- 初次检查脚本替换versionCode时误将HTTP200预期改为210，定位并修正脚本后全检查通过，非线上故障。
- 本线程未进行真实PC/Web播放联测，主线程说明该联测本轮未完成；不将部署检查等同播放验收。

本文不含服务器IP、管理账号或凭据。原有暂存与未跟踪改动保留。


## 主线程独立公网核验

- 本机直接访问 HTTPS 页面、0.9.3/code21 元数据、TCP v3 完整 ECDH/HKDF/AES-GCM 握手和加密 PONG、WSS READY/PONG、UDP 票据登记均通过。
- APK 和 EXE 从公网完整下载，大小及 SHA-256 与正式 CI/Release 一致，见上表述。
- 公网 catalog 生产 P-256 签名、12 条发布及冻结 catalog 散列通过；十份宿主资源逐字节匹配冻结 Git 对象。
- 36 份插件 JSON 从公网完整下载，大小及散列通过；8 份原生文件公网 Range 206、总长度和前 1024 字节与本地已完整验证的正式产物一致。原生全文件散列已由部署线程经同域 HTTPS 反代验证，不将 Range 结果描述为完整公网下载。
- 首轮并发下载期间，本机 HTTP 读取超时；浏览器矿工下载到 25% 时超过检查脚本固定 12 秒等待，无页面 JS 异常。大文件任务结束后，公网 health 串行复验全部通过；保留首轮结果，不改产品超时。
- 证据保存在本机忽略目录 `server/target/release-0.9.3/audit/public-health.txt`、`public-market.json`，不含凭据。

- 公网双浏览器串行复验通过：三个插件生产签名安装、空宿主、iframe 隔离、入房自动补装、翻棋开局、刷新恢复及房主退出解散；无页面 JS 异常。使用原脚本 12 秒等待，未放宽等待或跳过断言；浏览器已正常关闭，测试房间已解散。证据 `audit/public-plugin-smoke.txt`。该检查不包含实际 PC 原生视频播放。
