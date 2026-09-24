# Module Documentation Index

When changing module responsibilities or interfaces, read the relevant documents below; for changes spanning modules, read each module's contract. Changes to a module or Agent's responsibilities, interfaces, permissions, terminal actions, or implicit constraints require corresponding documentation updates under the [documentation maintenance rules](../development/documentation.md#maintenance-triggers).

## Agent modules

| Module | Read when changing | Documentation |
|---|---|---|
| Project Structure | Directories, module boundaries, and naming constraints | [Project Structure](project-structure.md) |
| Main Agent | Goal conversation entry and selection of a single terminal action | [Main Agent](main-agent.md) |
| Agent Execution | Shared Prompt loading, sandbox creation, Agent Stage execution, output validation and publication | [Agent Execution](agent-execution.md) |
| Skill Management | Shared discovery, validation, hashing, and materialization of Agent Skills | [Skill Management](skill-management.md) |
| Research Agents | Search, evidence selection, and report generation | [Research Agents](research-agents.md) |
| Workspace Knowledge Pinning | Pinning the Goal Knowledge used by Research | [Workspace Knowledge Pinning](workspace-knowledge-runtime.md) |
| Utility Agents | Model connectivity, voice cleanup, podcast generation, and voice entry | [Utility Agents](utility-agents.md) |
| Localization | Independent contracts for UI language, Goal output language, and voice language | [Localization](localization.md) |
| Wiki Shard Builder | Curating candidate Entities and Concepts per Source batch | [Wiki Shard Builder](wiki-shard-builder.md) |
| Evolution | Triggers, inner loop, and automatic application of Goal-scoped Browser Skill evolution | [Evolution Module](../evolution-module-design.md) |

## Runtime modules

| Module | Read when changing | Documentation |
|---|---|---|
| Media Playback | Global audio playback, bottom bar and expanded player, transcripts, and resume | [Media Playback](media-playback.md) |
| Audio | STT/TTS protocol dispatch, endpoint extensions, model and voice defaults, managed telomi-audio and its contract | [Audio](audio.md) |
| Voice | Push-to-talk, live preview, live voice conversations, recognition configuration, and voice history | [Voice](voice.md) |

## Agent definitions

Use `git ls-files '*/agent.yaml'` for the current inventory. An `agent.yaml` defines Prompts and permissions; it does not necessarily represent a separately scheduled, long-running Agent. Shared Prompt layers and structured-output repairers use the same registry.

The table below records only ownership relationships that are not apparent from the code:

| Agent ID | Owner |
|---|---|
| `main/global-base`, `main/stage-runtime` | Agent Execution's shared Prompt layer and Stage instructions |
| `main/router` | Main Agent |
| `main/model-connectivity-test`, `main/voice-cleanup`, `main/voice-livekit` | Utility Agents |
| `main/podcast-writer` | Prime Podcast Root |
| `research/prime-search` | Prime Search and Source Organizer |
| `research/cornell-note`, `research/report-writer`, `research/find-out-report-writer`, `research/schedule-reviewer` | Research Agents |
| `wiki/wiki-shard-builder`, `wiki/wiki-curator` | Respective Wiki Roots |
| `evolution/browser-skill-evolution` | [Evolution Module](../evolution-module-design.md) |
