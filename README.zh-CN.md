<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/telomi/web/public/brand/telomi-lockup-dark.png">
    <img src="apps/telomi/web/public/brand/telomi-lockup-light.png" alt="Telomi：一只拥有叶片状翅膀和轻轻舒展尾巴的好奇小鸟" width="220" height="64">
  </picture>
</p>

<h1 align="center">与你共同成长的研究伙伴</h1>

<p align="center"><a href="README.md">English</a> | 简体中文</p>

<p align="center"><strong>探索更远，带回理解。</strong></p>

Telomi 是一个围绕长期目标构建的个人 AI 研究伙伴。它收集资料、撰写带有可追溯引用的报告、将报告转为音频，并积累供你持续查阅的 Wiki。

Telomi 目前主要聚焦于 AI 相关主题的调研，并针对这类主题进行了优化。

Telomi 在本地运行，面向单用户使用。模型和研究来源可能使用外部服务。项目仍在持续开发，使用研究结论时请核对引用来源。

## 功能

| 功能 | 可以做什么 |
|---|---|
| 围绕 Goal 的对话 | 将长期兴趣相关的问题、上下文和后续讨论放在一起。 |
| 研究与带引用的报告 | 探索问题，并检查答案背后的证据。 |
| 基于 Wiki 生成报告 | 利用已积累的知识回答新问题，或面向不同读者撰写报告。 |
| 报告转音频 | 按你偏好的深度和表达方式收听报告的口语改编版。 |
| Goal Wiki | 浏览和检索多轮研究积累的关联知识。 |
| 长期记忆 | 将你明确表达的偏好和先前上下文带入后续对话。 |
| 定期研究 | 在 Telomi 运行时按计划持续跟进新进展。 |
| 语音交互 | 配置本地或云端音频服务后，使用语音输入和输出。 |

## 模型服务 Provider

在设置中选择 Provider，按其支持的方式登录或填写 API Key，并选择对话、嵌入和音频模型。可用能力和认证方式因服务而异。

| 连接类型 | 支持的 Provider |
|---|---|
| 模型服务 | OpenAI、OpenAI Codex、Anthropic、Google Gemini、DeepSeek、Mistral、xAI、Moonshot/Kimi、MiniMax、Qwen、Z.AI、Ant Ling、Xiaomi |
| 云平台与网关 | OpenRouter、Hugging Face、Groq、Cerebras、Fireworks、Together、Baseten、NVIDIA、Amazon Bedrock、Azure OpenAI、Google Vertex AI、Cloudflare AI Gateway / Workers AI、Vercel AI Gateway、GitHub Copilot、OpenCode |
| 本地与自定义连接 | Ollama，以及兼容 OpenAI 接口的自定义服务 |

## 安装

目前通过源码在本机运行 Telomi，已验证的安装环境为 Apple Silicon macOS。请先安装：

- Git、Node.js 24 和 npm
- [uv](https://docs.astral.sh/uv/)，用于准备所需 Python 环境
- Google Chrome，用于浏览器研究

通过本仓库 **Code** 菜单中的地址克隆仓库，进入克隆后的目录。首次安装时执行：

```bash
npm ci
cp apps/telomi/.env.example apps/telomi/.env.local
npm run setup
npm run build
npm start
```

`npm run setup` 准备由 Telomi 管理的 Python 环境：Hindsight 记忆服务、Research Source Service 和 Prime Agent 内核，均通过 uv 安装。首次 setup 会下载 Python 解释器和依赖包，耗时取决于网络。本地音频（MLX）不包含在 `setup` 中；Apple Silicon macOS 上请另行执行 `npm run setup:audio`。

启动完成后，打开 <http://127.0.0.1:8787>。使用期间，以及等待定期研究执行时，请保持 Telomi 运行。

Telomi 生成的 Goal、报告、Wiki、设置和已保存的凭据默认存放在 `apps/telomi/data`；设置 `TELOMI_DATA_DIR` 可改用其他目录。Telomi 只会自动创建默认目录；其他目录需要在首次启动前自行创建，这样移动硬盘未挂载时会直接报错，而不是悄悄以空数据启动。长期记忆（本地 PostgreSQL 数据库）和托管浏览器的登录状态也存放在这里，所以需要备份的只有这个数据目录。可以重新下载的内容单独放在 `apps/telomi/cache`（`TELOMI_CACHE_DIR`）。详见[升级、备份与恢复](apps/telomi/docs/upgrading.zh-CN.md)。

如需语音功能，可在设置中连接云端音频服务；Apple Silicon Mac 也可以按[本地音频说明](apps/telomi-audio-local/README.md)进行可选安装。

升级已有安装时执行 `npm run upgrade`：它会先为数据目录建立快照，任何一步失败都会回到之前的版本。详见[升级、备份与恢复](apps/telomi/docs/upgrading.zh-CN.md)，其中也说明了还没有这条命令的旧版本如何升级。

## 开始使用

1. **配置模型。** 打开设置，连接你选择的 Provider，选好对话模型，以及用于知识检索和记忆的嵌入模型。这些模型都不会预先选定：选择嵌入模型之前，Wiki 检索只按关键词和链接查找；长期记忆在有了嵌入模型后才会启动，记忆服务自带的本地模型无需密钥。登录或填入密钥只会保存凭据；点击 **保存并应用** 后才会先验证再生效。用 **保存待用** 保存的凭据在你应用之前不会启用。长期记忆需要模型 API 为 `openai-completions`、`anthropic-messages` 或 `openai-responses` 的连接；OpenAI Codex（`openai-codex`）登录不能用于记忆，设置中的记忆部分会报告这类失败。需要语音功能时再添加音频服务；朗读和识别同样要在你选好模型后才会工作，本地语音运行环境的模型也一样。
2. **创建 Goal。** 描述你想理解或持续关注的事情。
3. **确认主题计划。** 与 Telomi 讨论研究问题和范围，确认后开始研究。
4. **阅读并追问。** 打开报告、检查引用、浏览 Wiki，继续提出问题。想收听时，可以请求生成音频版本。
5. **持续积累。** 分享反馈，并从已发布的报告创建研究计划，跟进新的进展。

## 帮助与参与贡献

遇到 Bug 或安装问题，请通过本仓库的 Issues 反馈，附上版本、复现步骤和脱敏后的错误信息。安全漏洞请按[安全政策](SECURITY.zh-CN.md)私下报告。

希望参与开发，请从[贡献指南](CONTRIBUTING.zh-CN.md)和[文档索引](apps/telomi/docs/README.zh-CN.md)开始。

## 许可证

Telomi 的原创代码采用 [Apache License 2.0](LICENSE)。第三方代码和素材保留各自的许可证，详见[第三方声明](apps/telomi/THIRD_PARTY_NOTICES.md)。
