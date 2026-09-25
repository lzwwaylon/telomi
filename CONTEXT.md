# Research Harness

This context defines the shared language for ordinary research execution and controlled evolution of reusable research capabilities in Telomi.

## Cross-System Presentation

**Activity**:
A user-understandable view of one bounded piece of Telomi system work, while the underlying Run, Evolution Run, Memory Reflection, or Subagent chain retains its own domain identity. A recurring declaration is not an Activity; each execution it starts is a separate Activity.
_Avoid_: generic process, job, task, Run, recurring schedule

**Activity Step**:
One user-understandable part of an Activity, including its state and relationship to other Activity Steps.
_Avoid_: Stage, Node Execution Record, lifecycle event

**Agent Activity**:
One bounded Agent execution presented under an Activity Step, with its own state, summary, and inspectable output. It is not a top-level Activity or a Trace.
_Avoid_: Activity, Tool call, Agent role, Trace

**Activity Attempt**:
One execution attempt within an Agent Activity. A retry adds an Activity Attempt while preserving the identity of the Agent Activity.
_Avoid_: new Activity, Agent Activity, infrastructure log

**Activity Lifecycle**:
The current position of an Activity or Activity Step in its lifetime: queued, running, waiting, or finished. Waiting always carries a reason.
_Avoid_: outcome, success, failure, overloaded status

**Activity Outcome**:
The terminal result of a finished Activity or Activity Step: succeeded, no change, skipped, cancelled, or failed.
_Avoid_: lifecycle, running state, overloaded status

**Activity Attention**:
A presentation state indicating that an Activity currently needs a user decision, credential, or input, or has an unhandled failure with a meaningful next action. Running, queued, succeeded, and no-change Activities do not need attention by themselves. A failure the user dismissed is handled and stays in history as failed; the same Activity failing again needs attention again.
_Avoid_: notification, unread state, failure outcome, lifecycle

**Activity Projection**:
The cross-system read model that presents authoritative domain execution facts as Activities and Activity Steps without becoming an execution or persistence authority.
_Avoid_: unified Runtime, replacement Trace, frontend inference

## Audio Presentation

**Podcast Script**:
A single-narrator spoken editorial adaptation of a Canonical Report that may reorder and condense material while preserving its supported meaning.
_Avoid_: dialogue script, verbatim narration, TTS transcript

**Podcast Preference**:
A durable User Preference governing how Podcast Scripts are expressed, such as language, length, information density, explanation depth, or tone, without changing the Canonical Report's factual boundary.
_Avoid_: report instruction, episode feedback, Podcast fact

**Podcast Generation Instruction**:
A user instruction that overrides Podcast Preferences for one Podcast generation without becoming a durable default.
_Avoid_: Podcast Preference, Artifact Feedback, prompt injection

**Podcast Generation Brief**:
The immutable per-generation combination of the applicable Podcast Preferences and one Podcast Generation Instruction supplied to a Podcast Writer alongside one Canonical Report.
_Avoid_: mutable preference profile, complete User Memory, Podcast feedback history

## Execution Model

**Telomi Research Runtime**:
The Runtime-owned system that executes Runs with a pinned Research Harness while coordinating Agents, Tools, validation, persistence, and publication.
_Avoid_: AgentDisco Runtime, Research Agent, Research Harness

**Preference Evidence**:
A provenance-preserving explicit user statement used to publish a Goal-scoped User Preference.
_Avoid_: inferred behavior, prediction, raw UI telemetry

**User Preference**:
A confirmed, scope-aware statement about how the single user wants responses or artifacts produced, supported by but distinct from Preference Evidence.
_Avoid_: Preference Evidence, Profile fact, inferred behavior

**Goal Preference**:
A User Preference whose authority is limited to one Goal.
_Avoid_: Global Preference, Goal instruction, copied Global Preference

**Preference Subject**:
The stable aspect of a Goal-scoped response that a User Preference governs, such as table usage; its desired value may change over time.
_Avoid_: Preference value, response-format fact

**Global Preference**:
A User Preference explicitly confirmed for use across Goals.
_Avoid_: automatically generalized preference, Global User Profile, cross-Goal evidence

## Storage Model

**Storage Zone**:
One of the four areas with a distinct lifetime, sharing boundary, and write authority in the research system.
_Avoid_: 工作区, 共享目录

**Goal Wiki**:
The current published Wiki Edition for one Goal, grounded in provenance-valid Cornell Evidence. It is a derived knowledge product rather than the authority for historical evidence; user preferences and user memory remain outside it.
_Avoid_: Goal Knowledge Memory, User Memory, Published Artifact Store

**Cornell Evidence Corpus**:
The durable cross-Run collection of provenance-valid Cornell Notes from which Wiki Editions are curated. Historical Topic refs are revision-scoped editorial suggestions, not current routing authority.
_Avoid_: Wiki Edition, Topic Index, authoritative Topic assignment

**Wiki Edition**:
One immutable version of the Goal Wiki curated for one confirmed Goal Topic Plan revision from the Cornell Evidence Corpus and an optional previous Wiki Edition.
_Avoid_: permanent canonical page tree, Topic Projection, mutable Wiki

**Wiki Curator**:
The Agent module that creates the next Wiki Edition by deciding Concept and Entity identity, page boundaries, prose, relationships, evidence retention, and current Topic membership.
_Avoid_: Wiki Router Agent, Topic Projection Agent, per-batch publisher

**Wiki Curator Operation**:
The Runtime-selected scenario for one Wiki Curator execution: initialize without a previous Edition, update under the same Topic Plan revision, or reframe after the Topic Plan changes.
_Avoid_: Agent role, semantic Runtime rule, independent pipeline

**Wiki Update**:
One bounded execution that incorporates a validated Cornell Note Snapshot into a Goal Wiki and publishes its own result. It has an independent lifecycle even when a Research Run, Main Agent, schedule, or ingestion flow triggers it.
_Avoid_: Research Stage, Wiki Page edit, background side effect

**Wiki Update Request**:
An immutable request to run one Wiki Update from a specific validated input, with its trigger and optional parent Activity preserved as provenance.
_Avoid_: raw Markdown mutation, Research Run continuation, Wiki Maintainer prompt

**Batch Wiki Shard**:
An immutable, unpublished Wiki draft built from one bounded Source batch and used only as internal input to one Wiki Curator execution.
_Avoid_: Goal Wiki, Source Bundle, published Wiki revision

**Wiki Curator Workset**:
An exclusive set of existing and draft Pages that the Wiki Curator must resolve together while creating one Wiki Edition.
_Avoid_: Source Group, related Pages, broad topic cluster

**Goal Topic Plan**:
The Goal-scoped, revision-tracked statement of the user's long-term areas of attention, including each Goal Topic's intent, questions, and scope. It guides research, Note extraction, navigation, and monitoring without becoming a domain taxonomy or factual authority.
_Avoid_: Wiki section tree, Research Task outline, fixed taxonomy

**Topic Plan Confirmation**:
The explicit user decision that appends the Topic Plan Revision to the Goal's append-only history and activates it as the Goal Topic Plan. Agent discussion and edits to the draft file never imply confirmation.
_Avoid_: Agent approval, automatic activation, draft acceptance

**Topic-Ready Goal**:
A Goal with an activated, user-confirmed Goal Topic Plan and no user-requested revision awaiting confirmation. Discovery Candidates awaiting discussion do not revoke readiness; only a Topic-Ready Goal may start Research Runs or create and execute Research Schedules.
_Avoid_: Goal with a draft Topic Plan, Goal with a pending Proposal

**Goal Topic**:
A stable user-attention lens within a Goal Topic Plan. It may reference many Cornell Notes and Wiki Pages, and one Note or Page may reference many Goal Topics.
_Avoid_: Concept, Entity, Wiki Page, Report Section, exclusive category

**Goal Topic ID**:
The Runtime-owned identity assigned when a Goal Topic is first confirmed and retained in every later revision where that same Topic persists. Agents preserve existing Goal Topic IDs but never create or change them.
_Avoid_: Topic title, draft identifier, Topic Plan revision

**Topic Patch**:
A Runtime-internal difference derived from the semantic Topic Plan document, such as adding, updating, or removing Goal Topics between confirmed revisions.
_Avoid_: Main Agent interface, direct Wiki rewrite, Ontology migration, untracked prompt edit

**Topic Plan Proposal**:
An auditable candidate represented by the unconfirmed semantic Topic Plan draft and its Runtime-derived difference, awaiting user confirmation.
_Avoid_: active Topic Plan, direct Topic mutation, Wiki rewrite

**Topic Plan Revision**:
One user-confirmed, content-hashed entry in the Goal Topic Plan's append-only history that downstream Runs freeze and consume by identity.
_Avoid_: Topic Plan Proposal, mutable current preferences, prompt snapshot

**Wiki Navigation**:
The deterministic Topic, Concept, Entity, and Page index rendered from one completed Wiki Edition. It has no semantic write authority.
_Avoid_: Wiki Topic Projection, Topic assignment Agent, knowledge authority

**Discovery Candidate**:
An evidence-linked finding that is not adequately covered by the active Goal Topic Plan or that may materially extend or contradict the user's current Goal understanding. An open Candidate may be discussed with the Main Agent through ordinary Goal conversation or dismissed by the user; it is not a permanent Goal Topic, Wiki section, or independent decision workflow.
_Avoid_: miscellaneous bucket, rejected Note, guaranteed user novelty, Unknown Topic

**Discovery Inbox**:
The Goal-scoped collection of open Discovery Candidates awaiting user discussion or dismissal. Discussion may lead into the normal Topic Plan Proposal and confirmation flow, but the Inbox does not decide Topic membership itself.
_Avoid_: Wiki section, unclassified data dump, notification feed

**Discovery Resolution**:
The retained terminal record explaining why a Discovery Candidate closed: the user dismissed it, or a user-confirmed Topic Plan change covered it. Dismissal applies only to that Candidate and does not silently create a semantic exclusion rule.
_Avoid_: Discovery preference, negative Topic, automatic similarity filter

**User Memory Service**:
The independent authority for user preferences and user memory. Its information is not stored in or generated by the Goal Wiki.
_Avoid_: Goal Wiki, Wiki Source, Wiki Page

**Topic-Linked User Memory**:
A Goal Preference or Goal Understanding that optionally references Goal Topic refs bound to a confirmed Topic Plan revision and Wiki Page or Claim identities. Raw Memory Episodes do not require Topic assignment, and these links never make User Memory a source of Goal knowledge.
_Avoid_: Topic-tagged chat archive, Wiki fact, automatic keyword classification

**Goal Understanding**:
A Goal-scoped, time-varying statement about what the user currently understands in relation to that Goal.
_Avoid_: objective Goal knowledge, permanent user trait, inferred expertise score

**Memory Episode**:
An immutable, timestamped user interaction or feedback event submitted to the User Memory Service as provenance for temporal extraction.
_Avoid_: Memory Fact, chat summary, mutable Profile

**Memory Fact**:
A temporal, source-linked statement extracted from one or more Memory Episodes and returned as a candidate for Agent judgment.
_Avoid_: current instruction, authoritative command, raw chat message

**Memory Scope**:
Whether a Memory Episode is recalled only in the Goal it came from, which is the default, or in every Goal because the user made it global on the Memory page. Nothing makes an Episode global automatically, and only the user curates User Memory: Agents read it through recall and never write, edit or delete it.
_Avoid_: user-level memory, automatic global preference, Agent-curated memory

**Run Context Snapshot**:
The immutable Runtime identity that binds the Telomi code version, Runtime configuration, Workspace commit and snapshot, Goal Knowledge hash, and evidence schema for one Run.
_Avoid_: `/context` mount, mutable Profile, unversioned prompt context

**Source Connection Status**:
The Runtime-verified state of one external source, established by probing the credential or browser login it runs on at startup, daily, and on request, and shown per source in settings. It reports whether the source works, needs a login, failed, or is unconfigured; it never carries the credential.
_Avoid_: Provider health score, credential value, Search Execution Record

**Wiki Source**:
A Runtime-owned durable snapshot of user-provided material or externally acquired material, with provenance sufficient to verify derived knowledge.
_Avoid_: Wiki Page, user preference, user memory, legacy Wiki data

**User-Provided Wiki Source**:
A Wiki Source whose original material the user deliberately supplied or directly selected for ingestion.
_Avoid_: chat message, user memory, Acquired Wiki Source

**Acquired Wiki Source**:
A Wiki Source collected from an external Provider for a Research Task and retained by Prime Search.
_Avoid_: Provider child ledger, User-Provided Wiki Source

**Source Snapshot**:
One immutable, provenance-bound Source represented as an arbitrary file tree, such as a repository, parsed document, transcript set, or Markdown file.
_Avoid_: Source Bundle, Logical Source, Wiki Page

**Source Bundle**:
An immutable indexed container holding Provider Source Snapshots published by Prime Search.
_Avoid_: Source Snapshot, Logical Source, Wiki input file

**Canonical Source Document**:
The normalized readable representation of one document-shaped Source. Arbitrary Source Snapshots such as repositories do not need to collapse into one Canonical Source Document.
_Avoid_: Source Snapshot, Logical Source, Wiki Page

**Wiki Page**:
A published Concept or Entity Markdown page maintained from Cornell Notes and linked to its supporting Note entries.
_Avoid_: Cornell Note, raw Source, factual authority without citations

**Wiki Maintainer**:
Legacy name for the Wiki Curator or its internal draft children. New interfaces and Activities use Wiki Curator.
_Avoid_: current domain term, Source Organizer, Report Writer

**Wiki Index**:
A Runtime-owned, rebuildable search projection derived from one fixed Goal Knowledge release, including its Sources, Entities, Claims, and Wiki Pages.
_Avoid_: Wiki, 权威知识库

**Published Artifact Store**:
The Run-scoped shared area containing immutable stage outputs that Runtime has validated and made available to downstream Agents.
_Avoid_: Wiki, 共享草稿目录

**Worker Workspace**:
The private mutable execution area assigned to one Agent, including its working files and code execution state.
_Avoid_: Shared Workspace, Goal Knowledge Memory

**Runtime Control Store**:
The authoritative area for manifests, ledgers, checkpoints, Tool submissions, validation results, and pinned identities.
_Avoid_: Wiki, Agent Workspace

## Scheduled Research

**Research Schedule**:
A Goal-scoped durable declaration that requests a new research report on a recurring cadence.
_Avoid_: cron job, continual workspace, recurring Run

**Scheduled Research Run**:
One bounded Run initiated for a due Research Schedule and expected to publish its own Canonical Report when qualifying input exists.
_Avoid_: continual Run, feed fetch, resumed Agent session

**Research Schedule Reviewer**:
The fresh read-only Agent that, when Runtime conditions are met, judges from the User Memory Service, the Goal Wiki and prior Run history whether an existing Research Schedule still declares what the user cares about, and either reports no change or produces one Research Schedule Proposal.
_Avoid_: Main Agent, Search Planner, headless Main Agent session, per-occurrence planner

**Research Schedule Proposal**:
An auditable candidate revision of one Research Schedule's monitoring scope and Report Context, awaiting explicit user confirmation. At most one open Proposal exists per Schedule; a newer Proposal supersedes it. Scheduled Research Runs keep using the confirmed Schedule until confirmation.
_Avoid_: per-occurrence Brief, automatic Schedule update, Agent approval, Topic Plan Proposal

**Research Schedule Review**:
The retained record of one Research Schedule Reviewer execution and its outcome: no change, or the Proposal it produced.
_Avoid_: Trace entry only, Scheduled Research Run

## Report Planning

**Evidence Need**:
A task-level statement of what information is required, why it matters, and what would make the evidence sufficient.
_Avoid_: search query, Provider request, evidence result

**Search Batch**:
The Provider children and retained Sources produced by one Prime Search Root before Source validation and organization.
_Avoid_: Cornell Note pool, shared child workspace

**Prime Search Root**:
The Agent that derives Evidence Needs from the Search Question, resolves discovery prerequisites, and delegates bounded tasks to Provider Children, including multiple tasks using the same Provider. It is the only Agent permitted to call general search.
_Avoid_: Source Organizer, Runtime downloader, separate planning Agent

**Provider Child**:
An isolated Prime child that searches one Root-selected Provider and writes its Candidate Ledger and acquired material for the assigned evidence scope.
_Avoid_: one Agent per result, cross-Provider organizer

**Search Execution Record**:
The Runtime-owned objective ledger of Provider operations, requests, response and source counts, provenance, errors, timeouts, and budget exhaustion for one Search Attempt.
_Avoid_: SearchWorker self-assessment, semantic sufficiency score

**Stage Context View**:
The fixed, read-only set of Wiki, evidence, and prior-artifact snapshots exposed to one Agent stage.
_Avoid_: mutable Workspace, global context dump

**Main Agent**:
The persistent per-Goal Pi Coding Agent that answers from current Goal knowledge or calls the full Research Runtime through the `research` Tool.
_Avoid_: Search Planner, Research Runtime, one-shot task normalizer

**Search Question**:
The standalone incremental retrieval task Main Agent passes to the `research` Tool as `search_question`. It names the missing evidence and update scope so earlier research is not repeated. Prime Search Root derives evidence coverage from it directly.
_Avoid_: Runtime-generated rewrite, report brief, continuation route, report outline

**Report Context**:
The complete report brief Main Agent passes to the `research` Tool as `report_context`: user objective, audience, prior knowledge, format, depth, and language. Runtime persists it verbatim and passes it through to the Report Agent, which cannot see the conversation.
_Avoid_: Search Question, Runtime summary, report outline

**Source Organizer**:
The fresh Prime Agent that incrementally assigns newly observed or previously ungrouped Source Snapshots to evidence-backed Canonical Source Groups while preserving established Group membership.
_Avoid_: Prime Search Root, Wiki Maintainer, deterministic Runtime grouping

**Canonical Source Group**:
A durable Goal-scoped identity joining Source Snapshots from distinct Providers only when they directly represent the same canonical research object.
_Avoid_: topic cluster, model family umbrella, dependency group, Logical Source revision

**Logical Source**:
A question-processing input that immutably snapshots the current revision of one Canonical Source Group or one justified ungrouped Source Snapshot.
_Avoid_: Provider result, Source Bundle, Cornell Note

**Cornell Reading**:
One question-scoped interpretation of one Logical Source revision produced by a Cornell Note Agent; a later question may require a new Reading of unchanged Source evidence.
_Avoid_: Source Snapshot summary, reusable final answer, Wiki Page

**Cornell Note Agent**:
The fresh Prime Agent that reads one complete Logical Source and records question-relevant Sections, Cue Notes, and exact Source line references.
_Avoid_: global answer writer, relevance grader, Wiki Maintainer

**Cornell Note Snapshot**:
The immutable cumulative set of Runtime-validated Cornell Notes for one Run revision.
_Avoid_: mutable note store, Source Bundle, final report

**Report Outline**:
The title and ordered Sections chosen after evidence exists by the Full Report Writer Root or the explicit report-outline Agent evaluation path.
_Avoid_: evidence coverage, Provider assignment, draft prose, fixed Note assignment

**Executable Report Plan**:
The Runtime-validated report structure with stable Section IDs, materialized from a supplied Outline or reconstructed from the Writer manifest.
_Avoid_: editorial plan, mutable outline

**Full Report Writer**:
The fresh Prime Root that normally chooses the report structure from the task and frozen Notes, delegates exactly one draft per Section, then continues in the same Session to revise all drafts into final Section files.
_Avoid_: Runtime concatenator, independent Section-only writer

**Writer Output**:
The schema-validated JSON containing each required Section ID and its body Markdown exactly once.
_Avoid_: Canonical Report, numbered citations

**Accepted Chapter**:
A Section body that Runtime materialized from validated Writer Output and published as an immutable checkpoint.
_Avoid_: editable shared draft, final report

**Evidence Reference**:
A Runtime-validated retained Evidence record used to support report content.
_Avoid_: arbitrary URL, final citation number

**Citation Compilation**:
The deterministic Runtime transformation from validated inline Evidence URLs into linked citations numbered once per Source URL and one References section that lists each Source once.
_Avoid_: citation writing Agent, semantic review

**Canonical Report**:
The citation-compiled Markdown report that is the authoritative published content output of a Run.
_Avoid_: Writer JSON, HTML render, slide deck

**Stage Submission**:
An argument-free Agent declaration that the current stage fixed-path artifact is ready for Runtime validation.
_Avoid_: publication, acceptance decision

**Terminal Run Failure**:
The Runtime-owned outcome when required stage output, citation contracts, or publication checks cannot be satisfied.
_Avoid_: partial report publication, low subjective quality score

## Evaluation

Goal-scoped Browser Skill Evolution has its own vocabulary and constraints in
[`apps/telomi/docs/evolution-module-design.md`](apps/telomi/docs/evolution-module-design.md); it is not repeated here.

**Run**:
A bounded execution of a user task using the released Harness capabilities without changing those reusable capabilities.
_Avoid_: generic Execution, Evolution Run, Harness 修改

**Unified Research Trace**:
The immutable Run-level sequence of Runtime and Agent node executions, preserving each node's decision-relevant inputs, outputs, dependencies, status, and links to detail evidence.
_Avoid_: merged Agent transcript, Run Overview, Trace Index

**Node Execution Record**:
One terminal execution fact within a Unified Research Trace for a single Runtime or Agent node.
_Avoid_: lifecycle log line, Agent Session, Stage summary

**Node Evaluation Case**:
An immutable evaluation case anchored to one Agent Node Execution Record that preserves or references the complete pre-node state, original terminal evidence, production executor identity, validation contract, and Runtime constraints needed to execute that node again with a Candidate Harness. It may represent a successful execution or a failure deterministically attributed to the Harness. Restoration fixes the node's captured starting conditions; each Node Replay Recipe defines whether external inputs are frozen or freshly queried.
_Avoid_: recorded Tool-response cassette, complete Run replay, generic prompt fixture

**Node Case Input**:
The immutable business input and pre-node state restored from one Node Evaluation Case, excluding the Prompt, Skill, Tool, and other reusable Agent capabilities being evaluated.
_Avoid_: complete Workspace, Candidate Capability Bundle, historical output

**Candidate Capability Bundle**:
The immutable version of the target Agent's Prompt, Skill, Tool, and allowed supporting capability files used for one Candidate Replay.
_Avoid_: Node Case Input, mutable Workspace, Observed Baseline

**Node Replay Recipe**:
The versioned deterministic Runtime recipe owned by one evolvable Agent node type that restores a Node Evaluation Case, invokes the same production execution path and validation contract with a selected Harness, and publishes the resulting evaluation artifacts for blind review in the external evaluation environment. It is Runtime code, not an Agent.
_Avoid_: per-node Agent, generic AgentStageRequest serializer, Eval Agent

**Observed Baseline**:
The original terminal evidence from the Node Execution Record referenced by a Node Evaluation Case, including either its validated output or its rejected or partial output, Validation Report, error, trace, and metrics. Candidate evaluation compares against this historical fact and does not execute a fresh Baseline sample.
_Avoid_: freshly sampled baseline, Candidate output, historical Tool-response replay

**Candidate Replay**:
An execution of fixed Node Case Input through its Node Replay Recipe with the target Agent's Candidate Capability Bundle substituted. Output content is expected to vary; Runtime only requires each Replay to pass the same structural and safety contract as production. Repetitions guard against one lucky sample.
_Avoid_: complete Run replay, one lucky sample, Observed Baseline

**Node Backtest**:
The manual evaluation of Candidate Replay outputs against their historical Observed Baselines over one fixed Case set and Rubric. Judgment lives in the external evaluation environment, not in Telomi.
_Avoid_: fresh Baseline execution, automatic Eval Agent, output hash comparison

**Attestation**:
The release path every Agent, Prompt, Skill, and Tool change must complete before it ships: replay of real historical Cases in the external evaluation environment, blind review of the resulting Artifacts and Trace, and an independent Judgment by a human or a Coding Agent other than the Candidate Author. Deterministic checks are evidence within it, never a substitute for it.
_Avoid_: deterministic test suite, Hook check, automatic Eval Agent, self-review by the Candidate Author

**Node Evaluation Eligibility**:
The deterministic Runtime decision to capture a node as a Case. Failed and cancelled executions may be captured as Recovery Cases when their terminal evidence is available; capture does not establish semantic quality or eligibility for automatic Evolution.
_Avoid_: Analysis Agent opinion, every terminal failure, evolution trigger

**Evaluation Case Capture Status**:
The mandatory Node Execution Record field that reports whether an eligible Agent node's Node Evaluation Case was captured, failed capture with a reason, or was ineligible with a reason. Capture failure does not discard a completed Research result, but the affected node cannot be replayed and any Evolution that requires it is blocked.
_Avoid_: silent best effort, Research Run failure, missing Case interpreted as legacy success
