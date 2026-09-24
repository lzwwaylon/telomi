# Paper workflow

Use this branch for scholarly papers. The funnel completes only when every retained paper has a readable full-text
bundle for the Cornell Note Agent.

## Discover

- Use `papers_search()` for Hugging Face native AI semantic discovery. Results are relevance-ranked rather than
  chronological; when original publication time matters, sort or filter the returned candidates by `published_at`.
- Use `list_daily_papers()` or `paginate_daily_papers()` only when Daily Papers appearance-date semantics match the
  assignment. Its date, week, and month are not the paper's original publication date.
- Preserve the returned `paper_id`, original abstract, `ai_summary`, `ai_keywords`, authors, publication date,
  project page, GitHub repository, `document_url`, and `pdf_url` as available. These are screening evidence, not proof
  that full text was acquired.

## Profile

Call `paper_profile(paper_ids, depth="metadata")` for the discovery shortlist. Use the abstract, AI summary, keywords,
dates, project page, GitHub repository, and linked Hub objects to remove irrelevant records.

Call `paper_profile(paper_ids, depth="front")` only for finalists that need more evidence. It reads the Hugging Face
Markdown and returns a bounded `front_excerpt`, headings, and byte length without writing a Source material directory.
Keep complete preview results in variables and print only compact fields.

## Acquire

Call `download_paper()` only for retained papers. Each returned record owns one Runtime-written directory:

- `paper.md` is the Hugging Face full-text Markdown read by the Cornell Note Agent.
- `metadata.json` preserves the complete native Hugging Face paper response plus normalized paper, project, GitHub,
  Markdown, and PDF links.

Pass the download record itself to `CandidateLedger`. A search or profile record has no acquired material and cannot
replace this bundle. The `pdf_url` points to arXiv and remains provenance metadata; it is not a downloaded PDF or a
route around an unavailable arXiv Provider.

Deduplicate papers by `paper_id`. In the completion reply, distinguish full-text bundle success from metadata-only or
preview-only gaps.
