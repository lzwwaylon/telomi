# Tag filtering

Use this path when Hub-native categories express the assignment better than repository-name search.

## Resolve tags

- Call `model_tags()` with the relevant `tag_type`: `pipeline_tag`, `language`, `library`, `license`, or `other`.
- Use returned `tag_id` values rather than guessed labels or prefixes.
- Pass the model task through `pipeline_tag`. Pass additional language, library, license, or other tag IDs through
  `filters`.
- Multiple `filters` are combined by the Hub. Use them only when the assignment requires every filter to match.
- Keep the assigned task boundary in every view. A language-only query scans unrelated model tasks and can exhaust the
  pagination safety limit.

Hub metadata is incomplete. Do not require optional tags to coexist on every relevant record. If the assignment needs
broad, time-bounded coverage rather than a single filtered view, continue with
[Integrated model discovery](model-discovery.md) instead of repeating narrower searches and merging them by hand.

Base-model relation, repository author, deployment support, gated state, inference availability, training datasets,
and parameter ranges are native query fields rather than catalog tags. For those, read
[Native search](native-search.md).
