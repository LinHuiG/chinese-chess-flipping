# App 更新资源

`latest.apk` 和 `latest.json` 是生成文件，不提交。Actions 在编译 Rust 和镜像前构建 APK，并通过 `scripts/package-app-update.py` 生成这里的资源。服务端编译时将它们嵌入二进制，运行时不读写安装包。

本地先在 Android 工程运行 `gradlew.bat assembleDebug`，再从仓库根目录运行 `python scripts/package-app-update.py`，之后可单独编译服务端。发布构建使用固定签名及 `assembleRelease`，打包命令加 `--release`。

签名配置与首次迁移见 [部署说明](../../docs/DEPLOYMENT.md)。不能用每次临时生成的签名发布更新。
