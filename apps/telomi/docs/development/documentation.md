# Writing documentation

Use this page when changing project descriptions, module documentation or contribution guides. For product Agent Prompts or Skills, also read [Product Agent development](agent-authoring.md).

## Language policy

Technical documentation has one authoritative English version. User guides provide an English default and a `.zh-CN.md` translation; each language version links to the other. Retain the existing bilingual release guide. Update both versions of a bilingual pair in the same PR.

## Entry points and progressive reading

- Keep general constraints and task-specific links at the entry point. Each link states when to read it and what it covers; a task may require multiple branches.
- Keep material needed by every branch at the entry point. Move references needed only for some tasks into the relevant files. Organize branches by task, keeping shared definitions, rules and exceptions together.
- Give each detailed rule one authoritative home. Other entry points reference it with a brief trigger; update inbound links when paths change.
- State verifiable completion criteria for operational steps. After splitting documents, follow representative task paths step by step to confirm that all applicable constraints can be found before taking action.

## Module documentation

Document only what cannot be learned from the code: responsibility boundaries, decision rationale, cross-module contracts and pitfalls that configuration does not make explicit. File inventories, command lists and type fields belong to the code, `package.json` and directory structure; do not maintain duplicate inventories in documentation.

Each module document answers only five questions:

1. Why the module exists.
2. Which Interface callers use to access it.
3. Which major capabilities it currently owns.
4. What it explicitly does not own.
5. Which constraints or tradeoffs are not apparent from reading the code.

Module documents do not duplicate type fields, complete Prompts or internal algorithms. They do not record migration histories, comparisons of alternatives or unimplemented designs. Keep dated status snapshots, roadmaps and implemented/pending checklists out of `apps/telomi/docs/` so they cannot be mistaken for current contracts.

## Maintenance triggers

Update the relevant module documentation when:

- A new `agent.yaml` has ownership that is not evident from its Domain directory.
- An Agent's entry point, terminal actions, Tool permissions or network permissions change.
- Responsibilities move between Runtime and Agent.
- A module's major inputs, persisted results or published results change.
- A new constraint or tradeoff is not apparent from reading the code.

Changes limited to internal function names, log wording or implementation details that do not affect the Interface do not require module documentation updates.
