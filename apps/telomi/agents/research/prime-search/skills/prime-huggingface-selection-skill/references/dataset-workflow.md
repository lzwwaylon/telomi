# Dataset and leaderboard workflow

Use this branch for dataset repositories or benchmark submissions hosted by Hugging Face.

## Discover datasets

Use `datasets()` with only the assigned native search, author, tag filters, gated state, and ordering. Follow the opaque
`huggingface_page.next_cursor` unchanged when the assignment requires another page. Use `paginate_datasets()` only when
the assignment itself specifies a bounded total.

Use `dataset_info()` for an exact dataset ID supplied by the assignment or returned by the same discovery execution.
Preserve the dataset's native `repo_id`, description, tags, creation and update times, downloads, likes, revision, and
document URL. Dataset metadata is not a paper or an independently verified benchmark result.

## Read leaderboards

Use `dataset_leaderboard()` only for a benchmark dataset with submitted evaluation rows. Preserve rank, score,
lower-is-better semantics, model ID, and leaderboard URL. Each row is a Provider-reported submission, not independent
verification of the score.

Deduplicate datasets by `dataset_id` or `repo_id`, and leaderboard entries by their returned model and result identity.
Pass the exact retained Provider record to `CandidateLedger`; report when only metadata is available.
