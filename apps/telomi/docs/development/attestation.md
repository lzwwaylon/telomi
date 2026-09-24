# Product behavior verification and Attestation

Behavior changes to product Agents, Prompts, Skills, Tools or upstream Providers require verification against real historical Cases. Maintainers use a separately configured evaluation environment to execute real LLM Candidate Replays, inspect complete Artifacts, Traces and failure recovery paths, and complete Attestation before merging.

Basic CI provides only deterministic evidence. Contributors do not need access to the maintainer's private evaluation environment, but should provide a reproducible problem, expected behavior and completed checks in the PR.

## Contributor evidence

- The affected product flow, input conditions, actual result and expected result.
- Shareable reproduction steps or sanitized evidence. Do not commit private Cases, credentials or execution logs.
- Changes to deterministic contracts and their regression tests.
- When introducing an Agent stage, Tool type or output contract, implement Case Capture, a Replay Recipe, a deterministic Contract and regression tests as part of the initial integration. Capture the first semantic Case from a real product Run or evaluation interface.

Read [Node Evaluation](../node-agent-backtest.md) when changing Case Capture, Replay Recipes or Operations contracts.

## Merge and release acceptance

In this project, Agent CI means Attestation Replay. Semantic evidence comes only from Attestation. Local npm Live Tests, Hooks, invented questions, Fixtures and scripts that create an on-the-spot Baseline and then call a model directly do not establish Agent quality, regression fixes or release readiness.

Maintainers reuse historical Cases, execute Candidate Replays and organize independent review. A human or a Coding Agent other than the Candidate Author submits the Judgment. Reviewers inspect anonymous Observed Baseline/Candidate Artifacts, Traces and the Rubric; deterministic metrics alone cannot establish semantic quality. Verify the original problem and representative Cases of the same class, including failure recovery paths.

For real Provider verification, follow the [waiting and timeout rules](e2e.md#waiting-and-timeouts).

## Browser Evolution exception

Automatic application by Goal-scoped Browser Evolution is limited to a same-name Browser Skill override for one Goal. The [Evolution contract](../evolution-module-design.md#inner-loop) defines rounds, Hashes, Traces, reference activation and confirmation conditions.

Changes to bundled Skills, Agent Bundles, cross-Goal capabilities, or the Evolution Agent, Prompt or Tool itself still require the Attestation defined on this page.
