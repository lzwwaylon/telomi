# Native search

Use this path for direct Hugging Face model queries and exact repository acquisition.

## Query models

Use `models()` with the native fields required by the assignment:

- `search` for text contained in repository IDs;
- `author` for an organization or user namespace;
- `pipeline_tag` and `filters` for task and catalog tags;
- `apps`, `gated`, `inference`, and `inference_provider` for availability or deployment constraints;
- `trained_datasets` and `num_parameters` for training-data or size constraints;
- `base_model_relation` for base, adapter, fine-tune, quantized, or merge relations;
- `sort` for a native Hub ordering.

`models(search=...)` searches repository IDs, not Model Card prose. Use it for an identifier fragment supplied by the
assignment or found in Provider records. Do not use it as a substitute for category discovery.

Follow the opaque `huggingface_page.next_cursor` with `paginate_models()` when a bounded query needs more than one
page. A full page is not proof of complete coverage.

## Resolve records

Use `repo_id`, not the generic hashed `id`, for exact lookup and deduplication. Batch known IDs with `model_info()` and
download only selected README files with `model_card()`.

Hub `created_at` and `updated_at` are repository timestamps, not necessarily model release dates. Verify release claims
from the Model Card or linked primary evidence when the assignment is time-bounded.
