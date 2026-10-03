# Telomi Research Runtime

## Purpose

A Research Run turns a user question into two parallel outputs:

- A final report grounded in the current Cornell Notes
- A background incremental Goal Wiki update

Runtime owns only deterministic mechanisms. Agents make every semantic judgment involved in search, selection, cross-Provider grouping, knowledge extraction, report editing, and Wiki maintenance.

## Execution Flow

```text
Research Schedule or user-requested recovery
  -> Research execution interface
  -> Prime Search Root
       -> one Prime child per Root-selected Provider
  -> Runtime Source validation and immutable materialization
  -> incremental cross-provider Organizer (Prime Agent when needed)
  -> Runtime logical Source materialization
  -> one fresh Note Agent per logical Source
  -> Cornell Note Snapshot
       -> Report Writer Root + Report Writer Section children
       -> asynchronous Wiki compilation
```

There is no independent retrieval Worker, Meta Gate, or Source Agent Proposal fallback path.

## Execution and Recovery Entry Point

`server/research/execute-run.ts` is the sole execution and recovery Interface for Research Runs. It owns Topic Plan admission, Run directory reservation, `resume-request.json` persistence, Run checkpoint claiming, the Final Runtime Gate, and User Task History recording. It returns the Run identity, status, report reference, and user receipt.

Scheduled Research and user-requested resumes call the operation directly from `app.ts`. Conversational Main Agent questions use `investigate` instead; that path does not execute this full report-and-Wiki pipeline. Recovery restores the Goal title, description, language, and Task Source from the persisted resume request, preserving the original Run identity and checkpoints. Admission and recovery claims are synchronously persisted before the first yield, preventing concurrent requests from claiming the same Run.

## 1. Conversational entry point

Main Agent uses `investigate` for factual Goal questions and report-style answers. Prime checks saved knowledge, reads original Sources through Note Agent question reading, acquires external material when permitted, and delegates an answer to the Report Writer. Main reads the saved result before `deliver_investigation` delivers it unchanged. For a report request, `report_title` at delivery publishes that same answer as a Canonical Report with its frozen evidence, enabling the report card, file reading and Podcasts. Runtime queues newly committed and validated Cues for asynchronous Wiki maintenance. Answer delivery proceeds independently, using the investigation's saved evidence. See [Research Agents](modules/research-agents.md) for this path.

## 2. Full Research Run inputs

Scheduled Research and recovery preserve an incremental search question, a complete report brief, and optional note focus. The search question identifies missing or updated evidence; Report Context contains the user objective, audience, existing understanding, format, depth and language. Note focus reaches only the Note Agent stage and does not widen search or change the Wiki.

Runtime pins the Goal, server-bundled Harness Snapshot, Topic Plan, Wiki and Skill content versions, temporal constraints, and Run directory. Recovery restores these persisted task inputs instead of deriving them again from Main's current conversation.

Prime Search Root directly receives the search question, time range, Topic Plan, and optional Scheduled Research occurrence. The general search Provider is available only to the Root, which uses it as needed to resolve uncertainty affecting retrieval; no Child Agent may call it. Specialized Provider children remain responsible for source retrieval and original-material acquisition.

## 3. Prime Search

Prime Search is the sole production Search Adapter.

Runtime mounts the Provider Catalog, Provider SDK, and Provider Skills. The Root first resolves discovery prerequisites that affect delegation through Tools or specialized Provider children, then splits tasks by evidence responsibility. Multiple children may use the same Provider, and independent tasks whose prerequisites are satisfied run in parallel. Browser task Prompts specify starting URLs and exploration scope; Agents currently observe those scopes without additional Runtime URL-scope validation. Children acquire material, write Candidate Ledgers, and complete deterministic submission, then return coverage, discovery leads, and gaps through native completion replies. The Root checks completion task by task, Runtime validates and materializes retained Sources, and the downstream Organizer groups records describing the same object. The SDK waits for the full child lifecycle through `waitForRlmQuiescence()`.

Upstream overload handling shares a bounded budget within each Provider child; changing query parameters or egress routes never creates a fresh budget. arXiv keeps separate API discovery and main-site acquisition domains, each with 60 seconds including cooldown waits and overloaded attempts, and one controlled retry. Healthy first attempts, including ordinary queueing, spacing and document conversion, retain caller cancellation and existing service timeouts; the overload allowance bounds cooldown admission and controlled retries. Repeated overload, a Retry-After beyond the remaining budget, or budget exhaustion stops only that domain and returns `source_unavailable` with `arxiv_access_scope`, failure classification, elapsed time, attempts, and retry delay. API discovery failure preserves known paper identifiers for direct PDF acquisition through the healthy main domain; provider-wide access denial stops both. All uncached arXiv requests still share the Python service's three-second global admission interval and one connection. The SDK preserves results already acquired and lists uncovered date ranges; if no range was covered, it throws `source_unavailable` so callers can distinguish temporary upstream unavailability from an empty query result. A Search Execution Record's `provider_access` comes from Runtime's own Provider call records and summarizes actual upstream attempts, ordinary access spacing, rate-limit waits, and termination reasons. After overload, Source Service sends no probe requests that bypass the cooldown window.

Optional arXiv [egress routes](../services/research-source-service/README.md#optional-arxiv-egress-routes) select transport within the same shared admission and cooldown. Switching exits never grants a new Provider Child budget or another controlled retry. Source Service makes one request and advertises an available alternate through sanitized route names; the built-in arXiv Runtime may then use its existing bounded retry. With routing disabled, the single-attempt policy outside Provider Children is unchanged.

The Provider child submits its existing or empty Ledger and returns `source_unavailable` and uncovered responsibilities to the Root in its completion reply. Based on capabilities and evidence types in the current Provider Catalog, the Root selects at most one suitable alternative Provider that has not yet been tried and delegates only the uncovered portion. The alternative child uses its own Ledger and Provider identity. If no suitable alternative exists or it is also unavailable, the Root records unresolved coverage and stops instead of cycling between Providers. Differences in collection coverage and full-text availability enter the downstream report's limitations.

Like arXiv, Hugging Face Paper acquisition uses a progressive funnel: search or Daily Papers performs discovery, `paper_profile` screens through metadata or a bounded opening portion of the body, and `download_paper` materializes only retained papers. Each paper becomes a Source Snapshot containing `paper.md` and `metadata.json`; the latter retains native Hugging Face metadata and its project-page, GitHub repository, and original PDF links. A Hugging Face Paper Candidate cannot pass submission with search metadata JSON alone because the Note Agent must read the complete Logical Source. An arXiv `pdf_url` serves only as provenance and does not bypass arXiv's overload circuit breaker.

Provider rate-limit waits, access recovery, circuit breaking, and Root-selected alternatives are persisted as sanitized Runtime events. Before delegating an alternative child, the Root records the actual routing decision through `research_runtime.report_provider_fallback`. The Activity projection exposes only the Provider, affected arXiv access domain, failure classification, and time budget, never queries, credentials, credential identities, or Workspace paths. Ordinary minimum access spacing produces call metrics but no rate-limit Activity. Page refreshes and event-stream reconnections restore state from the same Runtime records. A successful retry ends the wait; finished Runs stop accumulating waiting time. Research Activities distinguish current from historical executions through explicit resume events, retaining Agent attempts and parallel steps within each execution. Execution records read complete Agent sessions. Prime Search reads saved traces grouped by Root, Provider child, and Source Organizer; a running or failed Stage is included only if its Root session began within that execution's time window. Each session exposes its delegation depth beneath the Root and the model actually called, both taken from session records rather than configuration. List entries limit each text segment to 2,000 characters and mark truncation; details read the full content line by line. Step counts represent recorded work, not estimated total progress for dynamic research.

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

See [Note Agent](note-agent.md) for the complete contract.

## 6. Report Writer

There is one Report Writer Root. Full Research Runs freeze current Cornell Notes into Notes material. The retained Wiki material Adapter supports report snapshots and historical replay; it is not a separate Main Agent Tool. These Adapters hand material to the same Root, which selects material, determines sections, delegates Section children, and performs final editing. Investigation uses the answer variant without Section children; a requested report publishes that validated answer at delivery, with frozen citation compilation and no second Writer pass.

Both Adapters generate the same read-only reference inventory at `inputs/materials.json`. Before launching Section children, the Prime Worker validates every Source handle or Wiki path in the Root Outline. Runtime validates the complete Outline and references again at final publication.

The Writer Root uses a restricted Note Workspace:

```python
await notes_report.summary()
await notes_report.summary(source=["@22"])
await notes_report.catalog(source=["@22", "@28"])
await notes_report.search("query", source=["@22"])
await notes_report.get(["N1", "N2"])
```

A Notes snapshot contains only the index and Cornell Note JSON. A Wiki Report snapshot pins the current Wiki, corresponding Cornell Notes, Sources, and citation mappings, but Report Writer Root accesses the current Wiki only through the read-only `wiki_report` material Adapter.

The Root first reads the complete compact Source roster, chooses sections and an editorial plan, then starts exactly one Prime child per Section. Children deeply read the Notes of assigned Sources and cite them as `<cite>N123</cite>`; Runtime deterministically resolves Note refs to frozen Source URLs.

Writer Root also loads the progressive `writing-skill`. Its structure and prose guidance has one English version that applies to every report language. Chinese reports invoke the deterministic `writing_skill` scanner during final editing. Runtime reruns the same scanner on final Section bodies and publishes its actual output as `prose-lint.txt` alongside Writer artifacts. Other report languages skip Chinese lint. The report language written by the Orchestrator to read-only `inputs/request.json` determines whether the report is Chinese; Runtime does not parse language from Prompt text. Inputs without that file have unknown language and skip lint.

After all children finish, the same Root Session performs final editing: removing repetition, unifying terminology, correcting section responsibilities and citations, and writing final `writer-output/sections/*.md` files.

Runtime does not change report semantics. It validates Sections, citations, and paths, then mechanically compiles titles, References, `report/final.md`, and `report/final.json`.

Citation compilation preserves the stored Source URLs and performs no network reachability probes. A temporary outage, rate limit, or login requirement must not remove a Source link from the report. Runtime still validates Source provenance fields and URL format during acquisition, and resolves report citations against the frozen reference inventory; reachability cannot establish whether a URL identifies the cited material.

## 7. Wiki Compilation

Wiki Compilation runs asynchronously alongside Report Writer. It consumes frozen Cornell Notes and previous Wiki pages, never raw Sources.

New Wiki Updates use the Wiki compilation compiler. Runtime processes each complete Cornell Note into object pages, resolves object identity and unplaced Cues against the previous Edition, then derives concepts only from accepted object evidence. Object construction and target writing use Luna; object target planning uses Terra. Existing published Editions remain readable.

Concept generation uses four separate Pi Coding Agent stages, all with Terra and medium reasoning:

1. Plan distinct explanatory questions, assigning each object to one or more concept jobs or a verified object-only decision. Existing concepts are available as context or explicit update targets.
2. Write zero or one candidate per question, with up to four concurrent writers. Writers fully read assigned objects and any historical target; declined updates preserve old pages.
3. Audit the complete candidate collection and untouched old concepts, identifying unnecessary new candidates and disjoint conflicts.
4. Merge only the flagged conflicts, preserving member evidence and leaving unrelated page bodies unchanged.

These concept sessions expose only read-only page material and SRT-bound `read`, `write` and `edit`; they receive no Topic Plan or independent Cue-detail input and cannot delegate RLM children. Runtime validates manifests, evidence, identities, actual native reads and accepted files. Validation errors return to the same session for one repair turn. Construction publishes no semantic relationships; page-level Topic classification builds navigation from final pages. See [Wiki Compilation](modules/wiki-compilation.md) for the ownership, recovery and publication constraints.

### Resuming Interrupted Updates

Wiki updates run in the background independently of the Report flow. Backend startup marks an unfinished job as interrupted; the user can resume it through the existing Activity action, with at most three resumes. Accepted stage checkpoints are reused only when their frozen inputs, implementation, output files and reading receipts still match. Failed attempts retain their usage and native sessions. Partial Wiki compilation candidates remain inspectable and cannot replace the published Edition. Publication verifies the frozen base under the Goal publication lock and atomically replaces it.

Historical shard/curator Updates cannot resume execution. Their published Editions, captured Cases and Traces remain readable; they cannot be relabeled as Wiki compilation inputs.

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
| Note Agent | Fresh per Source | 4 by default |
| Report Writer Root | Fresh; same Session continues after children | 1 |
| Report Section children | Fresh per Section | Section count |
| Wiki object builders | Fresh per complete Note | At most 4 |
| Wiki concept planner / audit / conflict merge | Fresh per stage or conflict group | 1 |
| Wiki concept writers | Fresh per explanatory question | At most 4 |
| Wiki page Topic classification | One direct completion per final page | At most 4 |
| Podcast Writer Root | Fresh per Podcast generation | 1 |
| Podcast Segment / Review children | Fresh per Root-defined semantic scope | Bounded by the Root |

Prime Search currently returns all Logical Sources together after Acquisition and the Organizer finish. Cornell Notes do not start before Provider children finish.

Prime Search, Report Writer and Podcast Writer all use the Prime SDK's native `waitForRlmQuiescence()` to wait for children and their parent Session's continuation turns. Runtime does not use autonomous gates, file polling, or duplicate Traces as a waiting protocol. Note Agent delegates no RLM children and therefore does not need this interface.

## Models and Thinking Levels

Environment and Goal settings can override models, so the model selected at runtime is not a documentation contract. Defaults are defined in `TASK_MODEL_ROLE_INFO` in `server/config/settings.ts` for `primeRoot`, `primeChild`, `noteAgent`, and `wikiCurator`; Note Agent exposes its configuration through `server/research/config.ts`.

The intent behind thinking levels is not evident from code: Prime Search Root and the Organizer use medium, Report Writer Root and Report Writer Section children share Prime high, and the Prime Wiki compilation fallback uses medium. The Wiki compilation Pi concept stages pin Terra and medium independently of the Prime Wiki fallback model defaults. The authoritative values for a particular run are in `research-harness-snapshot.json`, its Node Trace, and evaluation artifacts.

Run new validation questions through the real product entry point and capture them as Cases, then complete Candidate Replay and independent review under [Attestation](development/attestation.md). The Operations Interface does not accept new questions as direct inputs. See [Node Evaluation](node-agent-backtest.md) for each Recipe's external-data boundary.
