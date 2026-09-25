# pi-user-memory

Pi extension backed by Hindsight. `telomi` registers it for every Main Agent Goal, and it can also run with the standalone Pi CLI.

## Run locally

Prerequisites: Python 3.11, `uv`, an OpenAI-compatible embedding endpoint, and a DeepSeek API key.

```sh
export DEEPSEEK_API_KEY="$(jq -r '.deepseek.key' ~/.pi/agent/auth.json)"
cd ../../telomi
npm run memory:install
export HINDSIGHT_API_LLM_PROVIDER=deepseek
export HINDSIGHT_API_LLM_API_KEY="$DEEPSEEK_API_KEY"
export HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash
export HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai
export HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
export HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=local
export HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL="your-embedding-model"
services/hindsight/.venv/bin/hindsight-api --host 127.0.0.1 --port 18888

cd ../extensions/pi-user-memory
HINDSIGHT_BANK_ID=local-user \
PI_USER_MEMORY_GOAL_ID=example-goal \
pi --no-extensions --extension ./index.ts
```

`HINDSIGHT_BANK_ID` is the durable user-memory boundary. Keep it stable across Pi sessions and use a
different bank for every user whose memories must be isolated. `PI_USER_MEMORY_GOAL_ID` is optional
context attached to new messages. When `HINDSIGHT_BANK_ID` is omitted, the extension uses
`pi-user-<local OS username>`, which is suitable for a single-user workstation.

The extension exposes `search_user_memory` to the main Agent:

- `recall` returns source-linked historical evidence without an LLM synthesis step.
- `reflect` uses Hindsight to resolve changing or conflicting memories into a current conclusion.
- `intent` keeps preference, Goal understanding, and related-history retrieval from competing in one broad query.

The extension does not inject retrieved memories automatically. It adds only tool-use guidance to the
system prompt, so Pi decides whether memory is relevant and translates only selected constraints into
downstream tasks. The current user message always overrides conflicting history.

After `agent_settled`, the extension asynchronously retains the direct user prompt with an immutable
document ID. With `PI_USER_MEMORY_GOAL_ID` the prompt carries only that Goal's tag and is recalled in
that Goal; recall also admits `scope:global`, which only the user sets (in `telomi`, on the Memory
page). Without a Goal, prompts are tagged `scope:global` and every session shares them. Assistant
responses are never retained as user facts. Accepted writes and failures are visible on stderr as
`HINDSIGHT_MEMORY_RETAINED` and `HINDSIGHT_MEMORY_RETAIN_FAILED`.

`telomi` disables this in-process retain hook. Its server projects canonical Task History and
explicit Artifact Feedback into Hindsight with stable document IDs, Goal tags, and a durable local
acceptance ledger, so attachments and failed writes share the same restart-safe path. Only the Main
Agent receives `search_user_memory`; Research and Prime Agents receive task-specific prompts instead.

Useful commands:

- `/memory-status` shows recent Hindsight operations.
- `/memory-forget` deletes the entire configured bank after confirmation.

Validation:

```sh
npm run typecheck
npm run test:cli
```
