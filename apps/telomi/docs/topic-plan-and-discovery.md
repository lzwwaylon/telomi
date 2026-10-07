# Goal Topic Plan and Discovery: design rationale

This document records rationale that is not apparent from the code. Current behavior is defined elsewhere: `agents/main/main-agent/skills/topic-plan/SKILL.md` for the Agent, the Topic entries in [`CONTEXT.md`](../../../CONTEXT.md) for terminology, and `server/goals/topic-plan/` for Runtime.

## 1. Design decision

After creating a Goal, the system first generates a Topic outline to discuss with the user instead of immediately deriving the knowledge structure from Source clustering.

Once confirmed by the user, this outline becomes the `Goal Topic Plan`, a shared, lasting agreement about the user's areas of attention within a Goal. Main Agent reads it directly; Research and Wiki executions pin the applicable confirmed revision instead of independently inferring those interests. A published Wiki Edition retains its own revision and may lag the latest confirmed Plan until reindex succeeds.

The Topic Plan expresses the questions the user cares about over time, including each question's intent and scope. Wiki Compilation constructs object and concept pages from supported evidence; Topic classification supplies navigation without making the Plan a domain taxonomy or factual authority.

The system also maintains a `Discovery Inbox`. Material that the current Topic Plan does not adequately cover, that may extend current understanding, or that conflicts with existing conclusions first becomes a `Discovery Candidate`. Discovery is a pending-review state, not a permanent `Unknown` Topic, and does not directly become a Wiki directory.

## 2. Why clustering alone is insufficient

Clustering only newly acquired material loses user intent:

- Similar content may not concern the questions the user actually cares about.
- A question the user cares about may span materials with little lexical similarity.
- Clustering can produce many fragmented, local topics.
- Making clusters broader to reduce fragmentation can produce overly broad topics.
- A new Source batch may change cluster boundaries, continually shifting Wiki navigation.
- Clustering cannot distinguish what the user already knows, what they do not care about, and a new direction worth proactively presenting.

Model-based clustering may still discover duplicate candidates or suggest new directions, but must not be the sole authority for a Goal's topic structure.

## 3. Domain boundaries

| Object | Represents | Does not own |
|---|---|---|
| Goal Topic Plan | The user's lasting directions, questions, and scope within the Goal | Factual identity or knowledge admission |
| Goal Topic | One stable lens of user attention | A Concept, Entity, or exclusive category |
| User Memory | User preferences, history, and state of understanding | Domain facts or Wiki knowledge admission |
| Cornell Note | Question-relevant reading notes from a Source, with precise Evidence | The final knowledge structure |
| Concept / Entity | A domain concept or stable knowledge object | User-attention directions |
| Wiki Page | Readable knowledge maintained from Cornell Notes | Authoritative Topic Plan storage |
| Wiki Section | A chapter of a Wiki Page's body that may support zero or more Goal Topics | Authoritative Topic Plan storage |
| Discovery Candidate | Potential new knowledge outside the current attention framework | A permanent miscellaneous category |

Topics and knowledge objects have a many-to-many relationship: one Cornell Note or Wiki Page can relate to several Goal Topics, different Notes within one Source can belong to different Topics, and one Goal Topic can cover multiple Concepts, Entities, and Pages.

Topic changes do not change Cornell Evidence identity. Wiki Topic reindex publishes new navigation while preserving page bodies, identities and recorded relationships. The same knowledge identity must not be duplicated within one Edition.

## 4. Discovery assumptions

The system cannot prove that a piece of knowledge is unknown to the user. A `Discovery Candidate` is an evidence-backed finding relevant to the Goal that the Note Agent judges is not adequately represented by the current Topic Plan. The finding may extend or challenge the user's understanding, but does not establish what the user already knows.

Likewise, "no matching Topic" does not imply "new knowledge for the user." The Note Agent judges the supplied Source evidence against the Goal and active Topic Plan; it does not receive the current Wiki or Discovery history for a global novelty check. Runtime retains validated findings and prevents exact dismissed duplicates. Broader interpretation belongs to Main Agent's subsequent conversation with the user.

Dismissing a Candidate closes only that Candidate, without creating a semantic exclusion rule. Runtime deterministically prevents a dismissed Candidate with the same finding and Evidence from reentering the Inbox; new Evidence or conflicts may still form a new Candidate. When the user asks to stop following a category, revise the relevant Topic's scope or remove that Topic through the user-confirmation flow.

Every Candidate retains its finding, supporting Cue Note and Evidence, the Topic Plan revision under which it was produced, and its creation and handling state. The Note Agent does not assign related Topics to a Candidate. Discussion can lead into the ordinary Topic Plan revision and confirmation flow; dismissal closes the Candidate without changing the Plan.

Source links in the Inbox are a read-only projection of each Candidate's pinned Run and Logical Source members that its Evidence actually cites. They do not rewrite historical Candidates or imply that every member of a grouped Source supports the finding. Missing historical Source metadata leaves the Candidate available for discussion and dismissal.

## 5. Three easily broken decisions

- **Agents do not transcribe Topic IDs.** A canonical Topic ID uses the `topic_` prefix followed by 20 hexadecimal characters. One mistyped character produces an unknown Topic and wastes a repair attempt. Agents that write Topic associations (Note Agent and Wiki Topic classification) read and write short Refs such as `T1` and `T2`; Runtime maps them back to canonical IDs when reading results. Agent-visible input files also contain only short Refs. When validation rejects a Topic reference, it must return the valid short-Ref set so the repair turn does not have to guess again.
- **Semantic files do not express revision relationships.** The Topic document maintained by the Agent contains only `topics` and Runtime-confirmed `id` values, with no redirect, parent, priority, status, or version fields. Deleting a Topic means removing it from the array. Revision relationships exist only in the outer metadata of the append-only history; do not add them to the semantic file for traceability.
- **A confirmed revision is not rolled back when activation succeeds but subsequent processing fails.** The Proposal is recorded as a failed reframe. The user can continue by calling the same confirmation endpoint through the Activity's existing Wiki-retry action. If the process stops midway, startup recovery likewise turns a confirmed Proposal without a reframe record into a retryable failure. Confirmation notifications are deduplicated by the existing event text in the Goal log, so retries complete only unfinished processing.
