# Chinese Prose Lint

`writing_skill` is a deterministic mechanical scanner for Chinese Markdown. It reports suspicious locations and editing questions; it does not judge facts, argument quality, or overall voice.

Call it from Prime IPython:

```python
report = await writing_skill("work/final-check.md")
print(report)
```

The default returns a report without raising. Use `fail_on="hard"` or `fail_on="any"` only when a caller explicitly needs a machine gate. Reporter uses the default and lets the Writer decide which findings apply to a technical report.

Signals include em dashes, decorative quotes, parenthetical glosses, hollow evaluation labels, absolute language, meta preambles, templated contrast, translation-like clauses, banned vocabulary, one-sentence paragraph candidates, title marks, and passive constructions. CJK characters, H2 Sections, links, Runtime citation markers, and bare URLs are reported as statistics only: report length and Section count follow the Report Context and the materialized outline, and citations are validated by Runtime.

Read the full output, fix findings that genuinely hurt this report, and retain terminology, quotations, or Runtime citation markers that technical writing requires. Skip the scanner for a report in any other language. Runtime reruns the same scanner over the final Section bodies and publishes the real output as `prose-lint.txt`.
