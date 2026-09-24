# 参与贡献 Telomi

[English](CONTRIBUTING.md) | 简体中文

Telomi 使用功能分支、`dev` 集成、发布验收、`main` 和版本发布的流程。普通贡献从 `dev` 创建分支，并向 `dev` 提交 Pull Request。

## 问题反馈与提案

通过 Issue 表单提交可复现的 Bug、安装/升级求助或可公开的功能建议。
先检索已有 Issue、已合并 PR 和当前代码。较大功能或新集成先讨论范围；
小修复可以直接提交范围集中的 PR。优先保证正确性、数据保留和可靠安装，
再扩展功能。

反馈时提供受影响版本、环境、最小复现及脱敏证据，不上传数据目录、凭据或
私人研究资料。安全漏洞按 [SECURITY.md](SECURITY.zh-CN.md) 私下报告。
升级时遵循[备份与恢复说明](apps/telomi/docs/upgrading.zh-CN.md)。

## 开发环境

| 任务 | 先读 |
|---|---|
| 首次安装或启动产品 | [安装](README.zh-CN.md#安装) |
| 配置服务或凭据 | [环境配置说明](apps/telomi/.env.example)；凭据和运行数据保持在 Git 之外 |
| 了解领域术语、职责与接口 | [CONTEXT.md](CONTEXT.md)与[模块索引](apps/telomi/docs/modules/README.md)中的相关内容 |

完成安装后，在仓库根目录执行 `npm run dev`，启用服务端和前端热更新。
打开 <http://127.0.0.1:5174>，开发 API 使用 8787 端口；Worktree 使用各自分配的端口。

## 开发与验证

按变更类型选择验证；多个条件同时成立时，各分支都适用。

| 任务 | 先读 |
|---|---|
| 编写或运行确定性测试、修改 Hook | [确定性测试](apps/telomi/docs/development/testing.md) |
| 修改产品 Agent、Prompt、Skill 或 Tool；新增 Agent 环节或输出契约 | [产品 Agent 开发](apps/telomi/docs/development/agent-authoring.md)及[行为验证要求](apps/telomi/docs/development/attestation.md) |
| 修改能从前端触发的用户流程 | [真实 E2E](apps/telomi/docs/development/e2e.md) |
| 修改 Source Provider、Provider Python SDK、Source Service 或 Prime Search Provider Skill | [Provider 验证](apps/telomi/docs/development/testing.md#provider-validation)及[行为验证要求](apps/telomi/docs/development/attestation.md) |
| 改变模块职责、接口、权限或隐含约束；修改项目文档 | [文档编写与维护条件](apps/telomi/docs/development/documentation.md) |

基础构建与确定性检查不需要维护者的私人配置或评估环境。涉及真实模型、上游服务或硬件的验证与基础 CI 分开；贡献者提供复现与预期行为，维护者负责合并前的相应验收。

## Worktree

需要并行开发时，可使用仓库提供的隔离 Worktree 工具。普通 checkout 也支持正常开发。

| 任务 | 先读 |
|---|---|
| 创建、初始化或排查 Worktree 环境 | [Worktree 环境](apps/telomi/docs/development/worktree-setup.md) |
| 在 Worktree 启动服务或运行检查 | [Worktree 命令](apps/telomi/docs/development/worktree-commands.md) |
| 停止或删除 Worktree | [Worktree 清理](apps/telomi/docs/development/worktree-cleanup.md) |

## 提交变更前

完成[提交检查](apps/telomi/docs/development/testing.md#submission-checks)，在 PR 中说明问题、最终行为、验证结果及限制。一个 PR 围绕一个明确问题，避免混入无关变更。

PR 目标、发布验收、紧急修复和 Tag/Release 的完整约定见[分支与发布](apps/telomi/docs/development/releases.zh-CN.md)。
