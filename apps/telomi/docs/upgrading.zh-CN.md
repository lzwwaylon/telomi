# 升级、备份与恢复

[English](upgrading.md) | 简体中文

普通安装使用已发布的 Release，贡献者使用 `dev`。本文说明手动升级流程；
Telomi 当前没有一键更新器或通用数据库降级命令。修改已有安装前，先阅读目标
Release 的补充说明。

## 修改代码之前

1. 记录当前 Release、`git rev-parse HEAD`、目标 Release、使用的配置文件，以及
   数据目录中 `format.json` 的 `formatVersion`。
   执行 `git status --short`，切换版本前处理本地代码改动，不要用硬重置丢弃改动。
2. 在应用中完成或取消正在执行的研究、Wiki 更新和音频任务，再停止 Telomi。
   本 checkout 管理的命令使用 `npm run worktree -- stop`；在启动器之外自行
   启动的服务需要单独停止。备份前停止应用，升级期间保持停止状态。
3. 为下列状态建立可恢复的备份，存放在 checkout 外并限制访问权限，因为其中
   包含凭据和私人研究资料。确认备份文件可读，并记录对应代码版本。
   Git Tag 或源代码副本不等于数据备份。

## 备份范围

| 状态 | 位置与约束 |
|---|---|
| Goal、研究、Wiki、报告、设置、运行数据库及项目凭据 | **完整的实际 `TELOMI_DATA_DIR`**，默认 `apps/telomi/data`。包含隐藏文件和 SQLite 附属文件。以实际运行配置为准，适用时包括 `.env.worktree` 的覆盖值。 |
| 环境与自定义位置 | 使用中的 `.env`、`.env.local`、`.env.worktree`，以及安装配置中指定的外部凭据、存储和数据库位置。记录位置，不公开其中的值。 |
| 长期记忆 | Hindsight 使用**独立的 PostgreSQL 数据库**，未设置 `HINDSIGHT_API_DATABASE_URL` 时默认使用以数据目录命名的本地 pg0 实例 `telomi-<数据目录哈希>`，Bank 身份为 `HINDSIGHT_BANK_ID`。复制 `TELOMI_DATA_DIR` 不包含该数据库，需保留 Bank 身份。 |
| 浏览器登录状态 | 停止对应 Chrome 进程后备份受管理的 Profile，通常位于 `apps/telomi/.chrome-debug-profile`。其中包含 Cookie。外部浏览器 Profile 单独管理。 |

本地 pg0 数据库应按数据库 URL 确认实例名。默认实例元数据位于
`~/.pg0/instances/<instance-name>`，Worktree 使用各自的实例名。文件系统备份前
先停止对应 PostgreSQL 实例；如果其实际数据目录位于其他位置，也要包含该目录。
不要停止或复制机器上的所有 pg0 实例。

外部管理的 PostgreSQL/Hindsight 服务应使用其支持的备份恢复流程，并与服务
管理者协调。无法备份记忆数据库时，备份是不完整的，不能视为完整恢复点。
依赖和模型下载缓存可以重新安装，不能代替上述数据和数据库备份。

## 安装选定的 Release

完成备份、确认工作区干净后，在原 checkout 中执行：

```bash
git fetch origin --tags
# 将 vX.Y.Z 替换为选定的准确 Release Tag。
git switch --detach vX.Y.Z
npm ci
npm run setup
npm run build
```

`npm ci` 安装锁定的 Node 依赖；setup 准备 Hindsight、Research Python 环境和
Prime Kernel。使用本地音频时，还需在支持的 Apple Silicon macOS 主机上执行
`npm run setup:audio`。任一步骤失败就停止，并保存脱敏后的错误输出。

对照新 `.env.example` 和 Release 说明检查设置。保留现有 `.env.local`、凭据、
Bank 身份及数据路径，不用示例文件覆盖。依赖安装成功不能证明数据库迁移可逆。

数据目录在 `format.json` 中记录格式（`formatVersion` 和 `installationId`）。
启动时，Telomi 会把旧格式逐步向前迁移，每一步都写日志，并且只在该步成功后才
记录新版本。在引入格式版本之前创建的数据目录，会原样认定为版本 1。以下两种
情况启动会被拒绝，拒绝时不做任何改动：

- 配置的数据目录不存在，例如所在的外接卷没有挂载。Telomi 只会自动创建
  checkout 自带的默认 `data/` 目录。
- `formatVersion` 高于当前代码支持的版本，说明数据已经被更新版本的 Telomi
  迁移过。

## 恢复日常使用前验证

通过 `npm run dev` 或已有部署说明中的命令启动，然后检查：

- 应用可以打开，原有 Goal、报告和 Wiki 页面可读。
- 模型及 Source 连接可用，账户身份没有改变。
- 小规模、非敏感的对话及相关研究/Wiki 流程可以完成。
- 已启用的长期记忆及可选音频功能可用。
- 运行版本符合目标，且没有持续的启动错误。

检查通过前保留备份。仅页面可打开或构建成功，不足以证明升级保留了可用的数据
和集成能力。

## 升级失败后恢复

停止新版本，另行保留其日志和已修改的数据以便调查。把数据目录 `format.json`
中的 `formatVersion` 与升级前记录的值对比：

- **没有变化**：新版本没有迁移数据目录，只需还原之前的代码和依赖。
- **变大了**：旧代码会拒绝在这份数据上启动，需要按下文还原完整的恢复点。

格式版本只覆盖数据目录。如果新版本的发布说明提到它改变了记忆存储，需要从
同一个恢复点一并还原 Hindsight 数据库。

从同一个升级前恢复点还原**匹配的代码、配置、产品数据及 Hindsight 数据库**。
恢复到空的目标位置，不把旧文件覆盖叠加到失败安装上。保持记录的数据路径和
Bank 身份，重新安装旧版本锁定的依赖及受管理环境，再执行上述验证。
PostgreSQL 物理备份需要兼容的数据库运行时；应遵循数据库支持的恢复流程，
不能假定任何版本都能读取其文件。

还原备份会丢失备份之后产生的变更。恢复前单独导出或保留这些变更。如果没有
完整恢复点，先停止并提供新旧版本及脱敏错误寻求帮助；仅切换 Git 版本不是
通用的安全回滚方式。
