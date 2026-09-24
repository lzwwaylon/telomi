# Worktree environment

Use this page when creating or initializing a Worktree, changing dependencies or diagnosing environment isolation. For the first installation in the main checkout, see [Installation](../../../../README.md#installation).

Use Python 3.11+, Node.js 24 and uv with the existing main checkout prepared.
The full local environment includes MLX Audio and requires Apple Silicon macOS. Create an environment-ready worktree from the repository root:

```bash
npm run worktree -- create ../telomi-feature --branch feat/example
cd ../telomi-feature
npm run worktree -- doctor
```

New Worktrees default to local `dev`; hotfixes may use `--base main`. Synchronize the relevant local branch before creating a Worktree. See [Branches and releases](releases.md) for the branch workflow.

For an existing worktree created with plain Git, run
`npm run worktree -- setup` before development. Setup is retryable; a failed
installation preserves the worktree. Re-run it after dependency manifests change.

Setup installs Node dependencies separately using the shared npm cache and binds
workspace packages to this checkout. agent-browser's install script is disabled in the root
`allowScripts`: it would retarget the global `agent-browser` command to whichever
checkout installed last. Its package wrapper makes the native binary executable on
first run. Research Python has its own editable install
using the shared uv cache. Compatible Hindsight/Audio virtual environments and the
Prime kernel can be symlinks to the main checkout. Compatibility is checked before
sharing; a changed lockfile/runtime detaches the link and installs locally. Treat
shared environments as fixed: change dependencies in manifests and re-run setup,
instead of running pip/uv installs directly inside a shared environment. Keep the
main checkout available while its environments are shared.

The initial `.env`, `.env.local`, account configuration and settings are private
copies; rerunning setup preserves local edits. Account configuration and settings
come from the main checkout's resolved agent directory by default. When the main
checkout runs against its own development data while logins live with an
installation elsewhere, set `TELOMI_CREDENTIALS_SOURCE` in the main checkout's
`.env.local` to that agent directory: every new Worktree copies credentials from
it, and setup only reads it. Setup fails if the path contains no credential files.
Goal data still arrives only through `seed`. `.env.worktree` contains managed
isolation overrides. It is loaded after the ordinary dotenv files by the shell,
server and Vite. API, frontend, Operations, Source Service, Audio and managed Chrome
ports are distinct, including LiveKit HTTP and RTC TCP/UDP ports; Vite fails rather than switching silently to another port.
Rerunning setup preserves allocated ports and adds any newly required service ports.
Data, writable credentials, traces and Audio jobs stay inside the worktree's own
data directory, and its own cache directory holds fetched material. Hindsight uses a
separately named pg0 database and bank whose files live in that data directory, so
removing the worktree removes them. Hugging Face downloads are shared by linking into
the main checkout's cache directory, never its data directory; `doctor` checks that
both directories belong to the worktree. Runtime
starts Chrome on the Worktree's own CDP port with a separate profile, so stopping
the main checkout's browser does not interrupt sibling Worktrees. Setup also writes a
private agent-browser config naming that port and points `AGENT_BROWSER_CONFIG` at
it, so the agent-browser CLI in the Worktree attaches to its own Chrome; `doctor`
checks that the config still matches. Profiles are
never linked or shared by multiple Chrome processes.

Setup serializes dependency installation and never launches an Agent or model.

`create` and `setup` install the deterministic pre-commit hook. For a worktree
whose hook is missing, install it explicitly:

```bash
cd apps/telomi && npm run install-hook
```

The hook checks staged formatting and rejects duplicated shared helpers and new
tests that import Providers or models; that part finishes in seconds. Commits
touching only documentation stop there. Otherwise it snapshots the staging area
and runs the checks selected by the staged paths through `npm run worktree -- check`:
tests affected by the change, or full type checking, the test suite and a build
when the change cannot be mapped to specific tests. The full case takes as long as
`npm run typecheck`, `npm test` and `npm run build` together, plus any wait while
another Worktree holds the heavy-check lock. Preview the selection without running
it from the repository root:

```bash
git diff --cached --name-status -z --diff-filter=ACDMRT | npx tsx apps/telomi/scripts/pre-commit-plan.ts --stdin0 --dry-run
```

Run the same checks explicitly with `npm run worktree -- check -- npm run typecheck`,
`-- npm test` or `-- npm run build`. See [Deterministic testing](testing.md#hook) for
the selection rules.

Once the environment is ready, use [Worktree commands](worktree-commands.md) for development commands and checks. Read the [cleanup rules](worktree-cleanup.md) before stopping or removing it.
