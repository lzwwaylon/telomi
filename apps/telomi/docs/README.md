# Telomi documentation

English | [简体中文](README.zh-CN.md)

Choose documents by task. When a change spans several capabilities, read each relevant contract. If sources conflict, the order of authority is current schemas and Runtime code, runnable tests, production contract documentation, then historical records.

## User guides

| Task | Guide |
|---|---|
| Understand Telomi, install it, or start the application | [Project README](../../../README.md) |
| Upgrade an installation, back up data, or recover it | [Upgrading and recovery](upgrading.md) |
| Configure a third-party local speech service or troubleshoot local STT/TTS | [Speaches local speech guide](local-speech-server.md) |

## Development and maintenance

Technical documentation is maintained in English. User guides have English and Simplified Chinese editions; the existing release guide also remains bilingual. See the [documentation language policy](development/documentation.md#language-policy) when editing or adding documents.

| Task | Entry point |
|---|---|
| Prepare a Worktree, run checks, validate, or submit a change | [Contributor guide](../../../CONTRIBUTING.md) |
| Change domain terms, contracts, Prompts, Skills, or user-facing text | Relevant terms and their `_Avoid_` lines in the [domain model](../../../CONTEXT.md) |
| Modify an Agent, Prompt, Skill, or Tool | [Agent authoring](development/agent-authoring.md) and [Attestation](development/attestation.md) |
| Edit project explanations, module documentation, or contribution guides | [Documentation requirements](development/documentation.md) |
| Submit a PR, accept a version, or publish a Release | [Branches and releases](development/releases.md) |
| Change module responsibilities, interfaces, or code ownership | The corresponding module in the [module index](modules/README.md) |

## Execution contracts and design rationale

| Task | Document |
|---|---|
| Modify the search, evidence, report, or asynchronous Wiki pipeline | [Research Runtime](research.md) |
| Modify Source reading or Cornell Note inputs and outputs | [Cornell Note Agent](cornell-note-agent.md) |
| Modify Case Capture, Replay Recipes, or Operations contracts | [Node Evaluation](node-agent-backtest.md) |
| Modify Source document parsing and normalization | [Document Parsing Runtime](document-parsing-runtime.md) |
| Modify Source registration, connection status, Provider services, caches, or document parsing APIs | [Research Source Service](../services/research-source-service/README.md) |
| Modify Prime Search working directories, Skill mounts, or sandbox boundaries | [Prime Search Workspace](prime-search-workspace.md) |
| Modify Browser Skill Evolution, its triggers, or automatic application | [Evolution Module](evolution-module-design.md) |
| Change the Topic Plan and Discovery feedback loop | [Design rationale](topic-plan-and-discovery.md) |
