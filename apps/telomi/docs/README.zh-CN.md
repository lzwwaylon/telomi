# Telomi 文档

[English](README.md) | 简体中文

按任务选择文档；修改多个能力时读取各自的契约。冲突时的权威顺序是：当前 Schema 和 Runtime 代码、可运行测试、生产契约文档、历史记录。

## 用户指南

| 任务 | 指南 |
|---|---|
| 了解产品、安装或启动应用 | [项目 README](../../../README.zh-CN.md) |
| 升级已有安装、备份或恢复数据 | [升级与恢复](upgrading.zh-CN.md) |
| 配置第三方本地语音服务，或处理本地 STT/TTS 的支持请求 | [Speaches 本地语音参考](local-speech-server.zh-CN.md) |

## 开发与维护

技术文档统一使用英文维护。用户指南提供中英双语，已有发布指南也保留双语。编辑或新增文档时，遵循[文档语言政策](development/documentation.md#language-policy)。下列技术文档链接指向英文权威版本。

| 任务 | 入口 |
|---|---|
| 准备 Worktree、运行检查、验证或提交变更 | [开发索引](../../../CONTRIBUTING.zh-CN.md) |
| 修改领域术语、契约、Prompt、Skill 或用户文案 | [领域模型](../../../CONTEXT.md)中相关术语及其 `_Avoid_` 行 |
| 修改 Agent、Prompt、Skill 或 Tool | [Agent 编写](development/agent-authoring.md)及 [Attestation](development/attestation.md) |
| 修改项目说明、模块文档或贡献指南 | [文档编写](development/documentation.md) |
| 提交 PR、验收版本或发布 Release | [分支与发布](development/releases.zh-CN.md) |
| 调整模块职责、接口或代码归属 | [模块索引](modules/README.md)中的对应模块 |

## 执行契约与设计依据

| 任务 | 文档 |
|---|---|
| 修改搜索、证据处理、报告或异步 Wiki 的主链路 | [Research Runtime](research.md) |
| 修改 Source 审阅或 Cornell Note 输入输出 | [Cornell Note Agent](cornell-note-agent.md) |
| 修改 Case Capture、Replay Recipe 或 Operations 契约 | [Node Evaluation](node-agent-backtest.md) |
| 修改 Source 文档解析和规范化 | [Document Parsing Runtime](document-parsing-runtime.md) |
| 修改 Source 注册、连接状态、Provider 服务、缓存或文档解析 API | [Research Source Service](../services/research-source-service/README.md) |
| 修改 Prime Search 工作目录、Skill 挂载或沙箱边界 | [Prime Search Workspace](prime-search-workspace.md) |
| 修改 Browser Skill 演化、触发或自动应用 | [Evolution Module](evolution-module-design.md) |
| 调整 Topic Plan 与 Discovery 的闭环 | [设计依据](topic-plan-and-discovery.md) |
