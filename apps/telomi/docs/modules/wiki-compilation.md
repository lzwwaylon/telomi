# Wiki Compilation

New Wiki Updates use `NoteFirstWikiCompiler`. Research, manual maintenance and recovery share `wiki/update-runner.ts`; publication remains under the existing Goal Workspace publication lock. Old queued Updates without a compiler identity resume through the legacy compiler. Existing published Editions remain readable.

## Construction and input views

1. Runtime validates the frozen Cornell Note Snapshot, structured Goal, active Topic Plan and previous Edition. One Pi Coding Agent using Luna receives one complete bounded Cornell Note, writes object Markdown pages and a manifest with explicit Cue deferrals, and may revise its own files once after field-specific validation feedback. The existing Agent handles oversized or empty Notes. The fair queue runs at most four tasks and replenishes free slots; a failed Note does not cancel other Notes.
2. Object merging resolves drafts and historical objects serially. It reads all unplaced Cues before assigning them to suitable objects or recording a final discard with a reason. Abstract content alone is not a discard reason. Every available Cue is accounted for at the object boundary.
3. Concept planning sees object summaries and historical concepts. It partitions the primary objects into bounded jobs, executed with at most four Workers. Each Worker fully reads its primary objects; auxiliary pages can be explored by relevant sections. Concepts cite evidence accepted by objects, with no independent residual-Cue input.
4. Serial concept merging resolves proposals and historical concepts. A separate relation Agent reviews final objects and concepts, retaining supported object-object, object-concept and concept-concept relationships without a link quota.
5. Topic navigation makes one direct model completion per final object or concept page, using a four-slot fair queue. Each completion receives all Topic definitions and only that page's canonical body split by local section references, including its preamble. Runtime removes internal evidence citation markers from this model-only projection while preserving the canonical body and section-to-evidence mapping. No separate page title, description, kind, other pages, relationships or Cue details are injected. Every section receives an explicit list of matching Topics, possibly empty, with brief section-specific reasons. Runtime resolves the references and aggregates by Topic; no Planner or tool loop runs.

Runtime supplies local P/S/N aliases and resolves persistent identities. The Pi object Agent writes Markdown with title and description frontmatter plus a `result.json` manifest of page paths and explicit Cue deferrals. Runtime reads and validates those files before mapping local Cue references to persistent identities. Other writing Agents author Markdown directly. Each stage submits only its applicable fields. Runtime retains strict evidence, member-disposition, identity and reading checks.

Construction-stage prompts include page titles, descriptions and index paths. Read-only `input/indexes/Pn.json` files expose chapter references and existing incoming/outgoing relation summaries. They contain no page bodies and grant no full-reading receipt. Pages and sections are expanded as needed; rewriting or consuming merge members still requires full reading.

Page Topic completions use the existing authenticated model transport with no Agent session, filesystem tools, Skills or coding-system prompt. The experiment selects openai-codex/gpt-6-luna with medium reasoning. Structured validation requires every input section exactly once and refuses unknown or duplicate references and internal citation markers in reasons. Match decisions require substantive section-level support for the Topic, with faithful plain-prose reasons; keyword overlap and absence of information alone are insufficient. Full body delivery is recorded in the actual request; this path does not fabricate tool-reading receipts. A failed page does not stop other pages, but leaves every Topic incomplete because its memberships are unknown. Accepted page checkpoints are reused on recovery. Per-page classification cannot establish global knowledge gaps, so the compatible gaps field is empty, meaning not assessed rather than complete coverage. Other stages retain their existing Agent tools and progressive metadata views.

Pi object sessions use the fixed Luna model and medium reasoning with only SRT-bound `read`, `write` and `edit` tools. Stable object-selection and file-output rules live in the system Prompt; the user Prompt contains the complete bounded Note as structured data with local N aliases and no durable Entry IDs. Runtime validates every Cue's page citation or explicit deferral with the existing object contract. It returns the exact validation error to the same session for one repair turn, then accepts or fails the Note. The oversized-Note fallback retains the Agent's progressive reads. A failed Note does not cancel other Note tasks, and accepted files are checkpointed for recovery. Semantic completeness remains a review question despite structural Cue coverage.

## Recovery, identity and publication

Model selection and execution semantics are pinned for recovery. Stage checkpoints bind input, registered prompts, bundled Skills, implementation identity, accepted Markdown and reading receipts. Changed contracts cannot silently reuse a previous acceptance.

Partial candidates remain immutable and inspectable. They have `publicationReady: false` and cannot replace the current Edition. New failed Updates can be explicitly resumed within the existing attempt limit, reusing successful checkpoints. Cancellation stops further scheduling. Runtime preserves failed-attempt usage and session records as well as successful outcomes.

Each Update attempt retains its result separately. Successful result records contain the actual immutable knowledge artifact reference, so history can find content-addressed outputs after retries. Publication verifies the current base hash and the complete candidate artifact before atomic replacement.

## Topic Plan changes

Confirming a Topic Plan runs only the page Topic classification queue through `reindex`. It copies the frozen Edition and changes README, Topic Plan and Topic index; object/concept bodies, evidence and semantic relations remain unchanged. Any failed page makes navigation incomplete and prevents publication; successful page checkpoints can be reused on retry. Runtime freezes the publication base hash before execution, and reuses a previously staged artifact only when its hash matches.

## Reading and navigation

`model/navigation.ts` is the shared projection for API, graph and search. The existing graph node ID and API path remain path-based; `pageId` carries the canonical page identity. If `.topic-index.json` exists, it is authoritative even when a page has no Topic membership. Editions without it retain their historical frontmatter membership.

Tree and page responses expose section IDs, headings, anchors and Topic references. `.object-first-relations.json` supplies canonical direction and labels. Readers can follow incoming and outgoing links without creating reverse semantic edges or rewriting Markdown. Direct Topic matches and optional one-hop related pages remain separate; related pages do not increase direct coverage counts. Objects remain accessible without a concept or relationship.

Topic-filtered search uses page membership projected from the section index. It continues to search the full body of matching pages, not only their Topic-selected sections. Snippets and directory counts are navigation aids, not semantic quality scores.

## Verification and evaluation

The formal `wiki-compilation@1` recipe captures complete construction or navigation-only inputs and replays the production implementation. It preserves Notes where applicable, Goal, Topic Plan, previous Edition, models, artifacts and native sessions. Legacy shard/curator Cases and private compilation diagnostics cannot be substituted for this boundary. See [Node Evaluation](../node-agent-backtest.md) and [Attestation](../development/attestation.md).

Tests cover complete-Note queues, Cue ownership, stage contracts, actual SRT Skill loading, full-text delivery, relationship propagation, failed publication, retry, history, navigation and legacy reading. Deterministic tests do not establish factual correctness, complete relation coverage or superior Topic selection.

The earlier shard/curator pipeline remains available for historical recovery and its own Replay recipes; see [Wiki Shard Builder](wiki-shard-builder.md).
