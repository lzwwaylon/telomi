# Telomi Research Runtime

## Purpose

A Research Run turns a user question into two parallel outputs:

- A final report grounded in the current Cornell Notes
- A background incremental Goal Wiki update

Runtime owns only deterministic mechanisms. Agents make every semantic judgment involved in search, selection, cross-Provider grouping, knowledge extraction, report editing, and Wiki maintenance.

## Execution Flow

```text
Main Agent (Pi Coding Agent)
  -> research Tool
  -> Prime Search Root
       -> one Prime child per Root-selected Provider
  -> Runtime Source validation and immutable materialization
  -> incremental cross-provider Organizer (Prime Agent when needed)
  -> Runtime logical Source materialization
  -> one fresh Cornell Note Prime Agent per logical Source
  -> Cornell Note Snapshot
       -> Prime Report Writer Root + Section children
       -> asynchronous Prime Wiki Maintainer
```

There is no independent retrieval Worker, Meta Gate, or Source Agent Proposal fallback path.

## Execution and Recovery Entry Point

`server/research/execute-run.ts` is the sole execution and recovery Interface for Research Runs. It owns Topic Plan admission, Run directory reservation, `resume-request.json` persistence, Run checkpoint claiming, the Final Runtime Gate, and User Task History recording. It returns the Run identity, status, report reference, and user receipt.

All three entry points invoke the same operation: the Main Agent's `research` Tool only converts the protocol; scheduled Research and user-requested resumes call it directly from `app.ts` without constructing a Tool Call. Recovery restores the Goal title, description, language, and Task Source from the persisted resume request, preserving the original Run identity and checkpoints. Admission and recovery claims are synchronously persisted before the first yield, preventing concurrent requests from claiming the same Run.

## 1. Main Agent

The Main Agent is the Pi Coding Agent in Goal conversations. It submits a complete research task and an optional report title or schedule configuration through the `research` Tool.

The Main Agent supplies an independent incremental search task through `search_question`, and user preferences, existing understanding, and report requirements through `report_context`. An optional `note_focus` carries what the user wants the evidence notes to record in most detail; it reaches only the Cornell Note stage and never changes the search or the Wiki. Runtime preserves both inputs, pins the Goal, server-bundled Harness Snapshot, Topic Plan, Wiki and Skill content versions, temporal constraints, and Run directory, then starts the sole Research Runtime.

## 2. Main Agent Search and Report Inputs

The Main Agent plans `search_question` using existing research and user context, explicitly identifying missing evidence and the scope of updates to avoid redundant searches. `report_context` is persisted unchanged and passed to the Report Agent, including user objectives, audience, existing understanding, format, depth, and language preferences.

Prime Search Root directly receives the search question, time range, Topic Plan, and optional Scheduled Research occurrence. The general search Provider is available only to the Root, which uses it as needed to resolve uncertainty affecting retrieval; no Child Agent may call it. Specialized Provider children remain responsible for source retrieval and original-material acquisition.

## 3. Prime Search

Prime Search is the sole production Search Adapter.

Runtime mounts the Provider Catalog, Provider SDK, and Provider Skills. The Root first resolves discovery prerequisites that affect delegation through Tools or specialized Provider children, then splits tasks by evidence responsibility. Multiple children may use the same Provider, and independent tasks whose prerequisites are satisfied run in parallel. Browser task Prompts specify starting URLs and exploration scope; Agents currently observe those scopes without additional Runtime URL-scope validation. Children acquire material, write Candidate Ledgers, and complete deterministic submission, then return coverage, discovery leads, and gaps through native completion replies. The Root checks completion task by task, Runtime validates and materializes retained Sources, and the downstream Organizer groups records describing the same object. The SDK waits for the full child lifecycle through `waitForRlmQuiescence()`.

All upstream overload handling for one Provider within a Provider child shares one budget; each request does not receive a fresh full budget. arXiv gives each child 60 seconds, including rate-limit cooldown waits and time spent on overloaded requests and controlled retries, with only one controlled retry across the entire child. Repeated overload, a Retry-After longer than the remaining budget, or budget exhaustion terminally opens that child's circuit breaker. Subsequent month, detail, and download requests no longer contact the Provider and immediately return `source_unavailable` with `provider_id`, `failure_class`, `elapsed_ms`, `attempts`, and `retry_after_ms`. Changing request parameters does not extend the wait. The SDK preserves results already acquired and lists uncovered date ranges; if no range was covered, it throws `source_unavailable` so callers can distinguish temporary upstream unavailability from an empty query result. A Search Execution Record's `provider_access` comes from Runtime's own Provider call records and summarizes actual upstream attempts, ordinary access spacing, rate-limit waits, and termination reasons. After overload, Source Service sends no probe requests that bypass the cooldown window.

The Provider child submits its existing or empty Ledger and returns `source_unavailable` and uncovered responsibilities to the Root in its completion reply. Based on capabilities and evidence types in the current Provider Catalog, the Root selects at most one suitable alternative Provider that has not yet been tried and delegates only the uncovered portion. The alternative child uses its own Ledger and Provider identity. If no suitable alternative exists or it is also unavailable, the Root records unresolved coverage and stops instead of cycling between Providers. Differences in collection coverage and full-text availability enter the downstream report's limitations.

Like arXiv, Hugging Face Paper acquisition uses a progressive funnel: search or Daily Papers performs discovery, `paper_profile` screens through metadata or a bounded opening portion of the body, and `download_paper` materializes only retained papers. Each paper becomes a Source Snapshot containing `paper.md` and `metadata.json`; the latter retains native Hugging Face metadata and its project-page, GitHub repository, and original PDF links. A Hugging Face Paper Candidate cannot pass submission with search metadata JSON alone because the Cornell Note Agent must read the complete Logical Source. An arXiv `pdf_url` serves only as provenance and does not bypass arXiv's overload circuit breaker.

Provider rate-limit waits, access recovery, circuit breaking, and Root-selected alternatives are persisted as sanitized Runtime events. Before delegating an alternative child, the Root records the actual routing decision through `research_runtime.report_provider_fallback`. The Activity projection exposes only the Provider, failure classification, and time budget, never queries, credentials, access scope, or Workspace paths. Ordinary minimum access spacing produces call metrics but no rate-limit Activity. Page refreshes and event-stream reconnections restore state from the same Runtime records. A successful retry ends the wait; finished Runs stop accumulating waiting time. Research Activities distinguish current from historical executions through explicit resume events, retaining Agent attempts and parallel steps within each execution. Execution records read complete Agent sessions. Prime Search reads saved traces grouped by Root, Provider child, and Source Organizer; a running or failed Stage is included only if its Root session began within that execution's time window. Each session exposes its delegation depth beneath the Root and the model actually called, both taken from session records rather than configuration. List entries limit each text segment to 2,000 characters and mark truncation; details read the full content line by line. Step counts represent recorded work, not estimated total progress for dynamic research.

Candidate Ledgers are validated at child submission through a Prime SDK custom Tool. A failure returns actionable errors to the same child Session for correction; Runtime neither generates nor repairs semantic content. Prime Search does not load Pi Extensions.

Final Acquisition output:

```text
source/
  <provider>/<stable-directory>/
    record.json
    <downloaded material>
  index.json
  .complete
```

Runtime validates Provider execution, Provider, URL, Candidate ID, directory safety, and actual material, and deterministically converts supported documents to text. Browser material is converted directly in its Provider execution Workspace, bypassing Goal file ingestion; it therefore creates no Activity and does not appear in the Main Agent's `/documents`. Agents cannot fabricate nonexistent material or bypass the Provider Interface.

## 4. Cross-provider Organizer

The Organizer maintains a Goal-scoped incremental index rather than regrouping everything each Run. Runtime first merges current results and the historical Index by stable Source ID, preserves existing decisions, and gives only new Sources to an independent fresh Prime Session. The Organizer Agent is skipped when there are no new Sources or the accumulated Index still contains only one Provider.

The Agent runs in an isolated metadata-only Workspace, reading only `input.json` and writing `decision.json`. It has only an SRT-constrained IPython Tool, with no Source material, Provider SDK, Source Bridge, Skills, or Runtime private state mounted, and cannot spawn RLM children. It groups only direct representations of the same canonical research object across different Providers:

- A repository, model release, primary paper, and implementation explicitly linked to that paper may be grouped when they represent the same official project.
- `built on`, `adapted from`, fine-tuning, compatibility, shared architecture or task, broad families, and third-party integrations do not justify grouping.
- Being cross-provider is necessary but insufficient to establish identity; uncertain Sources remain ungrouped.

It handles only newly added and historically ungrouped Sources, which may join an existing canonical Group, form a new Group, or remain ungrouped. Existing Group members are not moved or merged during ordinary incremental processing:

```json
{
  "schema_version": 2,
  "sources": {
    "source:<stable-id>": {
      "candidate_id": "arxiv:...",
      "provider_id": "arxiv",
      "title": "...",
      "url": "https://...",
      "summary": "...",
      "revision_sha256": "...",
      "snapshot_path": "snapshots/...",
      "group_id": "qwen3-tts"
    }
  },
  "groups": {
    "qwen3-tts": {
      "title": "Qwen3-TTS",
      "identity": "reusable cross-provider identity rule"
    }
  }
}
```

`group_id` must be a stable kebab-case slug for the canonical object, never a UUID, Hash, Provider ID, or Run ID. Each Group contains Sources from at least two different Providers. Runtime retains a file snapshot for each Source revision. When a Group is encountered in the current Run, historical members and new or changed members are materialized together as a Logical Source revision with the same stable ID.

## 5. Cornell Note

Each Logical Source starts a fresh Prime Agent, with a default maximum concurrency of four. Runtime first materializes a Cornell Source View from the immutable Source. The Agent sees only:

- UTF-8 body text and local image assets declared in the conversion manifest
- The Source ID
- The user question
- The Cornell Note Prompt and output contract

Only when an existing Logical Source gains members or its members change does Runtime additionally provide new or changed member paths as reading guidance. This explanation is not injected for a new Source or when nothing changed.

Binary files such as original PDFs remain in the Source Artifact and are excluded from the Cornell Source View. Local images referenced by Markdown retain their original relative paths and can be viewed through IPython rich display, but Evidence may cite only body-text line numbers. Runtime rejects missing conversion output outright; the Agent cannot fall back to original files.

The Agent sees no Ontology, Report Outline, other Sources, or global coverage. It submits top-level `sections`; Runtime adds the version and Source identity, and validates Topic and Discovery fields against the current context. Every Cue must cite a Source-relative path and exact line numbers. `sections` may be empty when there is no relevant content.

Runtime validates files and line numbers and adds cited-content hashes. Unchanged Source revisions reuse existing Notes. A new Run Snapshot is written to:

```text
artifacts/cornell-notes/snapshot-<sequence>.json
```

See [Cornell Note Agent](cornell-note-agent.md) for the complete contract.

## 6. Report Writer

There is one Prime Report Root. The Research flow freezes the current Cornell Notes into Find Out material; the Main Agent's `generate_report` Tool freezes the current Goal Wiki into Wiki material. Both Adapters hand material to the same Root, which selects material, determines sections, delegates Section children, and performs final editing. There is no separate report-outline Agent.

Both Adapters generate the same read-only reference inventory at `inputs/materials.json`. Before launching Section children, the Prime Worker validates every Source handle or Wiki path in the Root Outline. Runtime validates the complete Outline and references again at final publication.

The Writer Root uses a restricted Note Workspace:

```python
await notes_report.summary()
await notes_report.summary(source=["@22"])
await notes_report.catalog(source=["@22", "@28"])
await notes_report.search("query", source=["@22"])
await notes_report.get(["N1", "N2"])
```

A Find Out snapshot contains only the index and Cornell Note JSON. A Wiki Report snapshot pins the current Wiki, corresponding Cornell Notes, Sources, and citation mappings, but Prime Report Root accesses the current Wiki only through the read-only `wiki_report` material Adapter.

The Root first reads the complete compact Source roster, chooses sections and an editorial plan, then starts exactly one Prime child per Section. Children deeply read the Notes of assigned Sources and cite them as `<cite>N123</cite>`; Runtime deterministically resolves Note refs to frozen Source URLs.

Writer Root also loads the progressive `writing-skill`. Its structure and prose guidance has one English version that applies to every report language. Chinese reports invoke the deterministic `writing_skill` scanner during final editing. Runtime reruns the same scanner on final Section bodies and publishes its actual output as `prose-lint.txt` alongside Writer artifacts. Other report languages skip Chinese lint. The report language written by the Orchestrator to read-only `inputs/request.json` determines whether the report is Chinese; Runtime does not parse language from Prompt text. Inputs without that file have unknown language and skip lint.

After all children finish, the same Root Session performs final editing: removing repetition, unifying terminology, correcting section responsibilities and citations, and writing final `writer-output/sections/*.md` files.

Runtime does not change report semantics. It validates Sections, citations, and paths, then mechanically compiles titles, References, `report/final.md`, and `report/final.json`.

## 7. Wiki Maintainer

Wiki Maintainer runs asynchronously alongside Report Writer. It consumes only Cornell Notes and existing Concept / Entity pages, never raw Sources.

Each Source Batch's Wiki Shard Root uses only native IPython and shared Workspace files. The Root reads `input/source-roster.json` and `input/note-index.json` and writes `work/plan.json`. After validation, Runtime creates assignments containing all allocated Cornell Entries. Native RLM children read their assignments and atomically write exclusive `result.json` files. The Root only plans and repairs: it does not read complete Note bodies or write final page prose. Every new Note must be cited by a candidate Page or have an explicit reason for deferral.

Independent Shards of at most ten Sources are passed one by one to Wiki Curator in stable batch order as they complete. The first batch uses `initialize` or `update`; subsequent batches use `update` against the rolling Edition. Shard Builders continue concurrently, so the Curator may start before later Shards finish. Each Curator execution processes one Shard and jointly decides Concept and Entity identity, Page boundaries, prose, relationships, Evidence retention, and current Topic membership. Only the final Edition is published after all successful Shards have been processed.

Wiki Curator also has no Agent-facing Python interface. The Root reads compact indexes from the shared Workspace's `input/` and writes `work/plan.json`; Runtime only validates the Plan and materializes assignment files. The Root delegates Worksets through native `rlm()`. Children read assignments, Page and Cornell Entry files, and compact index rows for incoming Pages in `input/index.json` and the previous Edition in `input/main-index.json`, which let them judge whether derived Concepts duplicate incoming candidates or published Concepts. They write exclusive `result.json` files, deliver them through `submit_workset`, repair them in the same Session until Runtime accepts them, and then return native terminal results. Once every Workset passes, a final relation child uses the complete Edition catalog, fixed Concept bodies, and Cornell Entries to reconcile synonymous Concepts, then determine outgoing edges for modified and merged pages. It may repair Concept duplication already present in the previous Edition; unmerged pages remain unchanged. Runtime validates the union of merged citation Evidence, Topics, and exclusive dispositions; redirects page references; handles same-type, same-title conflicts during Workset repair; and rechecks identity uniqueness after reconciliation. Runtime validates these files together and materializes the Edition without implementing a parent-child message protocol.

Runtime only generates short Refs, validates exclusive Note and Page coverage, relationship endpoints, and atomic submission, then publishes the Goal Wiki. Agent Sessions mount only `ipython` and their respective submission Tools; Runtime does not track whether an Agent called a particular reading interface.

### Resuming Interrupted Updates

Wiki updates run in the background independently of the Report flow, so they own resumable state that survives process restarts.

- The job record `wiki-update-job.json` sits with Run state in the Run control directory. Backend startup changes `running` to `interrupted`, after which the Run's Activity entry offers "Resume Wiki update." The user triggers `POST /api/goals/:goalId/wiki-updates/:runId/resume`. Runtime does not retry automatically: resuming spends real tokens, so the user decides. At most three resumes are allowed; after that, the button remains visible but disabled with an explanation.
- Each Source batch persists its own `checkpoint.json` with content digests, draft Shard, and usage. Each rolling Curator stage also has a separate input identity and checkpoint. Resume reuses valid Shards and committed Curator stages and executes only missing or invalid steps.
- Published Compilation artifacts are immutable. An existing compilation record is reused in full; if the knowledge directory was published without its record, resume claims that directory directly without rerunning any batch.
- Publication uses a Goal-scoped lock, content-Hash baseline validation, and atomic replacement through a temporary directory. Interruption cannot leave a half-written Wiki.

Activity separately presents and supports playback of draft Shards, Wiki Curator, and Publication. If individual Shards fail, the remaining Shards may still be published, but the final status is `partial`, retaining failed Sources, Traces, and consumed usage. A rejected Curator batch is likewise treated as a failed batch: the rolling Edition carries forward to the next batch, and that batch's knowledge is left for the next Run rather than discarding the entire compilation. Only a Curator failure before any Edition exists fails the compilation, preventing an empty Wiki from being published as partial success. When the Topic Plan changes, a separate Activity invokes the same Curator's `reframe` operation.

## Runtime and Agent Boundary

Agents own:

- Provider search strategies
- Semantic Candidate selection
- Cross-Provider relationship judgments
- Cornell Note content
- Report planning, writing, and final editing
- Semantic Wiki page maintenance

Runtime owns:

- Pinning inputs, model policies, and Harness revisions
- Sandboxes, Sessions, concurrency, and cancellation
- Provider SDK mounting
- IDs, short Refs, Hashes, and Source revisions
- Source material validation and immutable snapshots
- Schema, path, line-number, and citation validation
- Checkpoints, recovery, and Artifact publication
- Mechanical report compilation
- Atomic Wiki publication

Runtime does not replace semantic judgment with rules.

## Sessions and Concurrency

| Stage | Session | Concurrency |
|---|---|---|
| Main Agent | Long-lived Goal Session | 1 |
| Prime Search Root | Fresh per batch | 1 |
| Provider children | Fresh per Provider task actually delegated by the Root | Root-selected count |
| Organizer | Fresh when new Sources can be grouped | 1 |
| Cornell Note | Fresh per Source | 4 by default |
| Report Root | Fresh; same Session continues after children | 1 |
| Report Section children | Fresh per Section | Section count |
| Wiki Root | Fresh per Wiki Activity | 1 |
| Wiki Page / Link children | Fresh per Root-defined semantic scope | Bounded by the Root |
| Podcast Root | Fresh per Podcast generation | 1 |
| Podcast Segment / Review children | Fresh per Root-defined semantic scope | Bounded by the Root |

Prime Search currently returns all Logical Sources together after Acquisition and the Organizer finish. Cornell Notes do not start before Provider children finish.

Prime Search, Report Writer, Wiki Shard Builder, Wiki Curator, and Podcast Writer all use the Prime SDK's native `waitForRlmQuiescence()` to wait for children and their parent Session's continuation turns. Runtime does not use autonomous gates, file polling, or duplicate Traces as a waiting protocol. Cornell Note delegates no RLM children and therefore does not need this interface.

## Models and Thinking Levels

Environment and Goal settings can override models, so the model selected at runtime is not a documentation contract. Defaults are defined in `TASK_MODEL_ROLE_INFO` in `server/config/settings.ts` for `primeRoot`, `primeChild`, `cornellNote`, and `wikiMaintainer`; Cornell Note re-exports its configuration through `server/research/config.ts`.

The intent behind thinking levels is not evident from code: Prime Search Root and the Organizer use medium, Report Root and Section children share Prime high, and Wiki Maintainer uses medium. The authoritative values for a particular run are in `research-harness-snapshot.json`, its Node Trace, and evaluation artifacts.

Run new validation questions through the real product entry point and capture them as Cases, then complete Candidate Replay and independent review under [Attestation](development/attestation.md). The Operations Interface does not accept new questions as direct inputs. See [Node Evaluation](node-agent-backtest.md) for each Recipe's external-data boundary.
