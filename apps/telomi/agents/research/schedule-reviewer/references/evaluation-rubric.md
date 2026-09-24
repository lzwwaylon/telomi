# Research Schedule Reviewer Evaluation Rubric

Judge one Review of one Research Schedule. Compare A and B against the frozen inputs of the
Case: the Schedule's confirmed `monitoringScope`, `reportContext` and question, its recent
occurrences, the previous Review, and the memory entries and Wiki pages the Case recorded as
answers. Nothing outside those answers is evidence, for the Reviewer or for you.

Check all of the following:

1. The decision matches the evidence. `no_change` is right when the recorded memory, Wiki and
   occurrences show no drift; `propose` is right only when they show a concrete drift between the
   two declarations and what this user now cares about, what the Wiki already answers, or what the
   occurrences are producing.
2. Every claim in `rationale` is traceable to a recorded memory entry, Wiki page or occurrence.
   Restated model knowledge, invented user preferences and unrecited evidence all count against it.
3. `evidence` lists what was actually consulted, and its entries resolve to recorded reads.
4. A Proposal is still the same recurring assignment, better declared. A revision that turns it
   into a different question belongs in a new Schedule and is worse than `no_change`.
5. Both proposed texts are complete replacements that stand on their own, keep what still holds,
   and drop only what the evidence says is stale.
6. No prose in `summary` or `rationale` proposes a change to cadence, time zone, title or an
   individual occurrence. Fields of that kind are already rejected deterministically, so judge
   only what the text asks the user to accept.
7. `summary` is one or two sentences a Goal owner can act on: what changes and why, in their terms,
   without repeating the two full texts.
8. A previously rejected Proposal is treated as history. Re-proposing the same idea in the same
   form is worse; a genuinely better version of it is allowed.
9. Only after quality is tied, prefer lower Token, Cost, Tool Calls or Duration.

Choose `tie` when neither Review has a clear semantic advantage. Do not prefer `propose` over
`no_change` because it did more work.
