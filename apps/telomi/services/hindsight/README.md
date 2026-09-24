# Hindsight runtime

Telomi runs Hindsight as a native loopback-only Python service on macOS. It
has its own uv environment because Hindsight and the research source service
require incompatible FastAPI versions.

```bash
cd apps/telomi
npm run memory:install
npm start
```

The Node runtime owns the process lifecycle. It reuses a healthy service at
`HINDSIGHT_URL`, otherwise it runs `telomi_configuration.py` with the existing Hindsight Python
interpreter and stops that child with Telomi. Persistent data defaults to
`pg0://telomi`; model updates keep that database and the existing bank identity.

Use Settings > Models and services > User Memory for the base LLM, retain,
reflect, and consolidation. LLM roles inherit the global default or
base Memory LLM unless overridden. Reasoning effort and temperature follow the
same managed settings. Save for later does not activate changes. Apply validates
connections, drains native HTTP and worker operations, and replaces the managed
process automatically. Failed replacement restores the previous configuration;
status distinguishes the actual service from its pending target. A control
failure that prevents safe rollback is reported instead of killing admitted work.

Model selections come from managed settings; legacy model environment values
are ignored.
Managed launches do not load Hindsight's independent dotenv overrides. LLMs use
OpenAI chat-completions compatible connections, with native DeepSeek, Groq and
OpenRouter backends where selected. Reranking is not configurable: Hindsight
runs its own default local cross encoder, legacy reranker environment values are
ignored, and a reranker selection saved by an earlier version is dropped.

A loopback transport resolves native Pi credentials for each outgoing request.
Connection identity and credential deletion are checked again after asynchronous
authorization and immediately before forwarding. A concurrent connection replacement
fails that lookup; a later request resolves the newly active connection. Explicit
authorization headers follow the same precedence as Apply validation.
Credential rotation leaves requests already sent intact, without storing another
credential copy or editing the shared Python environment. External Hindsight
processes without the managed boundary remain untouched and cannot be reported
as updated. Embedding configuration and migrations are separate from this LLM
configuration path.
