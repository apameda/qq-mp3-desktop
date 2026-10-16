# 第三方许可与算法来源

本项目对 QQ 音乐本地文件解析与解密部分的实现参考下列开源实现。保留对应原作者版权与 MIT 许可原文。来源记录用于说明代码及算法依据，不表示上游作者为本项目的兼容性或发布提供保证。

## Presburger / qmc-decoder

- 原作者仓库：https://github.com/presburger/qmc-decoder
- 参考文件：`src/seed.hpp` 的 `seed::next_mask()`，用于 QMCv1 固定掩码与跳字节边界。
- 许可来源：https://github.com/presburger/qmc-decoder/blob/master/LICENSE
- 原始源码来源：https://github.com/presburger/qmc-decoder/blob/master/src/seed.hpp
- 对本项目的用途：用原 C++ 参考实现独立生成非歌曲测试向量，验证 JavaScript 实现；参考 QMCv1 数据布局。

```text
MIT License

Copyright (c) 2019 Presburger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## nukemiko / LibTakiyasha

- 原作者仓库：https://github.com/nukemiko/libtakiyasha
- 原发布参考版本：PyPI `libtakiyasha` 2.1.1.post1；参考源码亦可在原作者 GitHub 仓库查看。
- 参考文件：`src/libtakiyasha/qmc/_qmcdataciphers.py`、`src/libtakiyasha/qmc/_qmckeyciphers.py`、`src/libtakiyasha/qmc/__init__.py`、`src/libtakiyasha/_stdciphers.py`。
- 参考算法：QMCv2 Mask128、HardenedRC4、EncV1 ekey 解包、TCTEA CBC、QTag/STag/长度尾部解析。
- 许可来源：https://github.com/nukemiko/libtakiyasha/blob/master/LICENSE
- 对本项目的用途：将相关数据解析和算法移植为本地 JavaScript 实现；使用原发布 Python 代码独立生成非歌曲测试向量。
- 原库不内置 QQ 音乐账户凭据；本项目亦不读取账户凭据或访问 QQ 音乐服务器。

```text
MIT License

Copyright (c) 2023 nukemiko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 测试样本说明

测试向量由上述原作者参考实现处理程序生成的确定性字节数据，不含商业歌曲、真实用户文件或账户数据。参考实现及其 Python 依赖仅用于开发时交叉验证，不作为桌面工具的运行依赖。测试向量验证不能替代真实用户文件与目标系统的兼容性测试。

## 随软件分发的组件

Electron 运行时自带的 `LICENSE` 与 `LICENSES.chromium.html` 应随安装包一并保留。FFmpeg 的具体构建信息、对应许可证及源代码链接应保留在软件包的 `licenses` 目录。上述组件各自适用其原始许可证；本文件中的 MIT 许可不更改这些组件的许可。

### Electron 44.7.2

- 官方发行：https://github.com/electron/electron/releases/tag/v44.7.2
- 同版本源码：https://github.com/electron/electron/tree/v44.7.2
- Electron 自身采用 MIT 许可；Chromium 等运行环境组件适用各自许可。发行包保留 `LICENSE-electron` 与 `LICENSES.chromium.html`，Mac App 内的 `Contents/Resources/` 也保留这些原文。
- 各架构 ZIP 同时对照官方 `SHASUMS256.txt` 和固定 SHA-256。Mac App 的本地 ad-hoc 重签名不等同于 Developer ID 签名或 Apple 公证。

### Windows FFmpeg：Gyan 9.0.2 essentials

- 构建者发行：https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2
- 准确原包：https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip
- FFmpeg 源码修订：https://github.com/FFmpeg/FFmpeg/commit/946fcce07b
- 构建者将该 Windows 静态构建标为 GPLv3，原始 `LICENSE` 和 `README.txt` 保存在 `licenses/ffmpeg/`。尚未逐一还原构建者精确脚本、补丁与全部静态依赖源码。

### Apple Silicon FFmpeg：Martin Riedl 9.0.2

- 构建者网站：https://ffmpeg.martin-riedl.de/
- 固定二进制：https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip
- 维护方校验：https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip.sha256
- 同构建的版本与配置：https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt
- FFmpeg 源码修订：https://github.com/FFmpeg/FFmpeg/commit/946fcce07b
- 构建者公开的脚本项目：https://git.martin-riedl.de/ffmpeg/build-script
- 版本配置包含 `--enable-gpl --enable-version3` 和 `--enable-libmp3lame`，没有 `--enable-nonfree`。配置原文以 `licenses/ffmpeg/README.txt` 保存，另附 `SOURCE.txt` 与完整 `COPYING.GPLv3`。本项目没有独立核实该次构建脚本的精确提交、所有补丁及完整依赖源码集合。

### Intel Mac FFmpeg：6.1.1-tessus，经 ffmpeg-static b6.1.1 分发

- 固定分发记录：https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- 原始构建者：https://evermeet.cx/ffmpeg/
- 分发项目的准确下载脚本：https://github.com/eugeneware/ffmpeg-static/blob/b6.1.1/download-binaries/index.sh
- FFmpeg 6.1.1 源码入口：https://github.com/FFmpeg/FFmpeg/tree/n6.1.1
- 程序中的编译版本字符串为 `6.1.1-tessus`，编译配置包含 `--enable-gpl --enable-version3`，没有 `--enable-nonfree`。这项记录来自静态二进制检查，不声称已在 Intel Mac 上实测。
- 分发项目的原始 `darwin-x64.README` 实际描述另一个 8.0 版本，按原文保留为 `licenses/ffmpeg/README.txt` 并在 `SOURCE.txt` 标明此差异。`LICENSE.md` 是原始许可摘要，`COPYING.GPLv3` 是另附的完整通用许可原文。未声称原构建者的全部补丁、构建脚本与依赖源码已被还原。

FFmpeg 作为独立可执行程序由本地子进程调用。构建来源和许可证不因本项目采用 MIT 而改变。各平台实际下载与重签名前后哈希见 `BUILD-MANIFEST.json`，进一步来源信息见 `docs/打包说明.md` 及 https://ffmpeg.org/legal.html 。本项目保留已取得的原始许可与来源材料，不把这些指引称为完整 Corresponding Source 归档。
