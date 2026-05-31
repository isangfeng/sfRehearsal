# 台词排练器

一个轻量的浏览器版台词排练工具。它支持：

- 输入中文、英文或中英混合文本
- 按句子或段落拆分
- 使用本机 MeloTTS 中文模型生成自然朗读
- 使用 ElevenLabs 在线音色生成可导出的朗读音频
- 使用豆包语音在线音色生成可导出的朗读音频
- 在同一个入口选择本地、在线或浏览器提供的系统朗读音色
- 使用图标逐句朗读、录音、回放、清除和保存音频，并在波形上选择播放起点
- 将已经录制或生成的片段按顺序合并并导出为 WAV 文件

## 安装 MeloTTS

自然朗读改为使用本机运行的 [MeloTTS](https://github.com/myshell-ai/MeloTTS)。
MeloTTS 官方项目在 Ubuntu 20.04 和 Python 3.9 上完成测试。macOS 如果遇到兼容性问题，
官方建议改用 Docker 安装。

按照官方方式安装：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install "git+https://github.com/myshell-ai/MeloTTS.git"
.venv/bin/python -m unidic download
```

`.venv` 位于当前项目目录中，并且已经被 Git 忽略。它不会修改系统 Python，也不依赖
Conda 或 Mamba。

模型文件会在第一次生成自然朗读时下载和载入，因此首次调用会明显慢一些。MeloTTS 中文模型和
它依赖的 Hugging Face 模型默认保存在当前项目的 `.models/huggingface` 中，不会写入用户目录。
英文发音转换使用的 NLTK 数据保存在 `.models/nltk_data` 中。`.models` 已经被 Git 忽略。
当前项目默认使用 CPU，避免部分 macOS 环境下使用 MPS 时出现兼容性问题。

如果需要使用其他模型目录，可以在启动时覆盖 `HF_HOME`：

```bash
HF_HOME=/path/to/model-cache ./start.sh
```

## 运行

在本项目目录执行：

```bash
./start.sh
```

然后在浏览器中打开：

```text
http://127.0.0.1:8000
```

浏览器第一次录音时会请求麦克风权限。建议使用最新版 Chrome、Edge 或 Safari。

如果已经确认本机 CUDA 可用，可以手动指定 MeloTTS 运行设备：

```bash
MELOTTS_DEVICE=cuda:0 ./start.sh
```

## 配置

复制配置模板后，可以修改默认语速，并按需填写 ElevenLabs 或豆包语音配置：

```bash
cp config.example.json config.local.json
```

`config.local.json` 会被 Git 忽略。可用语速范围为 `0.5` 到 `2.0`。

ElevenLabs 的 `api_key` 只由本机服务读取，不会发送到浏览器。也可以不写入文件，改用环境变量：

```bash
ELEVENLABS_API_KEY=your-api-key ./start.sh
```

页面会从 ElevenLabs 读取当前账户可用音色，并自动选择一个可用音色。只填写 `api_key` 即可使用。
从 Voice Library 保存的音色不会出现在列表中，因为免费账户不能通过 API 调用这些音色。
默认模型为 `eleven_multilingual_v2`。旧配置中的 `default_voice_id` 仍然兼容，可用于指定优先音色。

豆包语音需要填写火山引擎新版控制台中申请到的 `api_key` 和 `voice_type`。默认资源 ID 为
`seed-tts-2.0`，可按已开通的模型修改。API Key 只由本机服务读取，也可以使用环境变量：

```bash
DOUBAO_API_KEY=your-api-key \
DOUBAO_VOICE_TYPE=your-voice-type \
./start.sh
```

旧版控制台也兼容：将 `app_id` 和 `access_token` 写入配置文件，或设置 `DOUBAO_APP_ID` 与
`DOUBAO_ACCESS_TOKEN`。豆包语音当前使用官方 V3 SSE 单向流式接口，服务端会合并音频片段后交给页面保存和导出。

页面中的豆包音色下拉框来自 `doubao.voices`。可以为每个已开通音色填写便于辨认的名称：

```json
"voices": [
  {
    "name": "Vivi 2.0",
    "voice_type": "zh_female_vv_uranus_bigtts"
  }
]
```

`doubao.voice_type` 是默认选中的音色。未填写 `voices` 时，旧配置仍然兼容，页面会显示默认音色代码。

## 常见问题

- 页面提示“尚未安装 MeloTTS”：启动服务的 Python 环境中找不到 `melo.api`。请重新执行安装步骤。
- 首次生成耗时较长：第一次调用会下载并载入中文模型，后续生成会复用已经载入的模型。
- macOS 初始化失败：先使用默认 CPU 模式。仍有问题时，参考 MeloTTS 官方文档使用 Docker 安装。
- 页面提示“尚未配置 ElevenLabs API 密钥”：在 `config.local.json` 填写 `elevenlabs.api_key`，或启动时设置 `ELEVENLABS_API_KEY`。
- 页面提示“尚未完整配置豆包语音”：在 `config.local.json` 填写 `doubao.api_key` 和 `doubao.voice_type`，或设置对应环境变量。旧版控制台可改填 `doubao.app_id` 与 `doubao.access_token`。

## 技术结构

- `index.html`：页面结构
- `styles.css`：视觉样式和移动端适配
- `app.js`：文本拆分、朗读、录音、回放和 WAV 导出逻辑
- `server.py`：提供静态页面，并通过本机 MeloTTS、ElevenLabs 或豆包语音生成音频
- `start.sh`：启动本机服务

每一句台词都使用一个独立对象保存。导出时，程序优先读取用户自己的录音；没有录音时，
使用已经生成的 MeloTTS、ElevenLabs 或豆包语音朗读。所有片段会转换为同一个采样率，在片段之间加入短暂停顿，
再生成一个 WAV 文件。

# 致谢

感谢codex和claude code的帮助。