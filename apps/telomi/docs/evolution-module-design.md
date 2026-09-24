# Evolution Module

## Scope

Only the `prime-search/browser-provider` Target is currently enabled. Provider Environment, Wiki, and Podcast can be replayed as ordinary Node Cases by an external evaluation environment, but do not participate in automatic Evolution inside the product.

Evolution changes only the Browser Skill override for a single Goal:

```text
<goal>/skills/prime-search/prime-browser-provider-skill
```

It does not change bundled Skills, the Agent Bundle, Telomi source code, or capabilities shared across Goals. The Evaluation composition root installs the Evolution Runtime in every instance, whatever its [evaluation role](node-agent-backtest.md#operating-modes-and-operations-listener). Without full capture, the instance still captures the Prime Search Cases this Target counts, and nothing else.

## Triggers

The counting unit is a completed Browser Provider child execution. An execution qualifies only if:

- Its `provider_id` is `browser`.
- Its `terminal_status` is `valid_bundle`.
- Its Prime Search Case was successfully captured and retains the child's complete task, model, initial Workspace identity, and launch context. Historical executions missing these inputs do not enter automatic batches.
- Its Research Run has reached a terminal state.
- No previous Evolution Run for that Goal has consumed it.

Consumption depends on whether the evidence was actually tested. Running or cancelled Runs reserve their batch; a settled Run must have started Candidate Replay in at least one round. A Run that never started a round has tested nothing about that evidence, so its batch returns to the pool. The same batch may be retried this way at most once, preventing endless resubmission while the environment remains broken.

Each batch selects the earliest three executions from three distinct Prime Search Cases. Each execution is consumed once, batches do not overlap, and at most one Browser Evolution runs per Goal at a time. A complete next batch accumulated during execution starts immediately after the current Evolution settles. After a process restart, the cursor is reconstructed from persisted Evolution Runs.

## Effective Skill

The default Skill is at:

```text
apps/telomi/agents/research/prime-search/skills/prime-browser-provider-skill
```

A Goal Skill with the same name completely overrides the bundled Skill. Evidence, Replay, and Apply all record the effective Skill Hash. The Provider child's execution conditions must also prove that it loaded that same Hash.

Evolution edits the complete Skill, usually by adding guidance for specific scenarios under `references/` and a progressive-disclosure index in `SKILL.md`. Rules must describe classes of scenarios, not bind to one URL, site name, keyword, or Case.

## Inner Loop

`agents/evolution/browser-skill-evolution/` is the bounded Evolution Agent. It receives one restricted Tool:

```text
run_browser_replay
```

Mounted Evidence contains only the selected children's frozen inputs, own Traces, execution conditions, Candidate Ledgers, and material. Evidence from the parent Root, Organizer, and other children is not visible to the Agent. Failed replays preserve the same boundary.

The Tool can use only the three `provider-child@1` Cases pinned for this Run and the current Candidate Skill. Each call directly replays those three children with their original tasks and initial Workspaces, without Root planning or an Organizer. Replaying the entire stage is not a gate for automatic application. Each call writes immutable Round Evidence; a failed call still consumes a round. Each Evolution Run allows at most three rounds.

A changed reference is one whose bytes differ from the baseline, whether newly added or rewritten. Checking only paths would allow a Skill to grow but would never activate rewritten references. If the Candidate changes no reference, activation cannot be proven: the call is rejected before Replay starts, writes no Round Evidence, and consumes no round.

Runtime performs only deterministic hard checks:

- All three Candidate Replays complete and pass the output contract.
- Each Replay actually loads the Candidate Skill Hash.
- Each Replay's Browser child Trace can be located.
- Each changed reference is read by at least one Browser child through an actual read Tool call.
- Prime has only IPython and RLM, with no native read Tool. Skills and references are read through `research_runtime.read_skill` over the Runtime bridge. Runtime reads the bytes itself and appends a `skill_read` receipt (child execution ID, path, and content Hash) to execution-conditions.jsonl. Activation must correlate the same Browser child's receipt, path, and frozen Candidate reference file Hash. Ordinary Python output, path mentions, and failed reads do not count. A rewritten reference therefore requires a receipt with its rewritten Hash; reading the baseline version does not count.
- The final Skill has the same Hash as the Skill used in the last Replay round.
- The Agent explicitly returns `confirmed`.

Runtime does not judge whether the semantics improved. If the Agent cannot confirm improvement, it returns `no_change`; no Goal override or Apply Receipt is created.

`no_change` covers both "tested and judged not worth changing" and "unable to test even one round." Runtime appends the number of rounds that actually completed Replay to the summary so these outcomes remain distinguishable.

Round Evidence is published to the Run record as soon as it is persisted, so an ongoing Run exposes completed rounds and their gate results. The conclusion and summary are written with the terminal state and remain absent before that: a running Run has no conclusion.

## Automatic Application and Recovery

After confirmation, application proceeds in this order:

1. Write immutable `apply-intent.json`.
2. Copy the Candidate to `.evolution-incoming/` on the same volume and verify its Hash again.
3. Synchronously move the old override to the Run's `before/` directory.
4. Synchronously move the Candidate to the Goal override.
5. Write immutable `apply-receipt.json`.

The supported deployment is local and single-process. Both synchronous renames occur within one JavaScript turn, so requests cannot observe the intermediate window. If the process exits between the renames, startup recovery uses the intent, `before/`, and current Skill Hash to complete or roll back application before listening. This guarantees single-process application atomicity and crash recovery, not a multi-process filesystem transaction.

The old override remains in `before/`. If the Goal previously used the bundled Skill, recovery removes the Goal override.

## Evolution Cases and Outer Replay

With full capture (`TELOMI_EVAL_CAPTURE=1` or an Eval Instance), every terminal Browser Evolution attempts Capture. The default role captures no Evolution Case:

- `applied` and `no_change` produce Quality Cases.
- `failed` and `cancelled` produce Recovery Cases without Observed output.
- Missing Agent Traces, required inner Artifacts, Browser Traces, or Hashes cause Capture to fail; no reviewable Case is produced.

Case Input pins three independent Provider Child Cases, three execution identities, the effective baseline Skill, the objective, acceptance criteria, and a three-round budget. Candidate outer Replay reruns the complete Evolution in an isolated Goal without changing the real Goal. `evolution@2` accepts only these self-contained child Cases. Old parent-Case inputs cannot fall back to whole-stage Replay and must be captured again.

Confirmed output includes:

```text
evolution.json
apply-receipt.json
skill/
rounds/<round>/<case>/artifacts/
rounds/<round>/<case>/traces/
```

`no_change` has no Receipt, and `skill/` must contain the original baseline rather than an unadopted draft. Metrics include Tokens, Cost, Duration, Turns, and Tool Calls for both the Evolution Agent and its inner Replays.

A Candidate Evolution Agent can rerun a failed Evolution Recovery Case. Success goes directly to the completed Recovery state without producing an A/B Pair.

## Judgment Boundary

Telomi only executes Candidate Replay and generates anonymous Pairs. It neither accepts nor stores Judgments and does not generate semantic Summaries. The external evaluation environment stores Rubrics, independent Judgments, and Attestations, and presents Evolution A/B Skills, Scripts, reference activation, Artifacts, Traces, and metrics.

Goal-scoped Browser Evolution may apply changes automatically after deterministic hard checks pass. This is a restricted exception to the repository's Agent release rules. Those checks prove only that changes took effect and were executed, not that they improved behavior. Automatic application also relies on the Agent's own semantic `confirmed` judgment, which Runtime does not validate. Changes to the Evolution Agent, its Prompt, its Tools, or the bundled Skill itself must still follow [Attestation](development/attestation.md#merge-and-release-acceptance).
