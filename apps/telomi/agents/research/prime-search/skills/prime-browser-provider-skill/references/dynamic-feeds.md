# Dynamic feeds

Use this path only for feeds, timelines, pagination, infinite scroll, or a bounded time window.

1. Snapshot the list and identify relevant entries from visible category, title, and time evidence.
2. For each retained entry, get the link `href`, open it in the same tab, then capture canonical URL, title, visible time, and body text.
3. Return to the feed and repeat with a fresh snapshot. For complete interval coverage, continue pagination or scrolling until the relevant feed is exhausted. Stop at entries older than the lower bound only when the feed is demonstrably ordered newest-first and pinned or mixed-order entries have been accounted for. Otherwise continue checking relevant entries and report any unexamined range as incomplete.
4. Treat relative times such as `11h` and `1d` as page-visible evidence, not exact timestamps. Record missing timezone or publication-versus-update ambiguity instead of inferring it.

The current viewport is not proof that a bounded interval is complete. Keep only entries supported by the current run's rendered pages.
