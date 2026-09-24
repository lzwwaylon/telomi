# Space workflow

Use this branch only when the assignment needs a hosted application, interactive demo, or deployment evidence from a
Hugging Face Space.

Use `spaces()` with the assigned search, author, native filters, ordering, linked models, or linked datasets. Follow the
opaque `huggingface_page.next_cursor` unchanged when another page is required. Use `paginate_spaces()` only for an
assignment with a bounded total.

Preserve the native Space ID, SDK, tags, linked model IDs, linked dataset IDs, creation and update times, likes, and
document URL. A running Space demonstrates a hosted application surface; it does not by itself prove model quality,
open weights, reproducibility, or benchmark claims.

Deduplicate by native `repo_id`. Pass the exact retained Provider record to `CandidateLedger` and state any missing
README or runtime evidence in the completion reply.
