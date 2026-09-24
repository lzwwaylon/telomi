# 升级、备份与恢复

[English](upgrading.md) | 简体中文

普通安装使用已发布的 Release，贡献者使用 `dev`。升级使用 `npm run upgrade`：
它先为数据目录建立快照，任何一步失败都会自动回到之前的版本。
[手动流程](#手动升级)保留给还没有这条命令的安装（例如 0.0.1），以及命令自身
无法恢复的情况。修改已有安装前，先阅读目标 Release 的补充说明。

## 使用 `npm run upgrade` 升级

在安装所在仓库的根目录执行：

```bash
npm run upgrade                  # 最新发布的 Release
npm run upgrade -- --ref dev     # 贡献者：分支、Tag 或提交
```

已跟踪文件有本地改动时，命令拒绝执行；安装已经是目标版本时，什么也不做。
否则它会：

1. 停止 Telomi、它托管的浏览器和内嵌的长期记忆数据库，确保没有进程在写数据目录。
2. 为数据目录建立快照（见[快照](#快照)）。
3. 安装目标版本：`git switch --detach`、`npm ci`、`npm run setup` 和
   `npm run build`。使用本地音频时，之后再执行 `npm run setup:audio`。
4. 启动 Telomi。新版本需要时，启动过程会迁移数据格式。
5. 最多等待 10 分钟，直到 Telomi 针对这个数据目录正常响应并能列出 Goal。

任何一步失败，都会回到之前的版本：

- **数据格式没有变化**（数据目录中 `format.json` 的 `formatVersion`）：只恢复
  代码，期间写入的数据保留。
- **数据格式已变化**：同时恢复代码和快照。命令会报告快照时间，此后写入的数据
  不在恢复后的数据中。被替换的数据目录保留在旁边，名为
  `<数据目录>.replaced-<时间>`，作为这次失败迁移的证据。之后每次成功运行只保留
  最新的一个，更早的会被删除。

退出码：`0` 完成或无需操作；`1` 失败并已回到之前的版本；`2` 失败且无法自动
回退，请按[手动流程](#升级失败后恢复)从命令给出的快照恢复；`3` 见
[`--if-idle`](#空闲时自动升级)。

### 快照

快照存放在备份根目录下本安装自己的目录 `<备份根目录>/<installationId>/` 中，
`installationId` 记录在数据目录的 `format.json` 里。备份根目录是
`TELOMI_BACKUP_DIR`，默认是数据目录旁边的 `backups`（例如 `apps/telomi/backups`）。
数据目录位于同一父目录、或设置了相同 `TELOMI_BACKUP_DIR` 的多个安装会共用根目录，
但每个安装只会看到、清理和回滚到自己的快照。升级锁、升级进行中标记和
`--if-idle` 的忙碌记录也放在这个目录里。早期 `dev` 版本直接留在根目录下的快照
不会被改动；下一次升级会列出它们一次，便于手动删除。每个快照包含停止状态下数据目录的副本 `data/`，以及
记录时间、所属提交和 `formatVersion` 的 `snapshot.json`。在 APFS 上，与数据目录
位于同一卷的快照是写时复制克隆：几秒完成，数据变化前几乎不占额外空间；
其他情况下为完整复制。快照包含凭据和私人研究资料，请保持目录私有；需要在
磁盘损坏后仍然可用的备份时，把快照另外复制到其他位置。

`npm run upgrade -- --snapshot-only` 只建立快照、不改变代码：它会停止 Telomi
几秒，再以同一版本启动。命令保留最近 10 个升级前快照和最近 7 个
`--snapshot-only` 快照。

手动恢复快照：停止 Telomi，把数据目录移到别处，把快照中的 `data/` 复制回原
位置（macOS 用 `cp -cpR`，其他系统用 `cp -pR`），检出 `snapshot.json` 中记录的
提交，执行 `npm ci`、`npm run setup` 和 `npm run build`，再启动 Telomi。

### 回滚

`npm run upgrade -- --rollback` 回到最近一个属于更早版本的快照所对应的代码。
只有数据格式在此之后变化过，才会恢复该快照的数据；否则保留当前数据。

### 空闲时自动升级

加上 `--if-idle` 时，命令会先询问正在运行的服务停止它是否会打断工作
（`GET /api/runtime/idle`）。有 Goal 正在工作、有 Activity 在运行或排队，或定时
调研即将开始时，它输出原因、不做任何改动并以 `0` 退出。连续跳过满 24 小时后，
它输出警告并以 `3` 退出，便于调度器发现始终无法空闲的实例。`--if-idle` 从不
强制重启。

在 macOS 上，`npm run service` 会替你安排这些定时任务（见
[保持 Telomi 运行](#保持-telomi-运行)）。其他平台可以定时执行，例如每 15 分钟执行
`npm run upgrade -- --if-idle` 跟随 Release，或执行
`npm run upgrade -- --ref dev --if-idle --require-checks` 跟随 `dev`；每天执行一次
`npm run upgrade -- --snapshot-only --if-idle`。

`--require-checks` 只在某个提交的 GitHub check run 全部结束且没有失败时才安装它。
检查仍在进行、已经失败或无法读取时，它不做任何改动并以 `0` 退出，所以跟随的分支
会在检查通过后被自动采用。定时执行的 `--if-idle` 遇到另一次正在进行的升级或快照时，
同样不做改动并以 `0` 退出。

### 保持 Telomi 运行

在 macOS 上，可以把 Telomi 安装为当前登录用户的 launchd 服务：

```bash
npm run service -- install                    # 立即运行，每次登录时运行，退出后自动重启
npm run service -- install --auto-upgrade     # 同时在空闲时升级到新的 Release
npm run service -- install --auto-upgrade=dev --daily-snapshot   # 贡献者：跟随 dev
npm run service -- status                     # 另有 stop、start、restart、uninstall
```

- `install` 使用执行这条命令的 Node 运行 Telomi，也可以用 `--node <路径>` 指定。
  再次执行 `install` 会按新的选项替换任务。任务以 checkout 命名
  （`com.telomi.<id>.server`、`.auto-upgrade`、`.snapshot`），每个 checkout 各有
  一套。日志写在 `~/Library/Logs/Telomi/`。某个任务的日志超过 10 MB 时，由该任务
  自己的进程把内容移到 `<日志>.1`（替换上一份），然后在清空后的日志中继续写入；
  服务每分钟检查一次，定时任务在启动时检查。
- `--auto-upgrade` 每 15 分钟执行一次 `npm run upgrade -- --if-idle`；
  `--auto-upgrade=<ref>` 以 `--require-checks` 跟随该分支、标签或提交。
  `--daily-snapshot` 在每天 04:30（或 Mac 下次唤醒时）执行
  `npm run upgrade -- --snapshot-only --if-idle`。
- `stop` 停止 Telomi、它托管的浏览器和记忆数据库，以及定时任务，并且在重新登录后
  仍保持停止，直到执行 `start`。`uninstall` 删除这些任务。
- `status` 显示每个任务的状态和上次退出码、正在运行的代码、最近一次自动升级的结果，
  以及自动升级从何时起一直发现 Telomi 处于忙碌。
- `npm run upgrade` 会识别这个服务，并通过它停止和启动 Telomi。

如果 checkout 或数据目录在外接卷上，macOS 可能要求授权任务所用的 `node` 访问它。
未授权时，任务会以 "Operation not permitted" 失败（`status` 会报告），或者没有任何
输出地一直等待。请在 系统设置 > 隐私与安全性 > 完全磁盘访问权限 中添加该文件。
使用 Developer ID 签名的 Node（例如 nodejs.org 的安装包）在升级 Node 后仍保留授权；
ad-hoc 签名的 Node（例如 Homebrew 安装的）每次被替换都会失去授权，`install` 会对此
给出提示。目前只验证过 macOS 上的 launchd。

### 其他进程守护

没有安装服务、也没有下面的设置时，命令会停止本 checkout 通过 `npm start`、
`npm run dev` 或 `npm run worktree -- run` 启动的进程，结束后在后台执行
`npm start`，输出写入数据目录中的 `.pi/runtime/logs/server.log`。

由 systemd 等其他守护进程运行 Telomi 时，只停止进程不够：守护进程会在升级中途
重新启动旧版本。在 `apps/telomi/.env.local` 中告诉命令如何停止和启动服务，两条命令
都在仓库根目录通过 `/bin/sh` 执行：

```bash
TELOMI_SERVICE_STOP=systemctl --user stop telomi
TELOMI_SERVICE_START=systemctl --user start telomi
```

停止命令必须让服务不被重新拉起：`Restart=` 不会撤销 `systemctl stop`。作为保险，
升级正在修改安装时 Telomi 拒绝启动，因此即使守护进程仍然重启它，也无法写入正在
复制或替换的数据。在守护进程下（包括 `npm run service`），命令看不到服务进程，
始终无法正常响应的版本要等 10 分钟等待结束才会被发现。

## 手动升级

以下步骤用于版本中还没有 `npm run upgrade` 的安装（例如 0.0.1），以及命令以
状态 `2` 退出后的恢复。

### 修改代码之前

1. 记录当前 Release、`git rev-parse HEAD`、目标 Release、使用的配置文件，以及
   数据目录中 `format.json` 的 `formatVersion`。
   执行 `git status --short`，切换版本前处理本地代码改动，不要用硬重置丢弃改动。
2. 在应用中完成或取消正在执行的研究、Wiki 更新和音频任务，再停止 Telomi。
   本 checkout 管理的命令使用 `npm run worktree -- stop`；在启动器之外自行
   启动的服务需要单独停止。备份前停止应用，升级期间保持停止状态。
3. 为下列状态建立可恢复的备份，存放在 checkout 外并限制访问权限，因为其中
   包含凭据和私人研究资料。确认备份文件可读，并记录对应代码版本。
   Git Tag 或源代码副本不等于数据备份。

### 备份范围

在 Telomi 停止运行时备份：

| 状态 | 位置与约束 |
|---|---|
| 全部安装状态：Goal、研究、Wiki、报告、设置、凭据、运行数据库、长期记忆及托管浏览器的登录状态 | **完整的实际 `TELOMI_DATA_DIR`**，默认 `apps/telomi/data`。包含隐藏文件。以实际运行配置为准，适用时包括 `.env.worktree` 的覆盖值。 |
| 环境与自定义位置 | 使用中的 `.env`、`.env.local`、`.env.worktree`（包括 `HINDSIGHT_BANK_ID`），以及安装配置中指定的外部凭据、存储和数据库位置。记录位置，不公开其中的值。 |

数据目录中的长期记忆数据库和浏览器 Profile 只有在 Telomi 停止时才处于一致状态。
缓存目录（`TELOMI_CACHE_DIR`，默认 `apps/telomi/cache`）只存放可重新下载的内容，
不需要备份。如果 `HINDSIGHT_API_DATABASE_URL` 指向外部的 `postgresql://` 数据库，
请使用该数据库支持的流程备份；无法备份时，这份备份不能视为完整恢复点。

#### 格式版本 2 之前的安装

数据目录中没有 `format.json`，或其中记录的 `formatVersion` 为 1（例如
Telomi 0.0.1）时，有两部分状态存放在别处，升级前也要一并备份：

- **长期记忆**：`HINDSIGHT_API_DATABASE_URL` 指定的 pg0 实例，未设置时默认为
  `telomi-<数据目录哈希>`，文件位于 `~/.pg0/instances/<instance-name>`。复制前先
  停止这一个实例；不要停止或复制机器上的所有 pg0 实例。
- **浏览器登录状态**：`apps/telomi/.chrome-debug-profile`，需先停止对应的 Chrome 进程。

新版本首次启动时会把两者移入数据目录。数据目录位于另一个卷时会复制过去并保留
原件，下面的检查通过后可以删除原件。

### 安装选定的 Release

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

### 恢复日常使用前验证

通过 `npm run dev` 或已有部署说明中的命令启动，然后检查：

- 应用可以打开，原有 Goal、报告和 Wiki 页面可读。
- 模型及 Source 连接可用，账户身份没有改变。
- 小规模、非敏感的对话及相关研究/Wiki 流程可以完成。
- 已启用的长期记忆及可选音频功能可用。
- 运行版本符合目标，且没有持续的启动错误。

检查通过前保留备份。仅页面可打开或构建成功，不足以证明升级保留了可用的数据
和集成能力。

### 升级失败后恢复

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
