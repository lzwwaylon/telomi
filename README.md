<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/telomi/web/public/brand/telomi-lockup-dark.png">
    <img src="apps/telomi/web/public/brand/telomi-lockup-light.png" alt="Telomi: a curious bird with a leaf-shaped wing and a gently extended tail" width="220" height="64">
  </picture>
</p>

<h1 align="center">A research companion that grows with you</h1>

<p align="center">English | <a href="README.zh-CN.md">简体中文</a></p>

<p align="center"><strong>Explore further. Bring back understanding.</strong></p>

Telomi is a personal AI research companion built around your long-term goals. It collects sources, writes reports with traceable citations, turns reports into audio, and builds a Wiki you can return to as your understanding grows.

Telomi is currently focused on and optimized for research on AI-related topics.

Telomi runs locally for a single user. Models and research sources may use external services. It is under active development; check the cited sources when using its conclusions.

## Features

| Feature | What you can do |
|---|---|
| Goal-centered conversation | Keep questions, context and follow-up discussions together around a long-term interest. |
| Research and cited reports | Investigate a question and inspect the evidence behind the answer. |
| Reports from your Wiki | Use accumulated knowledge to answer a new question or write for a different audience. |
| Report-to-audio | Listen to a spoken adaptation with your preferred depth and presentation. |
| Goal Wiki | Browse and search connected knowledge accumulated across research runs. |
| Long-term memory | Bring your expressed preferences and previous context into later conversations. |
| Scheduled research | Follow developments with recurring research while Telomi is running. |
| Voice interaction | Use speech input and output with local or cloud audio services. |

## Model providers

Choose a provider in Settings, then sign in or supply an API key as supported by that provider. Select conversation, embedding and audio models there; available capabilities and authentication methods vary by service.

| Connection | Available providers |
|---|---|
| Model services | OpenAI, OpenAI Codex, Anthropic, Google Gemini, DeepSeek, Mistral, xAI, Moonshot/Kimi, MiniMax, Qwen, Z.AI, Ant Ling, Xiaomi |
| Cloud platforms and gateways | OpenRouter, Hugging Face, Groq, Cerebras, Fireworks, Together, Baseten, NVIDIA, Amazon Bedrock, Azure OpenAI, Google Vertex AI, Cloudflare AI Gateway / Workers AI, Vercel AI Gateway, GitHub Copilot, OpenCode |
| Local and custom connections | Ollama and custom OpenAI-compatible endpoints |

## Installation

Telomi currently runs from a local source checkout. Installation has been verified on Apple Silicon macOS. Install:

- Git, Node.js 24 and npm
- [uv](https://docs.astral.sh/uv/) to prepare the required Python environments
- Google Chrome for browser-based research

Clone this repository using its **Code** menu URL, then run the following from the cloned directory for a first installation:

```bash
npm ci
cp apps/telomi/.env.example apps/telomi/.env.local
npm run setup
npm run build
npm start
```

`npm run setup` prepares the Python environments Telomi manages: the Hindsight memory service, the Research Source Service and the Prime Agent kernel, all installed with uv. A cold setup downloads Python interpreters and packages, so how long it takes depends on your network. Local audio (MLX) is not part of `setup`; on Apple Silicon macOS, run `npm run setup:audio` separately.

Once startup completes, open <http://127.0.0.1:8787>. Keep Telomi running while using it or waiting for scheduled research.

Telomi keeps what it creates, including Goals, reports, the Wiki, settings and saved credentials, under `apps/telomi/data` by default; set `TELOMI_DATA_DIR` to use another directory. Telomi creates only the default directory itself; create any other directory before the first start, so that an unmounted drive is reported instead of silently starting an empty installation. Long-term memory is stored in a separate local PostgreSQL (pg0) database. See [upgrade, backup and recovery](apps/telomi/docs/upgrading.md) for what to back up.

For voice features, connect a cloud audio service in Settings, or follow the [optional local audio setup](apps/telomi-audio-local/README.md) on Apple Silicon macOS.

For an existing installation, follow [upgrade, backup and recovery](apps/telomi/docs/upgrading.md) before changing versions; keep your existing configuration and data.

## Getting started

1. **Configure your models.** Open Settings, connect your preferred provider and choose your conversation model and embedding models for search and memory. Nothing is preselected: Wiki search uses keywords and links until you choose an embedding model, and long-term memory starts once it has one; the memory service's own local model needs no key. Signing in or entering a key only saves the credential; it takes effect after you click **Save and apply**, which validates it first. A credential saved with **Save for later** stays inactive until you apply it. Long-term memory needs a connection whose model API is `openai-completions`, `anthropic-messages` or `openai-responses`; an OpenAI Codex (`openai-codex`) login cannot serve memory, and the memory section of Settings reports such a failure. Add audio services if you want voice features; reading aloud and recognition also start only once you choose their models, including the local speech runtime's.
2. **Create a Goal.** Describe something you want to understand or keep following.
3. **Confirm the topic plan.** Discuss the questions and scope with Telomi before starting research.
4. **Read and follow up.** Open the report, inspect its citations, browse the Wiki and ask further questions. Request an audio version when you prefer listening.
5. **Keep learning.** Share feedback and create a research schedule from a published report to follow new developments.

## Help and contributing

For bugs or installation questions, use this repository's Issues and include your version, reproduction steps and redacted errors. Report security vulnerabilities privately using the [security policy](SECURITY.md).

To contribute, start with the [contribution guide](CONTRIBUTING.md) and [development documentation](apps/telomi/docs/README.md).

## License

Telomi's original code is licensed under the [Apache License 2.0](LICENSE). Third-party code and assets retain their own licenses; see [third-party notices](apps/telomi/THIRD_PARTY_NOTICES.md).
