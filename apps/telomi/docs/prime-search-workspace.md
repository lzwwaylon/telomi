# Prime Search workspace contract

Prime Search uses native Python and SRT on the local host. This is filesystem access control with workspace-relative paths, not a virtual filesystem: `os.getcwd()`, Python package metadata and native session handles may still contain host paths. Venv variables and command-string substitution are not security boundaries.

## Execution directories

The Root kernel starts in the Run's `agent/` directory. A Provider child starts in `agent/provider-executions/<native-child-id>/`. The host Tools, kernel launcher and child Case capture use the same workspace provisioning function. Invalid child identities and substituted workspace directory symlinks fail before host Tools write into them.

Each Provider workspace contains:

- `work/`: the child's Ledger and retained material.
- `skills/`: an entry point to this Run's staged, read-only Skill set.
- `.prime-kernel/`: that child's scratch and temporary home.

The staged Skill set remains the Run's selected Provider and Root Skills, as in native Prime resource inheritance. This change does not introduce Provider-specific Skill admission or infer permissions from child prompt text.

The Root reads submission receipts at `provider-executions/<native-child-id>/work/.provider-assignment`, relative to its initial working directory. The native `session_dir` retains its session-storage meaning and must not be used to derive Provider output locations. Native RLM delegation, messages and `waitForRlmQuiescence()` remain unchanged.

## Skills and permissions

The SDK worker runs with the Root workspace as its process cwd. Its Resource Loader publishes relative `filePath` and `baseDir` values under `skills/`; native SDK file reads still resolve there. Python installation metadata retains the host package path for native preparation. Child kernels have the same relative Skill entry point. Skill references resolve from the directory containing `SKILL.md`.

SRT reads are allowed by default. Kernel policy therefore denies the configured Telomi data root as well as private Runtime directories, then opens the execution workspace and required runtime dependencies. Provider children additionally deny the Root tree and reopen only their own execution and the staged Skills. They do not inherit the Root's readable workspace or writable scratch. Staged Skills are explicitly denied writes, including writes through the child's Skill link. Host Tools derive their destination from the native calling session.

Linked venv directories are canonicalized before constructing the executable path and sandbox policy. The interpreter executable itself is not resolved through `bin/python`, which would lose virtual-environment selection.

## Case capture and verification

Each child application-workspace snapshot is taken on its first running event. It captures that child's files and explicitly materializes the shared Skill tree at `workspace/skills`; it excludes ephemeral `.prime-kernel` data and does not include sibling executions or Root work files. `/workspace` in snapshot metadata names the exported tree, not an absolute live Python path.

`npm test -- tests/agent-runtime/test-prime-workspace.ts` uses real sandboxed Python, subprocesses and the installed Prime Resource Loader without model or Provider calls. It checks relative I/O, Python Skill imports, linked venvs, read-only Skills, parent/sibling/private-data access denial, symlink escape rejection and child snapshot contents. `TELOMI_TEST_WORKSPACE_PARENT` can place its disposable fixtures on the same volume used by production data.

Live Replay keeps the explicit file-ingest Interface available for Browser material conversion. Eval startup does not resume persisted ingestion jobs; new requests can enqueue and convert their own material. Disabling both the background recovery and the HTTP Interface would make `research_runtime.materialize_source` fail after browsing succeeds.
