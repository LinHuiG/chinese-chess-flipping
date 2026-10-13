# Windows 下载资源

由 `scripts/package-desktop-update.py --source <已构建的exe> --version <版本号>` 生成 `latest.exe` 和 `latest.json`。生成物由 Git 忽略，通过构建产物进入服务端镜像；不要提交可执行文件。

`--check` 校验已打包文件的大小与 SHA-256，可同时传 `--version` 核对版本。打包脚本不编译源码，不下载或安装 WebView2，也不表示可执行文件已经通过代码签名。

此目录没有有效包时，服务端仍可运行，网页应显示 Windows 下载暂不可用。首次运行可移植版需要系统已安装 WebView2 Runtime；安装器是否携带或引导安装运行时，以实际构建配置为准。
