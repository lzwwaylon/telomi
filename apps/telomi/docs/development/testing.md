# Deterministic testing

Verify Runtime mechanisms, data contracts and deterministic logic with unit and integration tests. New tests must not call Providers or models directly; [pre-commit](../../hooks/pre-commit) rejects such commits. The allowlist and exceptions are defined in [pre-commit-plan.ts](../../scripts/pre-commit-plan.ts). Agent, Prompt, Skill and Tool changes also require [Attestation](attestation.md), and user flows accessible from the frontend require [real E2E verification](e2e.md).

## Choosing tests

- Assert observable behavior, data contracts or explicit architectural and security boundaries. Source-level checks need a corresponding constraint; do not remove them merely because they inspect source code.
- Enumerate and actually render templates. The current template count, internal version number, arbitrary file line counts and fixed Prompt wording are not quality criteria. Template variables, paths, permissions, output Schemas and version compatibility behavior still require checks.
- Control unrelated factors such as time, time zones and retry waits in test fixtures instead of depending on the current year or the author's machine. Tests of retry behavior must retain assertions about attempt counts and results. Test waits do not change production Runtime policy.

## Execution environment

Read [Worktree commands](worktree-commands.md) first when working in a Worktree. Run heavy checks through `npm run worktree -- check -- <command>`. The npm commands below are the checks to wrap, not an alternative to that entry point.

The deterministic npm test runner uses temporary product data and only inherits
OS/tooling settings and explicit `TELOMI_TEST_*` overrides. Product credentials,
service addresses and runtime overrides stay out of these tests.
Each test file gets its own data directory, arXiv SQLite path and dynamically
allocated Source Service port before imports;
forked children inherit that file's environment. The runner removes its temporary
data after the test processes finish, including failed runs.

## Test selection and prerequisites

`npm test` runs the app's deterministic TypeScript tests and the OpenAPI freshness
check. From `apps/telomi`, use `npm test -- "tests/wiki/test-*.{ts,tsx}"` for a
module or `npm test -- tests/wiki/test-wiki-tools.ts` for one file. New
`tests/**/test-*.ts` and `test-*.tsx` files are discovered automatically, as are
`scripts/test-*.ts`; no per-file npm script is needed. Tests run in isolated
processes with file concurrency defaulting to four. `TELOMI_TEST_CONCURRENCY` accepts
a positive safe integer; use `1` to diagnose ordering or resource conflicts.
Missing matches fail the command.

```bash
npm run worktree -- check -- env TELOMI_TEST_CONCURRENCY=4 npm test
```

This controls test files within one run; the cross-Worktree heavy-check lock still
serializes complete checks. Tests must allocate their own writable paths and use
dynamic service ports rather than depending on serial execution.

`--shard index/count` runs one slice of the matched files: after sorting, a file belongs
to the shard matching its position, so the shards of one count partition the list exactly
and a file changes shard only when the discovered list changes. CI uses this to split the
suite across jobs; `npm test` without the flag still runs everything, so local and
pre-commit behavior is unchanged. An empty shard is an error rather than a passing run.

Prerequisites and gotchas the scripts themselves do not state:

- Run `npm run setup` before the default suite. Its deterministic process tests need
  the research Python venv and the Prime kernel, and missing prerequisites fail rather
  than silently skipping coverage.
- Web and voice suites use the same file concurrency and preload `tests/web/setup-ui-locale.ts` (`zh-CN`)
  and `tests/web/setup-css-imports.ts` (CSS imports load as empty modules), which also
  covers every TSX test in the default suite. Their loader paths are absolute
  so forked tests can change cwd.
- The default glob excludes `*-live.ts`/`*-live.tsx`, provider `*-e2e.ts`/`*-e2e.tsx`, and
  the legacy `test-research-model-gateway.ts` (a real model call). Browser `.mjs` tests are
  outside the TypeScript glob. Deterministic replay/fixture tests whose names merely contain
  `live` or `e2e` stay included.
- Suites needing an external volume stay out of the default glob and require their own
  environment: `TELOMI_TEST_CROSS_VOLUME_ROOT` for the cross-volume sandbox tests.
- Python suites keep their own venv/PYTHONPATH commands and run separately.

## Provider validation

For changes to Source Providers, the Provider Python SDK, Source Service or Prime Search Provider Skills, run `npm run test:provider-contract` from `apps/telomi`. Verify real upstream Providers through [Attestation Case Replay](attestation.md).

`npm run test:provider-live` checks real upstream coverage and requires the relevant Provider credentials and services. It is not part of the default deterministic suite.

## Hook

The Hook runs only deterministic checks, such as type checking, builds, unit tests and Contract checks, selected by staged paths. LLM, Browser, Evolution, semantic evaluation and Judgment submission remain outside the Hook. See [Worktree environment](worktree-setup.md) for installation.

The Hook provides fast pre-commit feedback and does not replace full regression checks before merging:

- Ordinary documentation receives staged-format checks only and does not wait for the heavy-check lock. Prompts, Skills and other resources read at runtime do not qualify for this documentation skip.
- Test changes select the changed test and its importing consumers. Module changes select tests through reverse imports and affected modules. Old paths from deletions and renames also participate in selection. Changes to shared infrastructure, configuration, dependencies or resources that cannot be mapped reliably fall back to full type checking, tests and builds.
- Type checking uses TypeScript's native incremental cache while still checking project dependencies. Separate checks for Provider Python, Audio and OpenAPI remain. The cross-Worktree heavy-check lock is acquired only when these checks need to run.

Heavy checks run in an isolated snapshot of the staging area, reuse locally installed dependencies and point Workspace packages at the snapshot. They do not rewrite the development directory through stash. With partial staging, unstaged fixes cannot hide errors in the commit. If staged dependency declarations differ from the working directory, align the dependency files and reinstall first. In shared Python environments, if source staged for deletion still exists in the development directory, align the deletions first so editable installs cannot fall back to loading old code. The Hook's type cache lives in each Worktree's Git directory; manual type-check caches remain local and are not committed.

The selector conservatively handles dynamic loading but cannot prove every runtime file dependency, so a change to a shared entry point may still select many tests. The full checks in [Submission checks](#submission-checks) remain required for complete regression coverage.

## Submission checks

Run local deterministic checks before committing. Remote settings determine whether GitHub Actions is enabled and whether Workflows are merge requirements. Pre-commit automatically selects checks based on staged paths. Record the verified commit, commands and results in the PR. Recheck after any new commit that affects the validation result.

The public [CI Workflow](../../../../.github/workflows/ci.yml) runs deterministic checks on Linux.
The TypeScript suite is split with `--shard` across parallel jobs, and one more job runs type checking,
the build, the OpenAPI freshness check and the separate suites for the writing scanner, Provider Python SDK,
Research Source API and sandbox extension; every job is required. Each job prepares the environment
through the shared `.github/actions/prepare` action, which restores `npm ci` output and the Prime kernel
from caches keyed on the lockfiles and runner platform and installs them on a miss. The Hindsight and
Research Python environments are installed with uv on every run because their Linux lockfiles resolve
CUDA torch, several gigabytes that do not fit the repository cache quota.
The Workflow neither reads private maintainer configuration nor calls real models or runs acceptance checks
requiring authorized accounts, browser logins or audio hardware. The presence of the Workflow file
does not mean it is enabled remotely or that a Linux run has passed.

Complete the verification required for your change, then run from the repository root:

```bash
npm run typecheck
npm test
npm run build
```

In a Worktree, wrap each command as required by this page's execution environment section. Keep credentials, Browser Profiles, generated artifacts and Runtime data out of Git.

## Optional speech fixtures

Real speech tests require generated audio, which is not stored in Git. From
`apps/telomi`, explicitly download the pinned sources and generate the fixtures:

```bash
npm run generate:voice-vad-fixtures -- --fetch-remote-fixtures
```

The generator validates source hashes and reports generated output hashes. It does not run a model.
Generate the separate public-acoustic fixture set only when that evaluation
requires it, using `npm run generate:voice-public-acoustic-fixtures -- --fetch-remote-fixtures`.
Keep generated audio and downloaded source caches out of Git. Running the live
tests still requires a configured speech service; generating fixtures is not
a speech-quality acceptance check.
