# Wiki Shard Builder

Each Source batch uses two independent Prime SDK Sessions to curate candidate Entities and Concepts respectively. Either may choose native RLM delegation. Runtime does not preassign pages or inject multiple User stages for planning, delegation, and repair into the same main Session.

## Inputs and working directory

- The User Prompt supplies the structured Goal's title and description, readable Topics, and complete Cornell Notes together. The research question does not substitute for the Goal description, and Topic IDs are not shown. Note references remain for traceability.
- Both branches consume the same evidence but have different semantic objectives. A full prompt exceeding the input budget fails explicitly, without silent truncation.
- The Agent cwd contains only `work/`; results are written to `work/entity/result.json` and `work/concept/result.json` respectively. Goal, Topics, and Notes are not mapped to files.
- Logs, acceptance markers, and joint-validation staging stay outside cwd. Submission tools perform only deterministic validation; after rejection, the Agent repairs and resubmits within the original Session.
- The last branch to submit triggers joint validation. The entire Shard is committed only after both branches are valid and the native RLM lifecycle ends, then passes to the existing Wiki Curator flow.
- A Shard with no pages is valid. Runtime does not start Curator for it, and the current Edition carries forward to the next batch. If every Shard is empty and no Edition exists, an empty Edition is published.

## Recovery and output reads

- Wiki Update discovery and resume accept only independent Wiki Update control directories and their corresponding artifact directories. Old tasks inside Research Run directories cannot be recovered.
- Wiki Agent output is read only through the current Session manifest. Old SDK logs or entity/concept Session pointers are not read entry points.
- New Wiki Updates freeze `goal_context: {title, description}` and recovery uses the same metadata. After changing a Goal, semantic results for the old Goal cannot be reused.
- For old tasks without a structured Goal, automatic guessing is rejected without consuming a resume attempt. Create a new task from the same Cornell Notes through the normal Wiki Update entry point. Do not manually alter historical tasks, Notes, or Cases; the new task uses the current explicit Goal.
- Historical replay without Goal metadata must explicitly supply it in an isolated instance, validate the Goal ID, and record the source hash without modifying the original Case.
- Accepted branches and complete batches can be reused during recovery. A partially failed Wiki does not write a complete Goal fingerprint, preventing a later execution from treating an unfinished Goal update as fully complete.
- Usage for both success and failure is read from native Root/child Sessions; SDK lifecycle logs do not contain complete Root usage. Total input-context accounting must also include cache reads, not just uncached input tokens.

## Verification

Wiki cases under `tests/wiki/` and `tests/evaluation/` cover deterministic contracts and recovery. Page counts and citation counts are not substitutes for semantic-quality judgment.

This module produces candidate Shards only and does not establish the final Curator publication's quality. Fact attribution, version/metric conditions, and omissions from compression still require semantic review; do not add keyword-based Runtime semantic rules.
