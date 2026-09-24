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

在 Telomi 停止运行时备份：

| 状态 | 位置与约束 |
|---|---|
| 全部安装状态：Goal、研究、Wiki、报告、设置、凭据、运行数据库、长期记忆及托管浏览器的登录状态 | **完整的实际 `TELOMI_DATA_DIR`**，默认 `apps/telomi/data`。包含隐藏文件。以实际运行配置为准，适用时包括 `.env.worktree` 的覆盖值。 |
| 环境与自定义位置 | 使用中的 `.env`、`.env.local`、`.env.worktree`（包括 `HINDSIGHT_BANK_ID`），以及安装配置中指定的外部凭据、存储和数据库位置。记录位置，不公开其中的值。 |

数据目录中的长期记忆数据库和浏览器 Profile 只有在 Telomi 停止时才处于一致状态。
缓存目录（`TELOMI_CACHE_DIR`，默认 `apps/telomi/cache`）只存放可重新下载的内容，
不需要备份。如果 `HINDSIGHT_API_DATABASE_URL` 指向外部的 `postgresql://` 数据库，
请使用该数据库支持的流程备份；无法备份时，这份备份不能视为完整恢复点。

### 格式版本 2 之前的安装

数据目录中没有 `format.json`，或其中记录的 `formatVersion` 为 1（例如
Telomi 0.0.1）时，有两部分状态存放在别处，升级前也要一并备份：

- **长期记忆**：`HINDSIGHT_API_DATABASE_URL` 指定的 pg0 实例，未设置时默认为
  `telomi-<数据目录哈希>`，文件位于 `~/.pg0/instances/<instance-name>`。复制前先
  停止这一个实例；不要停止或复制机器上的所有 pg0 实例。
- **浏览器登录状态**：`apps/telomi/.chrome-debug-profile`，需先停止对应的 Chrome 进程。

新版本首次启动时会把两者移入数据目录。数据目录位于另一个卷时会复制过去并保留
原件，下面的检查通过后可以删除原件。

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

从格式版本 2 起，数据目录包含内嵌（pg0）记忆数据库。外部 `postgresql://` 数据库
不在其中：如果新版本的发布说明提到它改变了记忆存储，需要从同一个恢复点一并还原。

从同一个升级前恢复点还原**匹配的代码、配置、产品数据及记忆数据库**。
恢复到空的目标位置，不把旧文件覆盖叠加到失败安装上。保持记录的数据路径和
Bank 身份，重新安装旧版本锁定的依赖及受管理环境，再执行上述验证。
PostgreSQL 物理备份需要兼容的数据库运行时；应遵循数据库支持的恢复流程，
不能假定任何版本都能读取其文件。

还原备份会丢失备份之后产生的变更。恢复前单独导出或保留这些变更。如果没有
完整恢复点，先停止并提供新旧版本及脱敏错误寻求帮助；仅切换 Git 版本不是
通用的安全回滚方式。
