# Telomi Agent Bundles

Every server-owned Agent is registered from one bundle. Keep its configuration, Prompt templates, and Skills together instead of editing separate global Prompt and Skill trees.

## Layout

```text
agents/
  <domain>/
    <agent-id>/
      agent.yaml
      prompts/
        system.md.njk
        system-append.*.md.njk
        instructions.md.njk
        user*.md.njk
        reference.*.md.njk
        tool.*.md.njk
      skills/
        <skill-name>/
          SKILL.md
```

The supported domains are `main`, `research`, `wiki`, and `evolution`. An Agent may omit the system Prompt, user Prompt variants, or `skills/` when it does not need them.

Extension-owned Agents remain inside their extension packages so extensions can be installed and maintained independently.

## Agent config

`agent.yaml` is the bundle registration entry:

```yaml
schema_version: 2
id: example-agent
skills: [example-skill]
prompts:
  system-append:
    default: system.md.njk
  reference:
    child-contract: reference.child-contract.md.njk
  user:
    default: user.md.njk
    repair: user.repair.md.njk
sandbox:
  role: report.example
  execution_profile: bash_only
  network: allow
  tools: [bash, submit_stage_output]
```

Prompt filenames are resolved only inside the bundle's `prompts/` directory. Every kind maps named variants to templates:

| Kind | Delivery |
|---|---|
| `system` | Complete project-owned system Prompt used as a replacement or composed with `main/global-base` |
| `system-append` | Appended to an existing system Prompt, including Prime's native system Prompt |
| `instructions` | SDK-specific Agent instructions, such as LiveKit `Agent.instructions` |
| `user` | Initial, follow-up, repair, or internal-event user message |
| `reference` | Materialized context or Skill reference read by the Agent |
| `tool` | Tool description, Tool result, or validation message exposed to the Agent |

Unqualified Skill names are resolved only inside the same bundle's `skills/` directory.

A shared Skill may be referenced as `<agent-id>/<skill-name>`. Keep this exceptional and explicit so one canonical Skill can support closely related Agents without copying its implementation.

`execution_profile` is optional. When `sandbox` is present, `network` and `tools` are executable allowlists used by SRT and replay runtimes. Direct utility and Prime runtimes omit `sandbox` because their dedicated runtime owns execution policy.

## Global system Prompt

`main/global-base/prompts/system.md.njk` is the project-owned base system Prompt. SRT Runtime concatenates it before each Agent-specific `system` Prompt and passes the combined text to Pi as a replacement system Prompt.

Prime Agents retain Prime's native system Prompt and receive their registered `system-append` template through `appendSystemPrompt`. The native third-party Prompt is not copied into this repository. The registration records only project-owned content.

## Templates

Templates use Nunjucks syntax:

```jinja2
Current date: {{ current_date }}
{% if repair_reason %}
Repair reason: {{ repair_reason }}
{% endif %}
```

The Registry rejects path traversal, unknown config fields, missing variables, empty rendered Prompts, undeclared Prompt variants, and missing Skills. Templates are trusted repository assets and must never contain user-supplied Nunjucks source.

Run the Registry checks after editing a bundle:

```bash
npm run test:agent-registry
```
