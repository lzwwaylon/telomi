# Contributing to Telomi

English | [简体中文](CONTRIBUTING.zh-CN.md)

Telomi uses feature branches, integration on `dev`, release acceptance, and publication from `main`. Create ordinary contribution branches from `dev` and open Pull Requests against `dev`.

## Issues and proposals

Use the Issue forms for reproducible bugs, installation/upgrade help, or public
feature proposals. Search existing Issues, merged PRs and the current code first.
Discuss substantial features or new integrations before implementation; small
fixes can go directly to a focused PR. Prioritize correctness, data preservation
and reliable installation over expanding the feature set.

Provide the affected version, environment, minimal reproduction and redacted
evidence. Never attach a data directory, credentials or private research.
Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
For upgrades, follow [backup and recovery](apps/telomi/docs/upgrading.md).

## Development setup

| Task | Read first |
|---|---|
| Install or start the product for the first time | [Installation](README.md#installation) |
| Configure services or credentials | [Environment configuration](apps/telomi/.env.example); keep credentials and runtime data out of Git |
| Understand domain terminology, responsibilities, and interfaces | The relevant sections of [CONTEXT.md](CONTEXT.md) and the [module index](apps/telomi/docs/modules/README.md) |

After completing installation, run `npm run dev` from the repository root for
server and frontend hot reload. Open <http://127.0.0.1:5174>; the development API
uses port 8787. Worktrees use their allocated ports instead.

## Development and validation

Choose validation according to the change. When several conditions apply, follow every applicable branch.

| Task | Read first |
|---|---|
| Write or run deterministic tests, or modify Hooks | [Deterministic testing](apps/telomi/docs/development/testing.md) |
| Modify a product Agent, Prompt, Skill, or Tool; add an Agent step or output contract | [Product Agent development](apps/telomi/docs/development/agent-authoring.md) and [behavior validation requirements](apps/telomi/docs/development/attestation.md) |
| Modify a user flow that can be triggered from the frontend | [Real E2E testing](apps/telomi/docs/development/e2e.md) |
| Modify a Source Provider, Provider Python SDK, Source Service, or Prime Search Provider Skill | [Provider validation](apps/telomi/docs/development/testing.md#provider-validation) and [behavior validation requirements](apps/telomi/docs/development/attestation.md) |
| Change module responsibilities, interfaces, permissions, or implicit constraints; modify project documentation | [Documentation requirements](apps/telomi/docs/development/documentation.md) |

Basic builds and deterministic checks do not require a maintainer's private configuration or evaluation environment. Validation involving real models, upstream services, or hardware is separate from basic CI. Contributors provide reproduction steps and expected behavior; maintainers complete the corresponding acceptance checks before merging.

## Worktrees

For parallel development, use the repository's isolated Worktree tooling. Ordinary checkouts also support normal development.

| Task | Read first |
|---|---|
| Create, initialize, or troubleshoot a Worktree environment | [Worktree setup](apps/telomi/docs/development/worktree-setup.md) |
| Start services or run checks in a Worktree | [Worktree commands](apps/telomi/docs/development/worktree-commands.md) |
| Stop or remove a Worktree | [Worktree cleanup](apps/telomi/docs/development/worktree-cleanup.md) |

## Before submitting a change

Complete the [submission checks](apps/telomi/docs/development/testing.md#submission-checks). Describe the problem, final behavior, validation results, and limitations in the PR. Keep each PR focused on one clear problem and avoid unrelated changes.

See [Branches and releases](apps/telomi/docs/development/releases.md) for the complete rules on PR targets, release acceptance, hotfixes, and Tags/Releases.
