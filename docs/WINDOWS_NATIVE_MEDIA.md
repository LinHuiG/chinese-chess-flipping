# Windows 原生观影组件

2026-10-15 用户确认加入内置原生播放器，允许运行包增大，并要求界面和控制组件同步完善。Windows 使用 libmpv 解码 E-AC-3 等 WebView2 不支持的音轨；网页仍需要浏览器可解码的媒体，或 Emby 提供兼容转码。

## 当前固定来源与打包

当前使用 **MSYS2 MINGW64 的 mpv 0.41.0-6**，FFmpeg 9.0.2，Windows x64 GNU ABI；不是 UCRT64 或要求 x86-64-v3 的包。没有在用户机器安装 MSYS2。随 EXE 内嵌实际依赖 DLL，首次播放时解包到应用配置目录的版本目录，并逐文件验证大小和 SHA-256。加载限定该目录和 Windows 系统目录，不依赖用户 PATH，不启动外部播放器。

固定清单：[msys2-package-lock.json](../desktop_client/licenses/msys2-package-lock.json)。其中包含 123 个二进制包的构建记录、121 份匹配源码包、741 个 Rust crate 源码及版权材料。运行包只提取 135 个实际需要的 DLL；静态库、头文件组件只用于源码和版权归档，构建工具、CLI、测试程序和可选插件不进入 EXE。

主包来源：

- [MSYS2 mpv 包](https://packages.msys2.org/packages/mingw-w64-x86_64-mpv)；固定 binary `mingw-w64-x86_64-mpv-0.41.0-6-any.pkg.tar.zst`，SHA-256 `28f65dbf83536a0064c5aa22af6a13ca64a6a53789d239d22b7521ca374cb0a0`。
- [对应源码包](https://repo.msys2.org/mingw/sources/mingw-w64-mpv-0.41.0-6.src.tar.zst)，SHA-256 `ae87014fed4e6e4fec9bdf27dafb54a3939605ea84d65fec3a69def4b8c1ebd6`。包中实际包含 mpv 0.41.0 源码和 PKGBUILD；配方 SHA-256 `44888a80606f42d47b9b9da566eca32bf01d0be07c7d9fc65b8bf392d19e79f6` 与二进制 `.BUILDINFO` 一致。

```powershell
python scripts/prepare-desktop-media.py
cargo build --locked --release --manifest-path desktop_client/Cargo.toml --features custom-protocol
```

准备脚本需要 Python 3.10+ 和 Windows 自带 bsdtar（`tar.exe`）。`--cache-dir` 可复用下载；缓存也逐一验证散列，损坏缓存会拒绝使用。输出为被忽略的 `desktop_client/native/libmpv-runtime.tar.gz` 和 `libmpv-runtime.json`，所有源版本均来自固定清单，不读取滚动最新包索引。

本次运行归档实测 **77,539,941 字节**，SHA-256 `ebe4206c7e7180186105822755ce320e8c15f03a90c34dc5f834409862d9e0f3`；270 个文件解包共 **211,417,985 字节**。除 DLL 外包括两份合并版权文本、包级许可证和固定清单。此前 shinchiro 原型单 EXE 的 63.3 MB 不能代表此最终包；最终本地 EXE 为 93,923,840 字节。

## 源码与许可证交付

这是启用 GPL 的解码分发，包含 GPL-3.0-or-later 的 FFmpeg，不能写成纯 LGPL；应用本身为 AGPL-3.0-only。各依赖保留自己的许可证和版权，见 [NOTICE](../desktop_client/licenses/NOTICE.txt)、[MSYS2 合并通知](../desktop_client/licenses/MSYS2-NOTICES.txt)、[Rust 依赖通知](../desktop_client/licenses/CARGO-NOTICES.txt) 和运行目录中的 `licenses/packages/`。压缩、解压不修改上游 DLL。

```powershell
python scripts/archive-desktop-media-sources.py
python scripts/publish-desktop-media-sources.py server/target/native-media-source-release/source-release.json --check
```

归档脚本只下载和读取材料，不执行上游源码或 PKGBUILD。它核对每个输入的固定散列、包内真实源码载荷、二进制 `.BUILDINFO` 和源码 PKGBUILD 的一致性，保存原始源码包、构建记录、Cargo 依赖、许可证和离线 vendor 恢复脚本。源码 ZIP 不嵌入 EXE；本次原始 source packages 共 1,673,946,404 字节，crate 共 113,289,707 字节，另加构建记录和通知。

本机已生成 `media-mpv-msys2-fb232a877695-source.zip`：**1,802,805,647 字节**，SHA-256 `5f1888bd7275ba97412cde195c7d2f6f1c0abe8149ae87ff6abd78716fe42932`。ZIP 全文件 CRC、发布脚本 `--check`、741 个 crate 的离线 vendor 恢复、损坏缓存拒绝、Python 语法均通过；重复生成运行 tar.gz 得到相同 SHA-256。

固定源码发布标识是对规范化 JSON 清单做 SHA-256 后取前 12 位：`media-mpv-msys2-fb232a877695`。随包 NOTICE 指向该稳定 Release 地址；**发布流程必须先成功创建或验证这个源码 Release，再分发包含 DLL 的 EXE/镜像**。文档中出现该地址不代表它已经发布。根线程负责实际上传与发布结果。发布脚本不覆盖内容不一致的已有附件。

已核对的来源边界：

- 递归解析正常和延迟 PE imports；Windows 自带 DLL 使用明确白名单。本机 System32 中碰巧存在的第三方 `libcrypto-3-x64.dll` 和 `vulkan-1.dll` 仍随包提供。
- 每份源码的普通输入按 `.SRCINFO` 检查 SHA；Git 源包内验证了实际所需 commit/tree。所有原始包均固定完整 SHA-256，不用构建日期猜源码版本。
- shaderc 实际静态链接 glslang 16.3.0 和 SPIRV-Tools 1.4.363.0；同时保留 glslang 编译时使用的旧 Tools 1.4.350.1 API 头文件来源，不声称混入两份优化器实现。保留对应 SPIRV-Headers、三个实际 Vulkan Headers 版本、libplacebo 的 fast_float/内联 xxhash/GLAD 生成源，以及 FFmpeg 的 dlfcn/AMF/NV 接口输入。
- libdovi、rav1e、librsvg 的 Cargo.lock 和源码校验和已核对。librsvg 配方更新 windows-sys 的准确新增版本来自[原构建记录](https://github.com/msys2/msys2-autobuild/actions/runs/35444080246/job/105899902767)，[证据节选](../desktop_client/licenses/librsvg-cargo-update.txt)保留日志散列；归档保留更新前后源码的并集。`restore-desktop-media-cargo.py` 可离线恢复带校验文件的 vendor 目录。
- 源码归档保留构建环境和配方，**没有声称在本机逐库重建并得到逐字节相同二进制**。编译器可执行文件、Windows 系统库、仅用于 CLI/测试的依赖和未分发的可选插件不打入运行包。

早期 shinchiro 原型不能从保留日志恢复所有依赖 HEAD，未作为最终分发来源。其历史 [source-inventory.json](../desktop_client/licenses/source-inventory.json) 是不完整证据记录，不能与当前 MSYS2 固定清单混用。该原型的单 DLL/gzip 输入已由当前多 DLL 清单替换。

## 播放控制和验证

播放器嵌入电影区域，共享界面提供进度、倍速、画质、音轨、字幕、音量、静音和全屏。画质和本机音轨/字幕选择不改变其他成员设置；播放进度和倍速由房主统一。切换画质可能请求 Emby 转码，不能把本机可解码等同于远端可转码。

原生播放从已配置片源的 HTTP/HTTPS origin 开始，媒体跳转不附加账号请求头；不加载用户 mpv 配置或脚本。后台暂停、对话框遮挡和离房停止由现有会话控制。空房只更新边界时不创建播放器，也不提前解包。

MSYS2 候选已在独立加载环境验证 AAC/E-AC-3：本地 E-AC-3 片段解出 48 帧图像和 96,000 帧非零 PCM；这只证明解码输出，不等同于真实声卡/公网/所有媒体兼容。最终包已用本地 HTTP E-AC-3 样片通过 gpu-next 首帧、WASAPI 非零 PCM、倍速/音量/字幕/暂停跳转；真实片源复验命令被自动审批拒绝。早期原型的 HTTP→HTTPS CDN 与跨端结果不能直接称为最终库的真实片源复验，详见 [PROJECT_STATUS.md](../PROJECT_STATUS.md)。
