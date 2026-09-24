# Worktree commands

Use the unified entry point to start services, run development commands and execute checks in a Worktree. If the environment is not initialized or dependencies have changed, complete [Worktree environment setup](worktree-setup.md) first.

```bash
npm run worktree -- run -- npm run dev
npm run worktree -- doctor --live
npm run worktree -- check -- npm test
npm run worktree -- check -- npm run typecheck
```

`npm run dev`, `npm start` and each service's npm development entry points automatically join the same process management through `launch`. Uninitialized Worktrees refuse to start. Nested npm commands reuse their owning process group without consuming additional slots. Worktree-local environment files override inherited variables with the same names, preventing a parent terminal from injecting another branch's ports or data directories.

`run` allows at most three concurrent commands across Worktrees in the same repository; a fourth command is rejected. `check` serializes heavy checks through an operating-system file lock, which the normal pre-commit Hook also uses. Commands retain the caller's working directory and standard input. Running Node/Python programs directly, bypassing npm entry points, does not automatically register process ownership.

To restart the current Worktree, run `npm run worktree -- stop` and wait for it to succeed before starting services. It stops every managed command in the current Worktree, including checks and Coding Agents. To restart only the foreground development service, press Ctrl-C in its terminal and restart it there. When a port is occupied, identify its owning instance; do not kill processes in bulk by port or process name.

`browser:start`, `browser:status` and `browser:stop` use the current Worktree's CDP configuration. The browser stop command only acts on a browser recorded by this checkout whose process arguments match both the port and Profile path. Specifying another port does not grant permission to close that browser.

`doctor` checks local import resolution and pinned Runtime dependencies. `--live` also checks the running product and frontend endpoints, and reports whether the managed browser is running (it starts on first use and stops when idle, so not running is normal). Actual Provider authorization, audio hardware and model behavior still require their own real verification.

Read [Deterministic testing](testing.md) when writing or selecting tests, and [Real E2E verification](e2e.md) when verifying user flows.
