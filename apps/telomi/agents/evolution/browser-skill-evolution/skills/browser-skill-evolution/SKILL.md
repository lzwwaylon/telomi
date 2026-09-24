---
name: browser-skill-evolution
description: Improve the Goal Browser Provider Skill from three historical Browser executions by editing one Skill, replaying the same three Cases, and finishing as confirmed or no_change.
---

# Browser Skill evolution

## Read before changing anything

Read `/evidence/manifest.json`, then each Case under `/evidence`. For every one of the three executions, identify the assigned child task, what the Browser child actually did, where it lost time or evidence, and what the final artifact contained. Read `/baseline/prime-browser-provider-skill/SKILL.md` and every reference it indexes before deciding anything.

Then name the scenario class. A scenario class is a property of a page or task that recurs: infinite-scroll feeds, login-walled archives, server-rendered pagination, cookie consent interstitials. A URL, a site name, a keyword or one Case is not a scenario class. If the three executions show no shared class, that is a real finding: finish as `no_change`.

## Change one Skill

Edit `/work/candidate-package/prime-browser-provider-skill` in place. It must stay one Skill directory with that name; Runtime rejects a rename or a second Skill.

Add or extend `references/<scenario-class>.md` with the procedure for that class, and index it conditionally from `SKILL.md` so a child loads it only when the condition holds. Keep `SKILL.md` short: it routes, references carry the detail. Preserve every existing safety rule, trust-boundary check and stated limitation. Never write credentials, cookies, tokens, transient browser refs such as `@e42`, or private Trace content into the Skill.

## Replay what you changed

Call `run_browser_replay` after each meaningful edit. It always replays all three historical Provider Child Cases with your current Candidate, and you get at most three calls in the session. Spend them: an unreplayed edit cannot be confirmed. A Candidate whose references are all byte-identical to the baseline is refused before the replay starts and costs no call, so a run of the untouched baseline is not available as a control.

Read the returned Evidence, not just `passed`:

Open the returned `evidence_manifest` under `/replays/<round>/`. It indexes read-only Candidate result files, Source contents, execution conditions and child Traces. Read the task-relevant evidence and compare it with `/evidence`; use the manifest's logical paths rather than internal artifact refs. A changed URL set or source count is not by itself a semantic regression or improvement. Check whether the retained evidence satisfies the original task and whether missing evidence reflects access failure, deliberate exclusion or a Skill-induced loss. Keep an uncertain verdict as `no_change`, but state the evidence you could and could not inspect.

- `gates` are Runtime's deterministic hard checks. All must pass before you may confirm.
- `loaded_skill_sha256` proves which Skill actually ran.
- `browser_children` lists the Browser Provider children that replay dispatched. Only their own session Traces count as evidence.
- `reference_reads` locate each read of a reference you changed to one Browser child, its Trace file and its line. Browser children read references through `research_runtime.read_skill`; Runtime reads the bytes itself and records the path and content hash in the execution conditions. Naming a file, printing a receipt, or a plain Python file read is not a verified activation. An empty list means activation is unproven: inspect the child Trace for routing, read errors and hash mismatches before deciding what to change. Do not assume that every empty list means the condition failed to match.
- `diff` compares the Observed production result with your Candidate result per Case. Check the Cases your change does not target too: a regression there matters more than a gain on the target Case.

If a round fails, change the Skill and replay. A round that Runtime could not finish still spends one of your three calls, so read the `error` before retrying. If you edit after your last replay, the submission is rejected: replay again or revert to the replayed content.

## Finish

Write `/work/candidate-package/outcome.json` with exactly these keys:

```json
{
  "schema_version": 1,
  "outcome": "confirmed",
  "skill_name": "prime-browser-provider-skill",
  "summary": "What changed and why",
  "scenario_class": "Which scenario class triggers the reference you changed, and which of the three Cases show it",
  "generalization": "Why the rule is not a special case for one URL, site or keyword",
  "improvement": "What the Candidate replays did better than the Observed baseline, citing the diff",
  "regression_risk": "What the non-target Cases showed",
  "remaining_risk": "What is still unverified",
  "references": [
    {
      "path": "references/<scenario-class>.md",
      "state": "added",
      "trigger": "The condition that should route a Browser task to this reference"
    }
  ]
}
```

`references` lists exactly the reference files whose bytes differ from the baseline, `state` is `added` for a new file and `modified` for an existing one, and `trigger` is the routing condition you indexed it under in `SKILL.md`. Runtime compares the list against the tree you submit and rejects a submission that declares a reference you did not change or omits one you did. The list is empty when you changed no reference.

Use `"outcome": "no_change"` when the evidence does not support a change, when three rounds did not converge, or when the risk outweighs the gain. Fill every field anyway: say what you looked for and why you are not changing the Skill.

Call `submit_stage_output` last.
