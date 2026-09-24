# Branches and releases

English | [简体中文](releases.zh-CN.md)

Feature branch → dev → release acceptance → main → Tag / Release

## Branch responsibilities

| Branch | Origin and purpose | Merge target |
|---|---|---|
| `feat/*`, `fix/*`, `chore/*` | Branch from `dev` for one feature, fix or maintenance task | `dev` |
| `dev` | Daily integration and the repository's default branch | `main` after release acceptance |
| `main` | Stable code that has passed release acceptance | Tag formal releases |
| `hotfix/*` | Branch from `main` to fix a released version | `main`, then synchronize back to `dev` |

Feature branches can be committed and pushed continuously. Ordinary PRs target
`dev` and describe the problem, final behavior, validation and limitations.
Use merge commits by default to preserve ancestry; do not squash or rebase merges
between the long-lived branches.

## Release acceptance

1. Open a `dev → main` release PR with the intended version, compatibility changes
   and release scope.
2. Run the [local deterministic checks](testing.md#submission-checks), relevant
   [real E2E flows](e2e.md) and applicable [behavior validation](attestation.md)
   against the PR's current commit. Recheck when new commits affect the evidence.
3. Complete the installation and upgrade acceptance below; record source/target
   SHAs, platforms, results and limitations in the PR.
4. Merge into `main` after a maintainer confirms the evidence. Verify the merged
   file tree matches the validated version; otherwise rerun affected checks.
5. Create a version Tag, such as `v0.0.1`, at that exact `main` commit, then its
   GitHub Release. Record changes, upgrade requirements and known limitations,
   and publish the required artifacts.
6. Synchronize the merge back from `main` to `dev` to preserve their ancestry.
   Never move a published Tag; publish fixes as new patch versions.

Ordinary users use the latest formal Release; contributors use `dev`.

## Installation and upgrade acceptance

- First release: install, build and start from a clean checkout using the README,
  without maintainer configuration, existing data or shared virtual environments.
  Verify configuration and key user flows through the real UI. Record tested
  platforms; do not claim untested platforms as supported.
- Later releases: install the preceding formal version in an isolated environment,
  create a Goal, report, Wiki and long-term memory using non-sensitive samples,
  follow [backup and recovery](../upgrading.md), then upgrade to the candidate.
  Verify readable data, preserved credentials/configuration and working key flows.
  The Release must explicitly state whether older versions can upgrade directly.
- For data/configuration migrations, actually rehearse restoring the old version
  from its corresponding backup. Record recovery scope and possible loss of data
  created after the upgrade. Do not claim an untested path is reversible.
- Installation/upgrade checks are release acceptance, not a requirement to repeat
  for every documentation PR. Deterministic tests do not replace installation and
  real user-flow verification.

Each Release must state the exact version and commit, user-visible changes,
upgrade steps, configuration/data compatibility, backup and recovery requirements,
known limitations and tested platforms. The first release has no previous public
version to migrate from. Preserve continuous history afterwards; published Tags
remain fixed.

## Hotfixes

Branch `hotfix/*` from `main`, complete a PR and applicable acceptance checks,
merge back into `main`, and publish a patch Tag/Release. Then open a `main → dev`
synchronization PR so later releases retain the fix.

## GitHub repository settings

Maintainers configure these after creating the repository:

- Use `dev` as the default branch and ordinary PR target.
- Require PRs, [passing local checks](testing.md#submission-checks) and resolved review
  comments for `dev` and `main`; prohibit force pushes and deletion of these branches.
- While Actions is enabled, require the CI jobs `tests (1/3)`, `tests (2/3)`, `tests (3/3)` and
  `typecheck, build and contracts`; if Actions is disabled, require no status checks.
  Set the review count to match the actual maintainer team.
- Retain merge commits for the long-lived branch synchronization described above.

Remote settings are separate from repository files: a CI file does not enable
branch protection. Enforcement options for private repositories depend on the
GitHub plan.
