# Upgrade, backup and recovery

English | [简体中文](upgrading.zh-CN.md)

Use a published Release for an ordinary installation. `dev` is for contributors.
This guide describes manual upgrades; Telomi does not provide a one-click updater
or a universal database downgrade command. Follow any additional instructions in
the target Release before changing an existing installation.

## Before changing code

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

## What to back up

| State | Location and constraint |
|---|---|
| Goals, research, Wiki, reports, settings, runtime databases and project credentials | The **entire resolved `TELOMI_DATA_DIR`**, default `apps/telomi/data`. Include hidden files and SQLite sidecar files. Use the actual running configuration, including `.env.worktree` where applicable. |
| Environment and custom locations | `.env`, `.env.local`, `.env.worktree` if used, and any external credential, storage or database paths configured by the installation. Record their locations without publishing their values. |
| Long-term memory | Hindsight has a **separate PostgreSQL database**, by default a local pg0 instance named `telomi-<hash of the data directory>` unless `HINDSIGHT_API_DATABASE_URL` is set, and bank identity `HINDSIGHT_BANK_ID`. Copying `TELOMI_DATA_DIR` does not include this database. Preserve the bank identity. |
| Browser login state | The managed Chrome Profile, normally `apps/telomi/.chrome-debug-profile`, after its Chrome process has stopped. It contains cookies. External browser profiles are managed separately. |

For a local pg0 database, identify the instance named in your database URL.
Default instance metadata lives under `~/.pg0/instances/<instance-name>`; a
Worktree uses its own instance name. Stop that specific PostgreSQL instance
before making a filesystem backup, and include its actual data directory if it
is configured elsewhere. Do not stop or copy every pg0 instance on the machine.
For an externally managed PostgreSQL/Hindsight service, use its supported
backup and restore procedure and coordinate with its operator. If you cannot
back up the memory database, the backup is incomplete; do not treat it as a
full recovery point.

Dependencies and model download caches can be reinstalled. They are not a
substitute for the data and database backups above.

## Install the selected Release

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

## Verify before resuming normal work

Start with `npm run dev` (or your documented deployment command), then check:

- The application loads and existing Goals, reports and Wiki pages can be read.
- Configured model and source connections work without changing account identity.
- A small non-sensitive conversation and the relevant research/Wiki flow finish.
- Long-term memory and optional audio work when enabled.
- The running version matches the target and there are no persistent startup errors.

Keep the backup until these checks pass. A page loading or a successful build
alone does not establish that the upgrade preserved working data and integrations.

## Recover from a failed upgrade

Stop the new version and preserve its logs and modified data separately for
investigation. Compare `formatVersion` in the data directory's `format.json`
with the value recorded before the upgrade:

- **Unchanged**: the new version did not migrate the data directory, so
  restoring the previous code and its dependencies is enough.
- **Increased**: the old code will refuse to start against this data. Restore
  the complete recovery point as described below.

The format version covers the data directory only. Restore the Hindsight
database from the same recovery point whenever the new version's release notes
say that it changed memory storage.

Restore **matching code, configuration, product data and Hindsight database**
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
