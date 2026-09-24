# Prime Search Frozen Evaluation Rubric

Judge semantic quality before efficiency. Compare A and B against the frozen Main-owned Search Question, Temporal Context, Provider Catalog, and Provider Environment.

Check all of the following:

1. Every Evidence Requirement is either covered by retained evidence or explicitly left uncovered.
2. Retained Sources are relevant to their assigned requirement and exclude adjacent or unrelated records.
3. Primary or authoritative Sources are preferred when the Provider Environment contains them.
4. Every retained Candidate has complete, readable material and preserved discovery provenance.
5. Published dates and temporal filtering respect the frozen Temporal Context when the task is time-bounded.
6. Candidate Ledgers contain the complete relevant Provider-native set without semantic over-deduplication.
7. Duplicate representations of the same object are not retained twice.
8. Candidate Ledgers retain every qualified distinct evidence role and do not silently omit a required Source.
9. Search Execution Records, Candidate Ledgers, Source Bundles, and final Logical Sources agree.
10. General Web calls belong only to Root and answer a concrete discovery or routing need; repeated searches must add necessary information.
11. The search respects Main’s incremental scope and prior coverage; report preferences do not expand acquisition requirements.
12. Only after quality is tied, prefer lower failure rate, Token, Cost, Tool Calls, or Duration.
13. A Provider fallback covers only the unresolved responsibility, keeps the replacement Provider's provenance, states material limitations, and stops after one unavailable alternative.

Choose `tie` when neither output has a clear semantic advantage. Do not infer quality from Source count alone.
