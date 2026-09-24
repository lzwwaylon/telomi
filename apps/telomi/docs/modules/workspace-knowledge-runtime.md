# Workspace Knowledge Pinning

## Purpose

Pin the current Goal Wiki Knowledge for a Research Run. User preferences and user memory do not belong to Goal Workspace.

## Interface

- `readWorkspaceKnowledge(goalDir, goalId)` pins the current Knowledge content and its content hash, independently of Workspace Git state.

## Main capabilities

- Read published pages and sources from `wiki/knowledge/`.
- Hash page and source content to pin the Knowledge read by the current Run.
- Mount pinned Knowledge pages read-only for Research Agents that need them.

## Responsibility boundaries

- Wiki Agents exclusively own Goal Knowledge curation.
- Main Agent queries knowledge through Wiki Tools, without injecting the entire Wiki into its System Prompt.
- This module does not read, infer, store, or project user preferences.

## Wiki retrieval index

- Each Goal has one Wiki vector index for published `wiki/knowledge/`. It is stored outside Goal Workspace and is not copied by Workspace snapshots.
- The index refreshes incrementally in the background only after Wiki publication completes. Wiki Updates and Topic reframes share the same publication entry point; intermediate Curator edits do not enter the index. Page-content hashes ensure that only changed pages are embedded. If another publication occurs during refresh, refresh follows the latest content after the current batch.
- Retrieval never embeds pages and delegates ranking entirely to native LanceDB capabilities. The queried Wiki directory (published Wiki, pinned Research snapshot, or historical Edition) gets an in-memory full-text index using the icu tokenizer and cached vectors for pages whose content hashes still match. LanceDB's built-in RRF fuses full-text and vector search, then graph-adjacent pages are appended. Pages whose content hashes changed participate only through full-text and graph signals, and results report index coverage. Topic membership is not part of page hashes, so Topic changes alone do not trigger re-embedding.
- Retrieval results express only ordering and match origins (keyword, vector, graph), never scores to the frontend or Agent. RRF scores reflect rank only, and cosine values vary by embedding model; neither is a usable relevance threshold.
- Embedding-service failure does not block publication; refresh retries with backoff. Embedding-model changes still use embedding migration, with the old index serving until replacement completes.

## Verification

Research E2E must confirm that pinned Goal Knowledge is readable and that user-state Wiki data is not mounted.
