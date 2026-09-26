# Research Agents

## Interface

Main Agent calls `research({ search_question, report_context, note_focus?, report_title?, schedule? })`. `note_focus` says what the Cornell Notes should record in most detail; it reaches only the Cornell Note stage, never Search or the Wiki. `ResearchRuntime.run()` pins the content-version context and executes the sole production path through `Run.run()`.

## Agent responsibilities

| Agent | Runtime | Input | Output |
|---|---|---|---|
| Prime Search Root | Prime Agent SDK | Standalone search question, time, Topic Plan, scheduled context, available Provider Catalog | Root-only general search, Provider routing, Provider child orchestration, and coverage checks |
| Provider child | Prime child Agent | Root-assigned task for one Provider and its Skill | One Candidate Ledger and the required material |
| Source Organizer | Prime Agent | New Sources from this execution, historical ungrouped index, and existing Group summaries | Grouping Patch for new Sources only |
| Cornell Note | Prime Agent | One complete read-only Logical Source, the question, and optional paths of changed members | Cornell Note Sections, Cues, and Evidence line numbers |
| Report Root | Prime Agent | Question, complete report_context, the Run's note_focus as an evidence focus when one was given, frozen Cornell Notes or current Goal Wiki (the Find Out roster names where each Source's Notes anchor their evidence), and a read-only index of this Goal's published historical reports (continuity and comparison context only, not citation sources) | Outline, Editorial Plan, Section assignments, and final revised sections |
| Section child | Prime child Agent | One Section and assigned Source handles or Wiki paths | Draft and Ledger |
| Research Schedule Reviewer | Prime Agent SDK | A Research Schedule's two parameters, recent occurrence results, the previous Review, and rejected Proposals | `no_change`, or one Research Schedule Proposal revising monitoring scope and Report Context |
| Wiki Shard Builder | Two independent Prime Sessions | Goal, Topics, and complete Cornell Notes from the same Source batch | Separate Entity and Concept curation; see [Wiki Shard Builder](wiki-shard-builder.md) |
| Wiki Curator Root | Prime Agent | Draft Shards, compact previous-Edition index, Topic Plan | Workset Plan, native RLM delegation, and repair |
| Wiki Curator Workset child | Prime child Agent | Exclusive Page refs, Cornell Entries, Topic suggestions, and compact indexes of this batch's incoming Pages and the previous Edition's published Concepts (ref/kind/title/description only) | Final Page `result.json`, with exactly one disposition per member ref: consume, retain unchanged, or discard. Delivery requires successful `submit_workset` validation |
| Wiki Relation child | Prime child Agent | Modified page bodies, complete Edition catalog, pinned Concept bodies and Cornell Entries, Topic Plan | Merge decisions across Worksets and published Concepts, merged bodies, and final outgoing edges in `result.json` |

## Responsibility boundaries

The Provider Catalog presented to Prime Search Root is first filtered by the Goal Harness's `allowedSources`, then excludes sources disabled by the user in settings or whose latest Source Connection Status verification requires login or reports failure. Before a Run starts, verification results less than five minutes old are reused; otherwise, sources are verified again. Excluded sources appear only in server logs and are not visible within the Run.

The Provider Catalog comes from source descriptor objects under `server/providers/sources/`, where each source is registered once. Source Service discovers sources automatically from each Source module's `SPECS`. Adding a source requires no changes to a registry, SDK table, or Python list.

Runtime manages Browser resource permissions and lifecycles. Root delegates without occupying a Browser workspace; only Provider children perform Browser operations and retain material. Source Bridge credentials bind to native execution identities, so Root and Child cannot impersonate one another by changing identity fields in requests. Concurrency slots use a shared queue across Goals; Agents need not know the limit.

When a Child reaches a terminal state, the host Runtime consumes framework lifecycle events, revokes permissions, and cleans its Browser workspace. This does not depend on the Child's final reply or an extra release request from the Worker. Cleanup failures are recorded and terminate the affected acquisition execution. A daemon whose exit is unconfirmed retains its slot and cleanup information for later retries. Search-scope termination performs fallback cleanup; late requests cannot recreate a finished workspace. It reopens only when the native lifecycle confirms a subsequent Child round, and acquires another slot only after the prior cleanup completes. Periodic sweeping reclaims expired Agent-controlled sessions with no in-flight commands. Idle sweeping does not preempt sessions that are starting, executing commands, or under user control.

A Wiki Curator Workset child's terminal action is `submit_workset`, not writing a file. Runtime validates the within-group contract on invocation; rejection returns directly to that child's own tool loop. Delivery status binds to the validated bytes, so modifying `result.json` afterward makes it undelivered again. The same rule, "MAIN Pages must not be discarded," deliberately differs between two layers: submission rejects it because only that child still has the context to decide which page should absorb it; aggregation instead retains the Page unchanged because that decision context is gone and invalidating the whole batch costs more than keeping an extra page. Cross-Workset invariants can be checked only at aggregation and remain there.

A Workset member has three possible dispositions: inclusion in an output Page's `member_refs` (the Page replaces it entirely; the contract has no append or partial-edit operation), inclusion in `retained_member_refs` (MAIN Pages only, copied unchanged by Runtime unless final coordination merges that Concept), or inclusion in `discarded_member_refs` (incoming candidates only). Retaining unchanged is necessary because Root brings related MAIN Pages into Worksets for comparison. Without it, a child deciding that a MAIN Page should not merge would have to rewrite it entirely, while `submit_workset` checks preservation of Cornell Entry references and cannot detect detail lost between those references.

After all Worksets deliver, the final relation child decides whether Concepts express the same abstraction. It may merge derived pages across groups, candidates with old pages, and existing duplicate old pages. Merges must preserve the union of every member's cited evidence and substantive differences in their bodies. Entities and pages outside merges are not rewritten at this stage. Conflicts between normalized titles of the same type first return to Worksets for repair, allowing distinct concepts to remain separate through renaming; they cannot be left for the merge-only final stage. Relations are generated from the merged pages. Runtime redirects old references, removes self-loops and duplicate edges, and rechecks page identity uniqueness. Reference preservation is only a deterministic minimum; Attestation still judges incorrect merges and lost facts.

Runtime does not perform semantic filtering, semantic classification, or body generation. See [Telomi Research Runtime](../research.md) for the complete division of Agent and Runtime responsibilities and each Agent's execution contract.

Report Root and Section child outputs are readable only through the current Session manifest. If the manifest is missing, Root and child Sessions are not scanned by filename.
