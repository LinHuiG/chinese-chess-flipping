# 0.9.1 第一台部署记录

2026-10-17 00:21（北京时间）。第一台已上线；第二台未操作，不关机。由部署线程核验，发布主线程统一归档。

## 发布与部署

- 提交 `8c79aae7b8c3096338d1f940012491471ac11193`，[Actions 38922291784](https://github.com/LinHuiG/chinese-chess-flipping/actions/runs/38922291784) 已直接核对 SHA 和 success。[v0.9.1 Release](https://github.com/LinHuiG/chinese-chess-flipping/releases/tag/v0.9.1) 由主线程完成。未部署取消候选。
- 初始 LIST 发现旧电影厅而等待；用户随后明确“发布完成后直接部署，可以断开当前房间”。未操纵媒体或停止 Emby 会话。
- 按用户要求，本机通过 Clash 下载 OCI manifest/config/layers，逐层核验摘要和 revision 后打包，无需本机 Docker。用户换代理后下载恢复，大层中断时保留 146800640 字节并续传成功。
- 镜像包 200816640 字节，SHA-256 `1c0c3546fa0ed9417d5168d1b920c2ff214ce32cc5715d89c1071f169ec88c14`。SFTP 上传耗时 47.3 秒，服务器验证相同散列后 docker load 成功。
- 精确标签 `ghcr.io/linhuig/chinese-chess-flipping:sha-8c79aae`，amd64 manifest/运行镜像摘要 `sha256:31ea85b6cbc790761425e28a54557c1fde5e4a082dd1c378233b93164b3e3392`。标签 revision 与提交一致，再为本地 latest 打同一镜像标签，原 Compose `up -d --no-build --pull never` 重建。
- 容器于 00:19:07 启动，最终 running、restarts=0，日志 protocol=3 TCP=8888 HTTP=80 UDP=8888。端口、网络、反代保留，HTTP 未直接映射公网。
- compose.yaml 和 update.sh 与备份逐字节相同；定时器 active。

## 回滚

原部署目录 `backups/20261016-231704-091/` 保存 compose.yaml 和 update.sh；回滚标签 `fqgame-server:rollback-20261016-231704-091` 指向旧 0.9.0，摘要 `sha256:06052e5296332c54c0f035588c8ba988730a6e9461a7ade50276ba7571261d56`。上传包保留于原部署目录 `backups/image-091.tar`。

## 已验证

- 公网 TCP v3 完整加密握手/PONG、WSS READY/PONG、UDP 新票据发现通过，READY 0.9.1 与四项能力一致。
- 公网 Android 元数据 0.9.1/code19、Windows 元数据 0.9.1，与正式发布散列一致。
- 公网 index.html、app.js、plugin-runtime.js、plugin-store.js、plugin-package.js、plugin-trust.json、transport.js、microphone.js、microphone-worklet.js、style.css 与精确提交逐字节一致。含 iframe fullscreen/autoplay/screen-wake-lock 权限及 allowFullscreen；不等于真机行为验收。
- 公网市场 P-256 签名通过，固定信任公钥与提交一致。六个精确发布：三个插件各 1.0.0 和 1.0.1，旧版保留。
- 全部 18 份跨平台 JSON 长度/SHA-256/manifest，4 份电影厅原生组件，以及两个宿主包完整下载校验通过。大文件检查在服务器通过同域名 HTTPS/NPM 执行，仅将该域名解析到回环，仍验证 TLS 证书；不声称全部从本机公网下载通过。

| 宿主 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Android 0.9.1/code19 | 2248187 | 310aa1ef623b6f61ab8db412e65c2bc61d225d634e4380d00055a21fd47e2713 |
| Windows 0.9.1 | 11849216 | 69b644b9a76e571aee5763734e25e76b62937e8282a3f74b58dd379feee30b58 |

新版各平台 JSON 摘要：chess `1018d636da2c22faa9fb14e84bdb722d321d253ac3edf4a03f84963a8ef8e8b1`；miner `fab60ea1c99d8493330be8c35ed537200fb3a223a621580143d5fc2434682b28`；watch `de7ade4a00c35088798d58a62f4358e4759cc24d24bba14cf6becc9559f7095c`。电影厅原生 Android `a7c22cee94f513c6c156fe92c0e8ea90f40a6da07c28c322262b7d97598e1803`，Windows `84e9ced45e14103a403206d0fff7aef34e1155e8d95f9e415ee271f5c77b0d762`。

## 异常与边界

- 原 Docker 代理端口 1080 无监听，自动拉取故障仍未修复。最初临时回环转发下载慢且等待超时，重试后按用户要求停止唯一远端 pull 并关闭转发，改本地下载上传。最终无临时监听/遗留 pull，未改全局代理或其他服务。
- 服务器直连镜像层 1 MiB 样本约 85 秒，故未采用。Clash 原节点接收错误，用户切换节点后完成下载与续传。
- SSH 空闲连接失效后重新登录上传。重建完成前的探测命中旧版，完成后重测通过；首次宿主检查漏 versionCode 参数返回 400，补参数后通过。
- 本线程未验收真机播放、换集、安装、全屏/常亮。使用修复需升级宿主、安装插件 1.0.1 并创建新房间；旧精确插件版本不会自行替换。
- 本文无凭据或服务器 IP，由发布主线程与状态/验收记录一并提交归档。
