# Speaches 本地语音参考

[English](local-speech-server.md) | 简体中文

配置第三方本地 STT/TTS 服务，或处理“本地语音服务能不能用”的支持请求时使用本页。Speaches 是已验证的第三方 OpenAI 兼容语音服务；Telomi 对它和对云端 API 走同一条路径，差别只在 base URL。语音 Provider 层的契约见 [Audio 模块](modules/audio.md)。

## 已验证版本

| 项 | 值 |
|---|---|
| Speaches | `v0.9.0-rc.3`（commit `24f209c`），从源码用 uv 安装，不需要 Docker |
| STT 模型 | `Systran/faster-whisper-small` |
| TTS 模型 | `speaches-ai/Kokoro-82M-v1.0-ONNX` |
| 平台 | Apple Silicon macOS，Python 3.12（由 uv 安装） |

## 安装与启动

Speaches 要求 uv `~=0.8.14`。本机 uv 更旧时用 `uvx` 临时运行 0.8 版本，不必升级全局 uv。

```bash
git clone --depth 1 --branch v0.9.0-rc.3 https://github.com/speaches-ai/speaches.git
cd speaches
uvx --from 'uv>=0.8.14,<0.9' uv python install
uvx --from 'uv>=0.8.14,<0.9' uv sync
.venv/bin/uvicorn --factory --host 127.0.0.1 --port 8011 speaches.main:create_app
```

Speaches 默认监听 `0.0.0.0:8000`；上面绑定到本机回环地址并换了端口，避免把服务暴露到局域网或与其他本地服务冲突。完成条件：`curl http://127.0.0.1:8011/health` 返回 200。

下载模型（一次性，写入 Hugging Face 缓存）：

```bash
curl -X POST http://127.0.0.1:8011/v1/models/Systran/faster-whisper-small
curl -X POST http://127.0.0.1:8011/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX
```

完成条件：`curl http://127.0.0.1:8011/v1/models` 同时列出这两个模型。

## 在 Telomi 中配置

以下步骤分别从朗读与识别页面建立专用连接：

1. 设置 > 朗读 > 添加连接：Provider ID `speaches-tts`，基础 URL `http://127.0.0.1:8011/v1`，API key 留空，点“发现模型”，再“保存并应用”。发现结果应在“朗读”下列出 Kokoro 及其音色。
2. 设置 > 识别 > 添加连接：Provider ID `speaches-stt`，填写同一基础 URL，API key 留空，发现后保存并应用。发现结果应在“识别”下列出 faster-whisper。
3. 在两个连接上各点“测试”，都应显示 `OK`。
4. 设置 > 识别：语音识别能力默认选 `speaches-stt` 与 `Systran/faster-whisper-small`，保存并应用。
5. 设置 > 朗读：音频生成默认选 `speaches-tts` 与 Kokoro，音色留空使用服务默认；Podcast Narrator 等使用方保持跟随默认；已有单独配置时，先恢复跟随默认。保存并应用。

从朗读或识别页面添加的连接会固定为对应能力，因此上述示例使用两个连接。若已有未固定能力、且模型发现结果同时包含 TTS 和 STT 的连接，也可以在两页复用它，无需重复创建。

## 验收

- 按键说话：在 Goal 对话中按住语音按钮说一句话，转写文本出现在输入框，语音历史记录的 Provider 是 `speaches-stt`。浏览器录音是 webm/opus，Speaches 直接解码，不经过 wav 转码。
- 播客：对已有报告生成播客，生成完成且能播放。播客脚本由 LLM 编写，这一步需要可用的对话模型；朗读与拼接走 `speaches-tts`。
- 实时语音对话的 TTS 同样走 `speaches-tts`，Kokoro 的 PCM 输出是 24 kHz，与 Telomi 的默认帧率一致。

## 与 telomi-audio 的差异

Speaches 的 `/health` 不声明 `capabilities` 或 `max_concurrency`，Telomi 按普通 OpenAI 兼容服务使用它：

- 长转写（YouTube、媒体导入）走单次请求，不走转写 Job。
- 不发送预热请求；第一次转写时 Speaches 才加载模型，会慢几秒。
- 请求不做客户端串行，并发由 Speaches 自己排队。

Speaches 的 `/audio/speech` 必须带 `voice`。音色留空时，Telomi 使用 `/v1/models` 中该模型列出的第一个音色（Kokoro 为 `af_heart`）。

这个版本的 Speaches 在转写成功时也会记录 `ERROR ... Unexpected streaming transcription response type`，请求本身返回 200 且结果正确，排查问题时可以忽略这行日志。
