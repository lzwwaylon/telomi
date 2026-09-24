# Agent Node Backtesting

Node Evaluation has one usage: Candidate Replay of immutable Node Cases captured from real Runs. It pins Node Case Input and reruns it with a specified Candidate Capability Bundle. Valid Observed outputs receive independent blind evaluation; Recovery Cases without valid output follow the recovery contract below. New questions must run through normal product entry points and be captured as Cases. The Operations Interface does not accept direct inputs.

Candidate Replay does not reproduce historical output. It pins the captured business inputs, Runtime contract, Case Set, and Rubric; each Recipe determines whether external data is frozen. Candidate differences come from Prompts, Skills, Tools, and other Candidate Capabilities. Output text, Traces, Tokens, Cost, and Duration may vary. Runtime only requires outputs to pass the same structural and safety contracts.

Directory Artifacts and Capability Snapshots accept only content Hashes using the current fixed sort order, never historical Chinese-sort digests. Prime Search and Research Schedule Reviewer Cases must include the captured reasoning depth. Missing or invalid fields reject Replay rather than falling back to current configuration. Research Schedule Reviewer Cases must also include the resolved output language; it is not inferred from Report Context.

## Supported Scope

| Agent | Candidate Replay | Case source |
|---|---|---|
| `main-agent` | Yes | Production Main Agent runs |
| `cornell-note` | Yes | Production Research runs |
| `report-writer` | Yes | Production Research runs |
| `provider-child` | Yes; pins one Provider Child's task and pre-execution files and reruns only that child | Derived from a specified execution in a complete Prime Search Case |
| `prime-search` | Yes; v4 pins the Search question and captured context and reruns Provider operations; the Root may use general search | Production Research runs |
| `wiki-shard-builder` | Yes; freezes Cornell Evidence and Topic Plan | Production Wiki Update runs |
| `wiki-curator` | Yes; freezes Wiki Edition, Shards, and Topic Plan | Production Wiki Update runs |
| `podcast-writer` | Yes; freezes Canonical Report, generation requirements, and models | Production Podcast generation runs |
| `schedule-reviewer` | No (restricted); Cases can be captured and exported, but Candidate Replay requires exact matching of frozen answers, as described below | Production Research Schedule Reviews |
| `evolution` | Yes; reruns complete Browser Evolution in an isolated Goal without changing the real Goal | Terminal Browser Evolutions; see [Evolution Module](evolution-module-design.md) |

The production Research Runtime and Node Backtest share one Stage Runner construction entry point. Candidate Replay replaces only the target Agent's Candidate Capability Bundle, keeping Node Case Input and the Evaluation Runtime Epoch fixed.

## Operating Modes and Operations Listener

Full Case capture is opt-in. There are three instance roles, read at startup; changes require a restart.

| Role | Environment variable | Case Capture | Operations HTTP | Retention |
|---|---|---|---|---:|
| Product instance (default) | None | Only Prime Search Cases with a `valid_bundle` Browser child, which [Evolution](evolution-module-design.md) consumes | None | Enabled |
| Capture instance | `TELOMI_EVAL_CAPTURE=1` | Every instrumented node, plus one Case per terminal Evolution | Loopback, read-only Case Interface | Enabled |
| Candidate evaluation instance | `TELOMI_EVAL_INSTANCE=1` | Every instrumented node, plus one Case per terminal Evolution | Loopback, complete Replay Interface | Disabled |

Every role creates `NodeBacktestService`, registers all Replay Recipes and starts the Replay Queue, because Browser Skill Evolution replays its Candidates through them. The role determines which Case Capture Hooks are installed, whether an Operations Listener exists and its write access (`writable` in Status), Bundle Import and Bundle Exchange Root, and whether retention starts. Full capture is a development and evaluation tool: most installations never replay their Cases, and on a daily-used installation they grow to many gigabytes. Composition lives in `server/evaluation/operations-runtime.ts`, dynamically imported by `server/app.ts` at startup. `server/app.ts` does not statically import Evaluation or Evolution implementations.

The product HTTP app never mounts Operations routes. Operations uses a separate Express app and Listener, bound exclusively to `127.0.0.1`, ignoring `TELOMI_HOST`. The port defaults to `PORT + 1` and can be overridden through `TELOMI_OPERATIONS_PORT`. Authentication and cross-machine deployment are not currently supported.

### Case Capture Composition and Failure Semantics

Ordinary Research, Prime Search, Wiki, Podcast, and Main Agent code does not import Evaluation implementations. It only invokes the optional Hooks in `server/observability/case-capture.ts`. `operations-runtime.ts` installs the real implementations for the instance role through `installCaseCapture()`; each Hook is optional. A node whose Hook is absent, and every node in a process without Evaluation composition such as a unit test, follows the original product path and writes no Case. In the default role, the Prime Search Hook discards the draft of a failed batch or one without a `valid_bundle` Browser child, so only Evolution evidence remains. Hook signatures bind to the real functions through `typeof` and type-only imports without loading Evaluation code at runtime. `tests/evaluation/test-case-capture.ts` scans `server/` to reject new value imports, except within Evolution and `server/evaluation/` itself.

- Production Capture is **fail-open**: preparation or persistence failures do not prevent product results from returning. Failures are recorded in structured logs and the `capture` field of `GET /operations/v1/status` (`enabled`, `failures`, `recent`).
- Candidate Replay Evidence is **fail-closed**: failed Prime Search Candidate Capture throws immediately. If a Candidate execution ends without exactly one Candidate Case, the execution is `failed`; incomplete Evidence cannot enter a reviewable Pair.

### Case Retention and Recovery Cases

Product and Capture instances retain Cases only briefly: 30 days or 50 GB by default, whichever limit is reached first. Startup settings `TELOMI_EVAL_CASE_RETENTION_DAYS` and `TELOMI_EVAL_CASE_RETENTION_GB` override these limits. `server/evaluation/case-retention.ts` sweeps once after startup, then hourly. The first Sweep runs outside the startup critical path: recursively measuring a 50 GB Case store uses synchronous IO and must not block binding the Operations Listener or product port. Tests wait deterministically through `idle()`:

- Only `node-evaluation/cases/<caseId>` under production Runs covered by `capturedCaseRunRoots()` is eligible. Candidate Replay Runs, imported Bundles, Capability Snapshots, Material Cache, product Runs, and product Artifacts are outside this boundary and are never deleted. Eval Instance mode starts no retention policy, so Candidate instances cannot delete production Capture data.
- Delete expired Cases first, then the oldest remaining Cases until storage is within the size limit.
- Always skip nonterminal Runs (`run-state.json`, `wiki-update-job.json`, or unreadable state), Cases being exported as Bundles, and newly persisted Cases within the quiet period.
- Deletion first atomically renames a Case into a same-directory `.trash`, then recursively removes it. If the process exits midway, the next Sweep finishes cleanup without leaving a partly readable Case.
- Protection takes precedence over capacity. If active Runs and Cases in the quiet period prevent reaching the size limit, emit a health warning with remaining bytes rather than declaring success.
- The same Sweep reduces each terminal Evolution Run older than the retention period to `current.json`, `request.json` and its Apply Receipt, and deletes the finished Node Backtest Runs its rounds replayed. Evidence copies and Replay outputs are several gigabytes per Run, while the kept record is what the Browser trigger reads as its cursor, so consumed executions are never counted again. A Run whose own Evolution Case is still retained is skipped, because that Case may reference the Run directory.
- Sweeps fail open for the product. With an Operations Listener, results and warning counts appear in `capture.retention` in `GET /operations/v1/status`: `cases`, `bytes`, `deletedByAge`, `deletedBySize`, `protectedActive`, `protectedExporting`, `lastSweepAt`, and `warnings`.

A Capture whose Observed execution failed or was cancelled and therefore has no successful output can still be replayed as a **Recovery Case**. It retains frozen inputs, terminal Workspace, Trace, and terminal error. Every terminal failure class - `cancelled`, `timeout`, `rate_limit`, `budget`, `validation`, `provider`, and `permanent` - attempts to write a Recovery Case. Capture remains fail-open: its failures only affect health reporting, and the product failure path still throws the original error. Failure classification determines only terminal Case fields (`failedNodeEvaluationStatus()`). `run.kind` distinguishes two Run types:

- `quality`: Observed has output. Candidate and Observed form an anonymous Pair for independent Judgment.
- `recovery`: Observed has no output. A Candidate that finishes normally and passes the existing output contract proves recovery, and the Run enters `completed` directly. Recovery Runs generate no Pair or `better`/`same`/`worse` Judgment, and their `evaluation-batch` endpoint returns an error. A successful Candidate's captured Candidate Case can be exported as a new Quality Case.

Recovery Evidence is fail-closed. A Case with no output and missing terminal status, terminal error, or terminal Workspace/Trace is rejected at enqueue time, rather than after Candidate execution when assessment becomes impossible. One Run cannot mix Quality and Recovery Cases.

`GET /operations/v1/status` returns `protocolVersion` and `schemaHash`. External evaluation environments compare these before Replay and fail immediately on incompatibility. TypeBox Schemas in `server/evaluation/operations-contract.ts` are the sole contract authority. AJV validates request bodies at runtime and every successful JSON response on the Operations Listener. Invalid responses are not sent to the external evaluation environment; they become 500 errors identifying the operation and field path, so protocol drift fails closed before transmission. Binary routes stream files directly and have no JSON response to validate. `npm run generate:operations-openapi` generates the committed `server/evaluation/operations-openapi.json`, including actual success status codes such as 202 for `POST replays`. External evaluation environments generate TypeScript types from it. `npm run test:operations-openapi` checks that it is current.

The contract describes the response shapes actually projected by the Service and never includes absolute host paths. Artifacts expose only Run-relative `ref` and `sha256`/`byteLength`/`directory`; file contents come from file-reading routes. Open-ended parts remain intentional: additional `Execution.refs` keys depend on the Recipe and cannot be exhaustively enumerated; complete Case Manifest semantics belong to Case Bundles, because freezing them into the HTTP contract would make every Capture change a protocol break. Independent Judgments, semantic Summaries, and Attestations remain exclusively in the external evaluation environment.

## Status and Case API

```text
GET /operations/v1/status
GET /operations/v1/goals/:goalId/cases?agentId=AGENT_ID&limit=20
GET /operations/v1/goals/:goalId/cases/:sourceRunId/:caseId
GET /operations/v1/goals/:goalId/cases/:sourceRunId/:caseId/files
GET /operations/v1/goals/:goalId/cases/:sourceRunId/:caseId/file?ref=REF
```

The status endpoint returns the currently registered Recipes:

```json
{
  "recipes": [
    "cornell-note@3",
    "evolution@2",
    "main-agent@1",
    "prime-search@4",
    "provider-child@1",
    "podcast-writer@1",
    "report-writer@2",
    "schedule-reviewer@1",
    "wiki-curator@1",
    "wiki-shard-builder@1"
  ]
}
```

Status returns no host paths. The launching process configures the material cache root through `SOURCE_SERVICE_MATERIAL_CACHE_ROOT`, defaulting to `<TELOMI_DATA_DIR>/.pi/runtime/research-source-service/material-cache`. Eval instances use their own writable Overlay, not the production cache. External evaluation environments set these values themselves and do not need Telomi to report its disk layout.

## Candidate Replay

Candidate Replay pins historical Case inputs and Runtime constraints and introduces candidate differences through a Candidate Capability Snapshot or explicit Prompt override. The historical Observed Baseline is already saved in the Case and is not rerun.

New Capability Snapshots materialize only Goal Skills, `wiki/knowledge`, and Wiki Harness Mounts explicitly declared by selected Cases. Unreferenced history directories such as `wiki/runs` and `wiki/updates` are neither copied nor included in the candidate content Hash. Cases explicitly referencing a historical subdirectory retain that dependency. Browser Evolution uses the same scope when preparing Candidates. Old Snapshots and Bundles retain their original content and Hashes; Replay validates and materializes their entire frozen content without filling gaps from the current Goal or rewriting them.

Directory digests use fixed `en` path sorting. Reads recompute the digest under current rules and require an exact match with the saved Hash. Historical `zh`-sorted digests are rejected, and historical Manifests are never rewritten to bypass validation. Directory byte counts, Case file-count limits, and path safety checks still apply.

```bash
curl --fail --silent \
  -X POST \
  -H 'content-type: application/json' \
  http://127.0.0.1:8788/operations/v1/goals/GOAL_ID/replays \
  --data-binary '{
    "agentId": "cornell-note",
    "cases": [{
      "sourceRunId": "RUN_ID",
      "caseId": "CASE_ID"
    }],
    "candidate": {
      "capabilitySnapshotId": "caps_CANDIDATE_HASH",
      "promptMode": "observed"
    },
    "repetitions": 2,
    "rubricId": "cornell-note-v1"
  }'
```

At task creation, Runtime pins the Candidate Capability Bundle by content Hash. `cornell-note` and `report-writer` require explicit Prompt selection. `promptMode: "observed"` copies each Case's original Prompt into the Bundle; `promptMode: "override"` requires complete `promptOverride.systemPrompt` and `promptOverride.userPrompt`. Omitting the selection rejects creation instead of silently reading historical Prompts.

The resulting `run.candidate.promptBundle` stores per-Case Prompts, their content Hashes and provenance, and the Bundle Hash. Replay reads only these pinned Prompts. `run.candidate.capabilityBundleHash` binds both Workspace Snapshot and Prompt Bundle so the external Operations Interface can verify the actual Candidate identity. Each repetition reruns the Candidate and pairs it anonymously with the same Observed Baseline.

Formal Regression Campaigns also pass `candidate.expectedRuntimeBuild` and `candidate.expectedAgentBundleSha256`. At enqueue time and before execution, Node Backtest validates the Git Build loaded at process startup, the current disk state, and the Agent Bundle Hash. Any mismatch requires restarting Telomi; an old process cannot generate Candidate Evidence under a new HEAD identity.

### Provider Child Replay

A Provider Child Case is derived from a captured Prime Search execution and retains the provenance identities of its parent Case and execution. The Operations child Bundle export endpoint takes that execution identity. The exported child is an ordinary independent Case using the existing import, Replay, repetition, and blind-evaluation Interfaces. Export neither runs an Agent nor changes the parent Case.

The Recipe pins the parent-assigned task, pre-execution writable files, actual model, thinking level, service tier, and Temporal Context. Non-target Skills are frozen as the complete read-only directory visible to the child at the time. Replay overrides only the target Provider Skill; the Evolution Agent does not mount this auxiliary capability directory. The Capability Snapshot supplies the Candidate Skill. Historical ledgers and acquired material are Observed Evidence only and cannot become Candidate initial files. Derivation rejects historical records missing an initial snapshot, a complete Trace of the child itself, execution conditions, or a valid ledger. It also rejects any record with subsequent incoming Agent messages or model-configuration changes during execution, without falling back to Root replanning.

Each Candidate executes only one native Provider Child, retaining the production sandbox, Provider bridge, and ledger validation. There are no Root model calls, other Provider children, or Organizer. External pages and Provider data remain live; repetitions expose this residual variance. The Case Bundle contains the child's own Trace, material, and Provider call records without depending on a parent Run directory or another Replay record in the external evaluation environment. Failures and cancellations retain Recovery Evidence within the same scope.

### Prime Search External Data Boundary

Prime Search Cases pin the Search Question, captured Schedule and Topic Plan context, Temporal Context, available Provider IDs, and model selections. Replay builds the production Provider Registry from the Candidate Harness and reruns Provider operations. The current Recipe neither provides a frozen external corpus nor replays historical query responses. Upstream data, login state, and availability can change; blind evaluation must distinguish these changes from Candidate capability differences.

Prime Search retains the `input_tree_sha` of the empty node working directory and explicitly identifies its origin through `input_tree_source: "empty-work-dir"` in the workspace.

Replay continues to execute production `PrimeSearchBatchExecutor`, Prime Root, native RLM Provider children, Candidate Ledger, Source Organizer, and Source Bundle validation. At least two repetitions are recommended. Quality Runs generate blind pairs of Candidate output and the historical Observed Baseline; Recovery Runs settle under the recovery contract.

Prime Search blind-evaluation Artifacts include sanitized Search Execution Records, Source Bundles, Logical Sources, available decision records, and the Agent Bundle's Rubric. The Rubric requires assessment of Evidence Requirement coverage, relevance, Primary Sources, material completeness, temporal correctness, duplication, omissions, and consistency between evidence and decisions, not merely Source counts.

### Main Agent Topic Plan Recovery

Main Agent Cases freeze the Goal directory tree and the logical Workspace visible to the Agent. The confirmed Goal Topic Plan lives in the server Runtime Store outside the Goal directory. After restoring the Goal directory, Replay therefore reconstructs that Store from the Case's frozen `/history/topic-plan.jsonl`. The snapshot carries the authoritative confirmed revision and Plan; the Store generates Goal identity, content Hash, and revision chain without semantic inference or confirmation on the user's behalf. The restored Plan must reproduce the Case's frozen `/work/topic-plan.json` byte for byte.

If a Case freezes Topic Plan context but lacks the history required to restore it, such as an old Case or an uncaptured pending Proposal, Replay fails explicitly rather than proceeding with an empty Topic Plan.

### Wiki Shard Builder and Wiki Curator

Wiki Shard Cases pin the Goal, Cornell Evidence Snapshot, Topic Plan, Batch, and model. Wiki Curator Cases pin the operation, previous Wiki Edition, input Shards, Topic Plan, and model. Their Replays call production `runPrimeNoteWikiMaintainer()` and `curateWikiEdition()` respectively, without reusing the Prime Search Recipe.

Candidates load the Goal-scoped Wiki Skill from their own Capability Snapshot while retaining the bundled Wiki Meta Skill. Blind-evaluation Artifacts contain historical Observed Knowledge, Candidate Knowledge, structural metrics, and the Target Rubric for checking content quality, Evidence, citations, Topic membership, internal links, and graph relationships.

### Podcast Writer

Podcast Writer Cases are captured from production Podcast generation runs, pinning the Canonical Report, title, language, audience, per-generation requirements, and Root/child models. Replay calls production `writePrimePodcast()` and replaces only the `podcast-writing` Skill from the Candidate Capability Snapshot. Blind-evaluation Artifacts contain the historical script, Candidate script, structural summary, and rubric.

Both Cases and Candidate executions directly expose native Prime Root Sessions, child Sessions, deduplicated child lifecycle metadata, input files, and Agent file-protocol artifacts. The Operations Interface returns only references to these files rather than copying native Trace content. The current Prime SDK does not separately generate `rlm-subagent.json`, and Runtime does not fabricate a copy.

Poll results and retrieve blind-evaluation inputs:

```text
GET  /operations/v1/goals/:goalId/replays/:runId
GET  /operations/v1/goals/:goalId/replays/:runId/evaluation-batch
GET  /operations/v1/goals/:goalId/replays/:runId/files?ref=REF
```

During Candidate Replay, status responses expose the current Case, repetition, execution ID, and persisted Trace refs through `activeExecution`. `files?ref=REF` accepts those refs immediately, letting the Operations Interface continuously read native Prime Root/child Traces and the SDK child lifecycle index without waiting for execution to finish. `activeExecution` is a read-only projection, not persisted in the Run or mixed into `executions`, which contains only terminal results.

The system does not automatically start an Eval Agent or submit Judgments. Once a Run reaches `awaiting_evaluation`, the external evaluation environment saves Replay Evidence. A human or Coding Agent then reads the Traces, Artifacts, and Rubric there, submits Judgment, and generates Attestation. Telomi neither accepts nor stores semantic Judgments.

### Research Schedule Reviewer

Research Schedule Reviewer Cases are captured from production Research Schedule Reviews and pin the Schedule question, monitoring scope, Report Context, recent occurrence results, previous Review, and Root model. The Reviewer's external state comes only from Runtime-owned read-only bridges to long-term user memory and the Goal Wiki. Each bridge call and answer is recorded in `interactions.json`. Replay answers calls with identical names and arguments using the same frozen answers, so the Candidate sees exactly the original memory and Wiki without requiring live services. A Candidate call absent from the Case fails closed.

Cases also preserve the execution context: `interactions.json` with every memory/Wiki read and answer, Prime Root Session, bridge call logs, Runtime results, and Reviewer input and decision files. The Case file Interface exposes these through an allowlist. Staged credentials and configuration under `runtime/agent/` are not allowlisted.

A Review that reads neither memory nor Wiki always fails. This is the sole deterministic rule distinguishing a broken knowledge interface from a decision that no change is needed after inspection, and it applies to both production execution and Candidate Replay.

**Current limitation.** Frozen interactions match the operation and complete arguments exactly. A Candidate receives answers only by repeating historical queries unchanged. Different query arguments fail closed and prevent that Reviewer Candidate Replay from completing.

The blind-evaluation Artifact is a directory. `decision.json` contains the decision; `rubric.md` contains the Reviewer Rubric from the Agent Bundle, assessing evidence grounding, changes limited to monitoring scope and Report Context, and a usable summary. Observed and Candidate artifacts have the same shape.

The output contract fails closed during both Capture and Replay: missing fields, Proposals identical to current values, and unknown fields such as cadence are rejected. Rejected Reviews have no Observed Baseline and are retained as Recovery Cases with execution context and reasons. The Review's execution directory is itself the Capture-owned Run root, with Cases under its `node-evaluation/cases/` directory.

## Case Bundles and Temporary Eval Instances

`GET /operations/v1/goals/:goalId/cases/:sourceRunId/:caseId/bundle` streams an uncompressed Case Bundle tar. `POST /operations/v1/bundles/import` accepts `{ "path": "<exchange-root>/bundle.tar" }`, validates every blob, creates a missing Goal, registers the Capability Snapshot, and places the Case in `evaluation/imported-cases/`. Paths must remain within the Bundle Exchange Root configured at startup through `TELOMI_OPERATIONS_EXCHANGE_ROOT`, defaulting to `<TELOMI_DATA_DIR>/operations-exchange`. Relative paths resolve against that root; absolute paths must be inside it. `..` traversal, symlinks, and non-regular files are rejected. The import response's `caseRef` can be passed unchanged to the existing `POST replays` endpoint. Importing the same Bundle repeatedly is idempotent.

To start an isolated Replay instance from a worktree, set `TELOMI_EVAL_INSTANCE=1`, a separate `TELOMI_DATA_DIR`, `SOURCE_SERVICE_MATERIAL_CACHE_ROOT` pointing to the instance's private Overlay, `SOURCE_SERVICE_MATERIAL_CACHE_BASE_ROOT` pointing to the read-only production material cache, and `TELOMI_OPERATIONS_EXCHANGE_ROOT` for Bundle exchange. Reads search the Overlay before the Base; writes and GC affect only the Overlay, allowing Candidates to reuse the production cache without changing it. The Overlay is inside `TELOMI_DATA_DIR` and is removed with instance data. Both roots must be on the same volume. Eval mode retains the Node Backtest queue and Python Source Service, but starts no Codex usage monitor, Browser sweep or automatic browser, Custom Provider sync, File ingest, or Research schedule scheduler.

## Validation

```bash
npm test -- tests/evaluation/test-operations-listener.ts
npm run test:operations-openapi
npm test -- tests/evaluation/test-case-capture.ts
npm test -- tests/evaluation/test-case-lifecycle.ts
npm test -- tests/evaluation/test-node-backtest-agents.ts
npm test -- tests/evaluation/test-case-bundle.ts
npm test -- tests/evaluation/test-main-agent-replay-topic-plan.ts
npm test -- tests/evaluation/test-main-agent-replay-goal-registration.ts
npm test -- tests/evaluation/test-prime-search-live-replay.ts
npm test -- tests/evaluation/test-wiki-frozen-replay.ts
npm test -- tests/evaluation/test-podcast-frozen-replay.ts
npm test -- tests/evaluation/test-schedule-review-frozen-replay.ts
```
