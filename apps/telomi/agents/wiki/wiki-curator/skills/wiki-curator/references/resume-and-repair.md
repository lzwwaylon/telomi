# Delegate or repair Wiki Curator Worksets

Runtime has accepted `work/plan.json` and materialized exact assignment files under `work/assignments/`.

For each requested assignment path, spawn one native child with this complete prompt pattern:

```python
assignment_path = "work/assignments/example.json"
child_prompt = (
    "Read work/child-contract.md and " + assignment_path + ". "
    "Follow both files exactly, write the assigned output_path atomically, "
    "then call submit_workset with that assignment's group_id and repair the same file until it passes. "
    "Then return concise ordinary final text."
)
handle = await rlm(child_prompt, name="curator-example", model=child_model)
```

Use string concatenation. Do not format a JSON example into the prompt. `RLMSpawnHandle` is an object; do not subscript, inspect, list, wait on, or message it. Start each requested child once and stop the Root turn.

On repair, overwrite only the rejected Workset's own `result.json`. Do not rewrite accepted Worksets, the Plan, or child prose as Root.

A Workset that its child already submitted through `submit_workset` is not requested again. A rejection that still arrives here is one Runtime can only judge across the whole Edition, such as incomplete evidence disposition or two Worksets claiming the same normalized title; repair it the same way and let the child resubmit. Distinct concepts with the same title receive distinguishing titles through Workset repair. The final coordination child then reviews semantic Concept overlap across the accepted results.
