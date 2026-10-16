# QQ音乐转MP3

将常见 QQ 音乐加密文件批量还原并转换为 MP3，支持 **Windows 和 Mac**。本地离线处理，原文件保留。

## 下载与使用

在 [Releases](https://github.com/apameda/qq-mp3-desktop/releases/latest) 下载适合你的版本：

| 文件名 | 适用电脑 |
|---|---|
| `QQ-MP3-Windows-x64.zip` | Windows 10/11 64 位 |
| `QQ-MP3-macOS-arm64.zip` | macOS 13+，Apple 芯片 Mac（M 系列） |
| `QQ-MP3-macOS-x64.zip` | macOS 13+，Intel 芯片 Mac |

最低系统要求来自 [Electron 44.7.2 官方平台说明](https://github.com/electron/electron/blob/v44.7.2/README.md#platform-support)。

完整解压后运行 EXE 或 `.app`。Windows 版请保留同目录所有文件；Mac 版可将 `.app` 放进“应用程序”。不需要另装 Python、Node.js 或 FFmpeg。

添加多个文件或整个文件夹，选择保存位置和音质，点击“开始转换”。默认保存至系统“音乐”文件夹下的 `QQ转MP3`。

![界面预览（示例队列）](docs/screenshots/mock-empty.png)

## 支持范围

**文件后缀不能单独证明是否兼容。** 程序会检查实际文件结构和音频内容。

- 支持常见 QMCv1 固定掩码格式，如旧版 `.qmc0`–`.qmc9`、`.qmcflac`、`.qmcogg`。
- 支持常见 QMCv2 的内嵌逐曲密钥、长度尾部和 `QTag`，包括 Map 与 RC4 数据模式。
- `STag` 或缺少内嵌密钥的部分文件，可以点击对应行的“歌曲密钥”，提供该首歌曲的常规 Base64 ekey。
- `musicex` 新版结构、`QQMusic EncV2,Key:` 密钥封装暂不支持，会给出明确提示。
- 仅处理还原后为 MP3、FLAC 或 Ogg Vorbis 的音频；损坏或未知封装不会冒充转换成功。

歌曲密钥每首不同。软件只在当前应用内存中保存，不在偏好设置中保存；关闭软件后清除。软件不获取账号凭据或在线歌曲密钥。

## 普通 FLAC

也可直接添加普通 `.flac` 文件或包含 FLAC 的文件夹，按所选音质转换为 MP3，无需先封装为 NCM / QMC。保留可读取的歌曲标签，原始 FLAC 不变；LRC 歌词文本不在转换范围内。

## 转换行为

- 原音频已经是 MP3 时保留原有码率、采样率与压缩音频流，避免再次有损压缩。
- FLAC 或 Ogg 转 MP3 可选 320 / 256 / 192 kbps，默认 320 kbps，采样率 44.1 kHz。
- 保留音频中已有、可读取的歌名、歌手、专辑信息；不写入封面。
- 每首成品都进行完整解码检查，通过后才保存。
- 重名自动另存为 `歌曲 (2).mp3`；不覆盖已有文件，不修改或删除源文件。
- 支持递归文件夹、去重、逐首进度、取消、失败继续和重试。已成功项目不会重复转换。

## 验证状态

83 项自动测试通过，包含独立原作者参考向量交叉验证、真实短测试音频转换、批量流程与逐曲密钥隔离。Apple 芯片 Mac 已通过原生界面三首批量转换验收，界面另有模拟 API 测试。

样本来自公开开源参考实现生成的确定性字节向量，以及本机合成的短测试音频；**没有据此宣称任意真实 QQ 歌曲或新版格式都兼容**。各平台成品验证范围见 [测试记录](docs/测试记录.md)。

Mac 版使用本地临时签名，未进行 Apple 开发者签名和公证；Windows 版未进行应用专用代码签名。

如果 Mac 提示无法验证开发者，先确认下载来自本仓库的 Releases，并核对同页提供的 SHA-256。确认后，可按 [Apple 官方说明](https://support.apple.com/zh-cn/102445)，在尝试打开后前往“系统设置 → 隐私与安全性”，选择“仍要打开”。如果提示文件已损坏，请重新下载并核对校验值。

## 开发

核心使用 Node.js 内建模块。桌面运行环境为 Electron，转码使用随包 FFmpeg。

```sh
npm test
node scripts/package.mjs --target all
```

`QQ_TEST_FFMPEG` 或兼容的 `NCM_TEST_FFMPEG` 可指定测试 FFmpeg；开发运行可通过 `QQ_FFMPEG` 指定本机工具。界面测试脚本为 `scripts/test-ui.cjs`，使用已有 Playwright 和 Chrome。

版本构建和校验方式见 [打包说明](docs/打包说明.md)。上游许可与代码来源见 [第三方声明](THIRD_PARTY_NOTICES.md) 及发行包内的原始许可文本。
