# Agent Execution

## Purpose

Agent Execution provides shared deterministic execution mechanisms for business Agents. Business modules supply semantic Prompts, input views, and output validation; the execution layer owns permissions, models, sessions, execution records, and immutable artifacts.

## Interface

Structured Agents execute through `AgentStageRunner.runStage(request)`. The production adapter is `SrtStageRuntime`.

Agent Bundle callers use the registry through:

- `loadAgentPromptConfig(domain, id)`: reads the Agent's Prompt and permission declarations.
- `renderAgentPrompt(domain, id, kind, variables, variant)`: renders a trusted Nunjucks template and returns its content and hash.

`kind` explicitly records Prompt delivery semantics: `system`, `system-append`, `instructions`, `user`, `reference`, and `tool`. Every kind uses the same `kind -> variant -> template` interface. Prime supplies its native system Prompt; project-owned additions are registered as `system-append`.

## Main capabilities

- Discover Bundles under `agents/<domain>/<agent-id>/` and validate Agent IDs, Prompt paths, Skill references, template variables, and `agent.yaml` fields.
- Combine global system Prompts, business Prompts, tool descriptions, and fixed output constraints into the final system Prompt.
- Create SRT sandboxes from Agent permissions, restricting network access, tools, mounts, and file access.
- Resolve the Provider, model, reasoning, token, and retry behavior from model policy.
- Support fresh, continue, and session fallback Stage session outcomes.
- Validate Agent results through fixed output paths and `submit_stage_output`.
- Publish immutable files or directories after validation, recording sessions, usage, tool calls, Trace, and the Node Execution Record.
- Accept parallel fan-out group identities declared by callers in Stage requests. The execution layer does not infer groups from records present at startup. Members of one fan-out share the dependencies recorded by its first member, so staggered starts, retries, and recovery do not change group membership.

## Responsibility boundaries

- The execution layer does not interpret search quality, report content, memory meaning, or evolution proposals.
- Each business module owns its input construction and output Schema.
- `app.ts` injects `GoalExecution` into `GoalService`: Main Agent session initialization, Research Run tool invocation, and Research Run and Wiki Update recovery entry points. The composition layer binds podcast dispatch to the session; Goals depend only on the `GoalSession` contract. Research Run liveness is read only from Runtime's `run-state.json`, without separate startup, scheduled-research, or recovery Sets in Goals. Main Agent sessions still prevent duplicate starts through their own synchronous `isRunning()` and initialization Promise.
- Runtime may reject, retry, recover, and publish, but cannot generate semantic results on an Agent's behalf.
- Tool and network fields in `agent.yaml` are execution allowlists, not descriptive text.
- Investigation freezes the Wiki edition, or the empty knowledge state before its first publication, for the turn and exposes Goal knowledge, Deep Search and permission-checked generic acquisition calls to Prime. Generic acquisition reuses Prime Search's Provider discovery, native child execution and Source publication; Cornell then verifies the new material. Prime delegates answer organization through `write_answer` to the existing Report Writer's answer variant. Runtime freezes the assigned evidence, validates citation and coverage structure, and requires the Root to deliver the Writer's answer, citations and gaps verbatim. Main reviews the result, then delivers its saved answer verbatim or investigates a gap. Deep Search Cues remain outside the Wiki until a separate Wiki publication path handles them.
- Contract ownership: Research owns Research Run state and recovery (`server/research/run-state.ts`). Neither Research nor Wiki owns the Cornell Evidence Corpus contract (`server/cornell/contracts.ts`); both import it directly. The execution layer supplies only the Schema validation entry point.

## Pi and Prime execution boundaries

- Extend Pi Coding Agent through Pi Extensions, leaving the underlying framework unchanged. Pi Extensions serve only Pi Coding Agent; product workflows and business orchestration remain in Telomi modules.
- Prime Agents use native Prime delegation and interaction: Prime Roots, RLM children, the autonomous loop, and file-based Skills loaded through the native filesystem and Skill Loader. `telomi-srt` isolates only the Kernel that executes model-generated code.
- Runtime's scope over Prime is permission control, sandbox and credential isolation, Workspace mounts, cancellation, deterministic output validation, and persistence. Prime determines the delegation topology, and native interactions retain their native form.
- Pi and Prime sandbox reads are denied by default. Business data access is granted through the current execution's Workspace and read-only inputs; essential system tools and libraries receive separate read-only access. Real host path names may be visible: logical path mapping is not path hiding. See [Telomi SRT](../../../extensions/telomi-srt/README.md) for the precise boundary.
- All production Prime Agents use the Prime SDK with Auto Refine and the autonomous gate disabled. New Prime entry points must use the existing launcher to write an isolated Agent Directory. `test:prime-agent-auto-refine` enumerates all entry points and fails if one bypasses the launcher; its assertions define the mechanism. This restriction prevents only automatic Harness modification. Prime's native Root, RLM child, and autonomous loop interactions remain unchanged.
- The pinned Prime release ships a fixed model list and keeps a Codex model for RLM delegation only when its outdated discovery lists it. Every model the settings offer comes from pi's catalog, so each execution's model definitions also carry the catalog models of Providers Prime supports that its list lacks, marked `telomiCatalogModels`; they are frozen with a Run, excluded from the connection affinity check, sign in through the Provider's own credential, and stay available for delegation while that Provider is signed in. Remove this once the pinned Prime fetches its catalog itself.
- Prime SDK flows that delegate RLM children use native `session.waitForRlmQuiescence()` to wait for RLM descendants and the parent-session continuation rounds they trigger. Cornell Note, which has no RLM children, does not need this call.
- Each investigation `write_answer` call executes one independent, fresh Writer Session through the existing Stage Runner and Prime launcher, with RLM depth zero and only IPython. Its project system Prompt appends to Prime's native system Prompt. The Writer can read its frozen inputs and bundled writing-skill, and writes the fixed answer artifact in its own workspace. Acquisition and supplementary reading remain coordinated by the investigation Root. The common Stage Capture records this Session separately from the Root, including its original evidence inputs, validated output and retained native Trace.
- Investigation Readers receive the original question and currently registered Cue navigation in `source/reader-context.json`, alongside the existing read-only Source catalog. Runtime maps and checks prior anchors against current Source identities, revisions and line bytes, marking changed or unresolved anchors for rechecking. The Reader targets the missing detail and cites original Source lines; Prime merges the relevant restored, local and newly acquired refs before assigning Writer coverage. Complete handoff objects stay in Python variables, with bounded relevant projections for model inspection.
- Investigation threads have durable Goal-scoped identities separate from invocation/execution IDs. Main explicitly supplies a returned thread ID to continue; omission creates a new thread. Each invocation still starts a fresh Prime Session and Kernel, restoring bounded semantic progress, historical answer file references and verified prior Cues through read-only inputs. Runtime assigns fresh short references for this invocation; historical C/N aliases are task data only. Prime writes optional bounded progress separately from the unchanged Writer answer. Reader and Writer remain fresh independent tasks. Same-thread execution is protected by a filesystem lock; completed artifacts are integrity-checked and reused on interrupted publication retries.
- The recent investigation catalog contains at most five bounded entries. Its complete index, progress, execution records, native traces and published results remain durable; a recent-list limit never deletes history. Workers and Kernels exit after their task and sandbox temporary resources follow the existing launcher cleanup. Native Prime Session continuation and warm-session eviction are not implemented by this thread mechanism.
- Investigation operations publish complete results under the Root's read-only `inputs/handoff/` directory and return only operation, file reference, hash and byte length. The Python SDK verifies a receipt before loading its file into a variable; the Agent chooses which parts to inspect. The Root submits only `answer_ref`, naming the latest Writer path or its complete receipt. Runtime resolves a path through its registered latest Writer receipt, checks the exact artifact identity and bytes, and verifies the Writer's public fields before citation compilation. The full question is supplied through `inputs/request.json`. Main receives its own stable artifact receipt and can read the result through its native file tools.
- Prime's `session.prompt()` resolves normally when the model call fails; the failure is only the latest assistant message's error. A Worker checks it after each prompt and RLM wait (`assertPrimeModelAnswered()` is the shared check), so a Stage ends with the model error the user must act on (for example an exhausted balance) instead of the missing output file that error caused, and does not spend repair prompts on it. An answered model that skipped its file still fails the output contract. Subscribers see every attempt, including ones Prime's auto-retry then recovers from and drops from the session, so a Worker judges the latest answer and never keeps an error it saw on an earlier attempt.
- A model error a Worker ends on reads `model '<provider>/<model>' failed: <error>`. The launcher parses that form out of every Worker failure and records the Provider's verdict on the model; a verdict that needs the user (a refused credential, an exhausted balance, a model the Provider does not serve) becomes a capability alert in the inbox, which links to the settings page that fixes it. Search Root errors and failed RLM children report the same way. A Worker that reworded the error would leave the user without that alert.
- Prime Roots, RLM children, and multiple Prime Agents communicate through a shared Workspace and the framework's native filesystem, reading and writing tasks, results, and state under explicit directory and file contracts. Runtime provides Workspace mapping, isolation, and persistence.

On Linux, managed Prime kernel setup resolves the interpreter symlink's target to its canonical path while retaining the venv entry point and site-packages. Explicit interpreter overrides are left untouched. This avoids relying on installation aliases hidden by the sparse read-deny mounts.

Linux kernel liveness checks remain within their PID namespaces: the SRT launcher monitors the SDK owner's host PID, while the native Python kernel monitors its parent inside the sandbox. Owner death terminates the kernel without relaxing process isolation.

The Linux runner restores only previously emitted write grants overwritten by a later read-only ancestor mount. It keeps subsequent deny masks in place and declines restoration when explicit denies or earlier restrictive child mounts overlap. Unrecognized wrapper forms fail closed rather than running outside the sandbox.

## Trace presentation boundaries

Activities display reasoning, output, and tool calls from native Agent sessions. Child lifecycle logs describe only state and cannot replace sessions. Executions containing multiple Sessions associate Root and child Agents through a Runtime-maintained session index that is readable during execution and continues to use retained sessions after termination. The index references only the owning Goal's server-side execution tree; it does not change Agent file permissions or the existing storage layout. Every Reporter execution uses its own identity and Trace directory. Recovery reuses completed sections without mixing sessions from the previous execution.

## Storage layout

The four Storage Zones in the [domain model](../../../../CONTEXT.md#storage-model) describe lifetimes and write authority; they do not require a single physical directory tree per Zone. Keep the following existing layout without migration, renaming, or dual writes:

| Path and resolver | Purpose and permissions |
| --- | --- |
| `<dataDir>/<goalId>/wiki/`, Goal and Wiki layout helpers | Goal Wiki, the currently published knowledge product. |
| `<dataDir>/.pi/runtime/harness/<goalId>/`, `serverRuntimeDirForGoal()` or `serverRuntimeDirForGoalDir()` | Server-owned execution tree containing Run control records, Trace, indexes, publication locks, Research Schedules, and Wiki Update records. Runtime Control Store records must not be shared as writable Agent directories. |
| Immutable artifacts and private execution directories within that tree, specified by Stage requests and `PublishedArtifactStore` | Published Artifact Store and Worker Workspace respectively. Sharing the execution tree does not change isolation boundaries: Runtime publishes only after validation, and Agents write only to their own Worker Workspace. |
| `<dataDir>/<goalId>/.pi/runtime/`, `runtimeRoot()` and `runtimeStateDir()`, `runtimeRunsDir()`, `runtimeCacheDir()` | Goal-local Runtime Control Store: durable state, execution records, and caches for Ingestion, Media, and daemons. It is neither a second Research harness nor a disposable temporary Worker Workspace. |
| `<dataDir>/.pi/runtime/`, `runtimeControlRoot()` | Cross-Goal control data such as Activity logs, temporary Evaluation Bundle directories, the Prompt Registry, Provider caches, Python Skill environments, and Goal deletion recovery records. |

Voice control data remains at `<dataDir>/.pi/voice/`, resolved by `voiceDataRoot(dataDir)`. Development hardware evaluation and fixture entry points pass the original application root and retain their existing `<appRoot>/.pi/voice/` layout. Main Agent citation maps remain in the Goal's `.citations/`, resolved through Workspace path helpers. These compatibility paths do not introduce additional Storage Zones. Agent Directories and Goal credentials have separate configuration and permission boundaries; they are neither public artifacts nor Wiki content.

When deleting a Goal, GoalService continues to stage both the Goal directory and its corresponding server-side harness directory before committing the deletion. Recovery, Case Capture, and historical Artifact reads keep using the original paths. New callers must reuse the resolvers rather than construct another runtime tree.
