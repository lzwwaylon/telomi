# Skill Management

## Purpose

Skill Management provides shared file-based Skill management for Main Agent, Research, Wiki, and Podcast. It preserves Pi's native Skill Loader and Workspace communication, unifying only deterministic discovery, validation, versioning, and materialization.

## Interface

Callers use the interface in `server/agent-runtime/skill-registry.ts`:

- `bundledAgentSkillPath(domain, agentId, skillName)`: resolves a Skill within an Agent Bundle.
- `bundledAgentSkillPaths(domain, agentId)`: reads the corresponding `agent.yaml.skills`, validates, and resolves server-bundled Skill paths.
- `snapshotSkills(paths, options)`: discovers Skills, validates `SKILL.md`, rejects symbolic links, and hashes complete directories including scripts and references.
- `materializeSkills(snapshot, targetRoot)`: rechecks source hashes, copies to the execution directory, rechecks target hashes, and writes `.skill-snapshot.json`.

An input path may identify one Skill or a directory containing multiple Skills. Multiple directories merge in order; a later Skill with the same name may override an earlier one only when `allowOverrides` is explicitly enabled.

## Current usage

- Each server Agent keeps its `agent.yaml`, `prompts/`, and `skills/` in `agents/<domain>/<agent-id>/`.
- Plain names in `agent.yaml.skills` resolve within the current Bundle. A few shared Skills explicitly reference the sole copy in another Bundle through `<agent-id>/<skill-name>`.
- On every Turn, Main Agent merges server-bundled Skills declared by `main/router` with Goal `skills/main-agent`, then materializes them in that Turn's sandbox.
- At Research startup, Skills declared by each Agent Bundle are content-hashed and materialized in the Run Control Directory.
- Prime Search Providers declare server-bundled Skills through `workerSkills` in the Provider Catalog. The Coordinator body is also declared by `agent.yaml`; Runtime generates only the current Provider Catalog and execution contract in `references/current-run.md`.
- Server-bundled Skills for Prime Report, Wiki Shard, Wiki Curator, and Podcast are materialized through the same module.
- Runtime writes generated `references/API.md` into materialized Provider Skills, so the materialized directory's hash is not the Skill identity. Startup conditions record the source hash verified during materialization through `materializedSkillIdentity` and reject Skills whose source files changed after materialization.
- Agents and RLM children continue to read materialized directories through Pi's native filesystem and Skill Loader.

## Responsibility boundaries

- Skill Management does not decide when to use Skills, generate semantic content, or change Root-child delegation.
- An Agent Bundle's `agent.yaml` owns Prompts, permissions, and fixed Skill membership. Skill Management owns stable procedures, scripts, references, and file contracts.
- Skill Management does not trigger or review evolution. A separate Runtime flow triggers, validates, and applies Goal-scoped candidate Skills through [Browser Skill Evolution](../evolution-module-design.md). Humans and development Agents may also edit Goal Skills. Subsequent executions read the new version by its complete directory hash.
