# Upgrade, backup and recovery

English | [简体中文](upgrading.zh-CN.md)

Use a published Release for an ordinary installation. `dev` is for contributors.
Upgrade with `npm run upgrade`, which snapshots the data directory first and
returns to the previous version by itself when anything fails. The
[manual procedure](#manual-upgrade) remains for installations that predate the
command, such as 0.0.1, and for recovering when the command cannot. Follow any
additional instructions in the target Release before changing an existing
installation.

## Upgrade with `npm run upgrade`

Run it from the repository root of the installation:

```bash
npm run upgrade                  # the latest published Release
npm run upgrade -- --ref dev     # contributors: a branch, tag or commit
```

It refuses to start when tracked files have local changes, and does nothing when
the installation already runs the target. Otherwise it:

1. Stops Telomi, its managed browser and its embedded long-term memory database,
   so that nothing is writing to the data directory.
2. Snapshots the data directory (see [Snapshots](#snapshots)).
3. Installs the target: `git switch --detach`, `npm ci`, `npm run setup` and
   `npm run build`. If you use local audio, run `npm run setup:audio` afterwards.
4. Starts Telomi. Startup migrates the data format when the new version needs it.
5. Waits up to 10 minutes for Telomi to answer for this data directory and list
   its Goals.

If any step fails, it returns to the previous version:

- **The data format did not change** (`formatVersion` in the data directory's
  `format.json`): only the code is restored. Data written in the meantime is kept.
- **The data format changed**: the code and the snapshot are restored. The
  command reports the time of the snapshot; anything written after it is not in
  the restored data. The replaced data directory is kept next to it as
  `<data directory>.replaced-<time>`, as evidence of the failed migration. The
  next successful run keeps only the most recent one and deletes older ones.

Exit status: `0` done or nothing to do, `1` failed and returned to the previous
version, `2` failed and could not return (recover with the
[manual procedure](#recover-from-a-failed-upgrade) from the snapshot it names),
`3` see [`--if-idle`](#upgrade-automatically-when-idle).

### Snapshots

Snapshots go to this installation's own directory under the backup root:
`<backup root>/<installationId>/`, where `installationId` is recorded in the data
directory's `format.json`. The backup root is `TELOMI_BACKUP_DIR`, by default
`backups` next to the data directory (for example `apps/telomi/backups`).
Installations whose data directories share a parent, or that set the same
`TELOMI_BACKUP_DIR`, share the root, but each only ever sees, prunes and rolls
back to its own snapshots. The upgrade lock, the upgrade-in-progress marker and
the `--if-idle` busy record live in the same directory. Snapshots that an earlier
`dev` build left directly in the root are never touched; the next upgrade names
them once, so you can delete them by hand. Each snapshot holds a copy of the stopped
data directory in `data/` and a `snapshot.json` recording its time, the commit
it belongs to and its `formatVersion`. On APFS, a snapshot on the same volume as
the data directory is a copy-on-write clone: it takes seconds and uses little
space until the data changes. Elsewhere it is a full copy. Snapshots contain
credentials and private research; keep the directory private, and copy
snapshots elsewhere if you want a backup that survives losing the disk.

`npm run upgrade -- --snapshot-only` takes a snapshot without changing the code:
it stops Telomi for a few seconds and starts the same version again. The
command keeps the 10 most recent snapshots taken before upgrades and the 7 most
recent `--snapshot-only` ones.

To restore one by hand, stop Telomi, move the data directory aside, copy the
snapshot's `data/` back in its place (`cp -cpR` on macOS, `cp -pR` elsewhere),
check out the commit in its `snapshot.json`, run `npm ci`, `npm run setup` and
`npm run build`, then start Telomi.

### Roll back

`npm run upgrade -- --rollback` returns to the code of the most recent snapshot
that belongs to an earlier version. It restores that snapshot's data only if the
data format has changed since; otherwise the current data is kept.

### Upgrade automatically when idle

With `--if-idle`, the command first asks the running server whether stopping it
would interrupt work (`GET /api/runtime/idle`). While a Goal is working, an
Activity is running or queued, or scheduled research is due soon, it prints the
reasons, changes nothing and exits `0`. After it has skipped for 24 hours in a
row, it prints a warning and exits `3`, so a scheduler can report an instance
that never becomes idle. `--if-idle` never forces a restart.

On macOS, `npm run service` schedules this for you (see
[Keep Telomi running](#keep-telomi-running)). Elsewhere, run it on a schedule,
for example every 15 minutes, with `npm run upgrade -- --if-idle` for Releases or
`npm run upgrade -- --ref dev --if-idle --require-checks` to follow `dev`, and
once a day with `npm run upgrade -- --snapshot-only --if-idle`.

`--require-checks` installs a commit only after all of its GitHub check runs have
finished without failing. While they are pending or failed, or cannot be read, it
changes nothing and exits `0`, so a followed branch is picked up once its checks
pass. A scheduled `--if-idle` run that finds another upgrade or snapshot in
progress also changes nothing and exits `0`.

### Keep Telomi running

On macOS, install Telomi as a launchd service of the signed-in user:

```bash
npm run service -- install                    # run now and at every login; restart it if it exits
npm run service -- install --auto-upgrade     # also upgrade to new Releases when idle
npm run service -- install --auto-upgrade=dev --daily-snapshot   # contributors: follow dev
npm run service -- status                     # also: stop, start, restart, uninstall
```

- `install` runs Telomi with the Node that runs the command, or the one given
  with `--node <path>`. Installing again replaces the jobs with the new options.
  Jobs are named after the checkout (`com.telomi.<id>.server`, `.auto-upgrade`,
  `.snapshot`), so every checkout has its own. Logs go to `~/Library/Logs/Telomi/`.
  When a job's log exceeds 10 MB, the job's own process moves its content to
  `<log>.1`, replacing the previous one, and continues in the emptied log; the
  server checks every minute, the scheduled jobs when they start.
- `--auto-upgrade` runs `npm run upgrade -- --if-idle` every 15 minutes;
  `--auto-upgrade=<ref>` follows that branch, tag or commit with `--require-checks`.
  `--daily-snapshot` runs `npm run upgrade -- --snapshot-only --if-idle` at 04:30,
  or when the Mac next wakes.
- `stop` stops Telomi, its managed browser and memory database, and the scheduled
  jobs, and keeps them stopped across logins until `start`. `uninstall` removes
  the jobs.
- `status` shows each job's state and last exit code, the running code, the last
  automatic upgrade and since when automatic upgrades have found Telomi busy.
- `npm run upgrade` finds the service and stops and starts Telomi through it.

If the checkout or the data directory is on an external volume, macOS may require
permission for the job's `node` to use it. Without it the jobs fail with
"Operation not permitted", which `status` reports, or wait without output. Add
that file under System Settings > Privacy & Security > Full Disk Access. A Node
signed with a Developer ID, such as the installer from nodejs.org, keeps the
permission across Node upgrades; an ad-hoc signed one, such as Homebrew's, loses it
whenever it is replaced, and `install` warns about it. Only macOS with launchd has
been verified.

### Other supervisors

Without a service or the settings below, the command stops what this checkout
started with `npm start`, `npm run dev` or `npm run worktree -- run`, and
afterwards starts `npm start` in the background, writing its output to
`.pi/runtime/logs/server.log` in the data directory.

When another supervisor, such as systemd, runs Telomi, stopping the process is not
enough: the supervisor would restart the old version in the middle of the upgrade.
Tell the command how to stop and start the service in `apps/telomi/.env.local`;
both run through `/bin/sh` in the repository root:

```bash
TELOMI_SERVICE_STOP=systemctl --user stop telomi
TELOMI_SERVICE_START=systemctl --user start telomi
```

The stop command must keep the service from being restarted: `systemctl stop` is
not undone by `Restart=`. As a safeguard, Telomi refuses to start while an upgrade
is changing its installation, so a supervisor that restarts it anyway cannot write
to data that is being copied or replaced. Under a supervisor, `npm run service`
included, the command cannot see the server process, so a version that never
becomes healthy is detected when the 10-minute wait ends.

## Manual upgrade

Use these steps for an installation whose version has no `npm run upgrade` yet,
such as 0.0.1, and to recover when the command exits with status `2`.

### Before changing code

1. Record the current Release and `git rev-parse HEAD`, the target Release,
   the configuration files you use, and `formatVersion` from `format.json` in
   the data directory. Run `git status --short`; resolve local code
   changes before switching versions. Do not discard them with a hard reset.
2. Finish or cancel active research, Wiki updates and audio jobs through the
   application, then stop Telomi. For commands managed by this checkout, use
   `npm run worktree -- stop`; separately stop services you started outside that
   launcher. Stop before backup, and keep the application stopped during upgrade.
3. Make a recoverable backup of the state below. Store it outside the checkout
   with restricted access: it contains credentials and private research. Confirm
   the files are readable and record the corresponding code version. A Git tag
   or a copy of the source tree is not a data backup.

### What to back up

With Telomi stopped, back up:

| State | Location and constraint |
|---|---|
| All installation state: Goals, research, Wiki, reports, settings, credentials, runtime databases, long-term memory and the managed browser's logins | The **entire resolved `TELOMI_DATA_DIR`**, default `apps/telomi/data`. Include hidden files. Use the actual running configuration, including `.env.worktree` where applicable. |
| Environment and custom locations | `.env`, `.env.local`, `.env.worktree` if used, including `HINDSIGHT_BANK_ID`, and any external credential, storage or database paths configured by the installation. Record their locations without publishing their values. |

The long-term memory database and the browser profile inside the data directory
are consistent only while Telomi is stopped. The cache directory
(`TELOMI_CACHE_DIR`, default `apps/telomi/cache`) holds only downloads and does
not need a backup. If `HINDSIGHT_API_DATABASE_URL` points to an external
`postgresql://` database, back it up with that database's supported procedure;
if you cannot, the backup is not a full recovery point.

#### Installations from before format version 2

A data directory whose `format.json` is missing or records `formatVersion` 1
(for example Telomi 0.0.1) keeps two parts of its state elsewhere. Back them up
as well before upgrading:

- **Long-term memory**: a pg0 instance named in `HINDSIGHT_API_DATABASE_URL`,
  or by default `telomi-<hash of the data directory>`, with its files under
  `~/.pg0/instances/<instance-name>`. Stop that specific instance before
  copying it; do not stop or copy every pg0 instance on the machine.
- **Browser login state**: `apps/telomi/.chrome-debug-profile`, after its
  Chrome process has stopped.

The first start of a newer version moves both into the data directory. When the
data directory is on another volume, it copies them and keeps the originals,
which you can delete once the checks below pass.

### Install the selected Release

From the existing checkout, after the backup and clean-working-tree check:

```bash
git fetch origin --tags
# Replace vX.Y.Z with the exact published Release you selected.
git switch --detach vX.Y.Z
npm ci
npm run setup
npm run build
```

`npm ci` installs the locked Node dependencies. Setup prepares the managed
Hindsight and Research Python environments and the Prime kernel. If local audio
is used, also run `npm run setup:audio` on its supported Apple Silicon macOS
host. Stop at the first failed step and keep its redacted error output.

Compare the new `.env.example` with your settings and the Release instructions.
Keep your existing `.env.local`, credentials, bank identity and data paths; do
not overwrite them with the example file. Dependency installation does not
prove a database migration is reversible.

The data directory records its format in `format.json` (`formatVersion` and
`installationId`). On startup, Telomi migrates an older format forward and logs
each step, and it records the new version only after that step succeeds. A data
directory from before format versioning is adopted as version 1 unchanged.
Startup refuses to run in two cases, and changes nothing when it refuses:

- The configured data directory does not exist. For example, its external
  volume is not mounted. Telomi creates only the checkout's default `data/`
  directory on its own.
- `formatVersion` is newer than the running code supports, which means a newer
  Telomi has already migrated the data.

### Verify before resuming normal work

Start with `npm run dev` (or your documented deployment command), then check:

- The application loads and existing Goals, reports and Wiki pages can be read.
- Configured model and source connections work without changing account identity.
- A small non-sensitive conversation and the relevant research/Wiki flow finish.
- Long-term memory and optional audio work when enabled.
- The running version matches the target and there are no persistent startup errors.

Keep the backup until these checks pass. A page loading or a successful build
alone does not establish that the upgrade preserved working data and integrations.

### Recover from a failed upgrade

Stop the new version and preserve its logs and modified data separately for
investigation. Compare `formatVersion` in the data directory's `format.json`
with the value recorded before the upgrade:

- **Unchanged**: the new version did not migrate the data directory, so
  restoring the previous code and its dependencies is enough.
- **Increased**: the old code will refuse to start against this data. Restore
  the complete recovery point as described below.

From format version 2, the data directory includes an embedded (pg0) memory
database. An external `postgresql://` database is outside it: restore that from
the same recovery point whenever the new version's release notes say that it
changed memory storage.

Restore **matching code, configuration, product data and memory database**
from the same pre-upgrade recovery point, using empty restore destinations rather
than overlaying old files onto the failed installation. Keep the recorded data
paths and bank identity. Reinstall the old version's locked dependencies and
managed environments, then repeat the verification above. PostgreSQL physical
backups require a compatible database runtime; use the database's supported
restore procedure rather than assuming any version can read its files.

Restoring a backup loses changes made after that backup. Export or retain those
changes separately before recovery. If no complete recovery point exists, stop
and request help with the old/new versions and redacted errors; changing only
the Git checkout is not a safe general rollback.
