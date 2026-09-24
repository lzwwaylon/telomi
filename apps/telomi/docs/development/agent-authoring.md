# Product Agent development

Before changing an Agent, Prompt, Skill or Tool, or introducing an Agent stage, Tool type or output contract, identify the historical Cases and verification path required for [Attestation](attestation.md).

## Bundles and responsibilities

Agent Bundles centrally manage `agent.yaml`, Prompts and Skills under `apps/telomi/agents/`. Read the [Bundle contract](../../agents/README.md) when changing registration or templates; read [Agent Execution](../modules/agent-execution.md) when changing Pi/Prime entry points, delegation or isolation. When adding an Agent definition or changing responsibilities, interfaces, permissions, terminal actions or implicit constraints, update documentation according to the [maintenance triggers](documentation.md#maintenance-triggers).

These constraints apply to Agents running inside the product. Development tools used by maintainers are outside the product runtime contract.

## Prompt optimization at the meta level

- Before editing, identify the task class, stable constraints and root cause. Write meta-level rules that apply to unseen inputs of the same class.
- Prompts describe general responsibilities, decision principles, available context and Tools, output contracts and failure recovery. Supply task-specific data through the User Prompt, a Fragment or execution context.
- Before committing, check each new rule against another input of the same class. If it does not hold, find a more general rule or correct the input, Tool, contract or Runtime mechanism.

## Output language

See [Localization](../modules/localization.md#goal-output-language) for supported values and resolution timing. This section defines how Agent stages receive the language.

- Write Prompts, Skills, references and Tool descriptions in English. Maintain one version of each; do not duplicate files or directories by language.
- Inject the output language into a stage only if its output contract contains fields that reach the user, regardless of the stage's name. Do not inject it into stages that produce only evidence, audit material or Runtime-internal data. The evidence layer preserves the Source's original language.
- Resolve the output language once in code and pass it as a structured field: `outputLanguage` on the Run and `language` in the Stage input file. Template variables and Runtime switches read this field, never the rendered Prompt text.
- There are two exceptions. Main Agent responds turn by turn and, when the preference is `auto`, follows the user's current message. Main Agent writes the report language into Report Context based on the conversation and user preferences; this takes precedence over the code-resolved default. The code-resolved value applies only when Report Context does not specify a language. It also controls Runtime switches, such as Chinese prose lint, so a mismatch can make those switches disagree with the report's actual language.

## Skill optimization at the meta level

- A Skill describes a reusable method for a class of capabilities. A Provider-specific or domain-specific Skill covers a class of tasks for that Provider or domain.
- `SKILL.md` states triggers, general steps, boundaries and verification. Move deterministic operations that will be repeated into scripts.
- After changing a Skill, use Attestation to verify the original problem and representative Cases of the same class through real executions, checking for overfitting.
