# Final Concept coordination and relation pass

Run this phase only after Runtime accepts every Workset and writes `work/relation-assignment.json`.

Spawn one native child with the exact configured child model. The child reads `work/relation-contract.md` and `work/relation-assignment.json`, writes `work/relations/result.json` atomically, and returns concise ordinary completion text. Do not write merged prose or relations as Root, inspect the child handle, poll, or create a messaging channel.

On repair, spawn one fresh relation child that overwrites only `work/relations/result.json` using the exact Runtime validation error.
