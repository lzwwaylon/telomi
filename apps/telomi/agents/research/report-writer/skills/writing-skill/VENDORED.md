# Vendored: grapeot/writing-skill

Upstream: https://github.com/grapeot/writing-skill
Commit: `9f2f6974a143de92c52dc5be1bfd931018a09f39` (2026-08-22)
License: MIT, retained in `LICENSE`.

This runtime copy keeps the deterministic Chinese prose scanner and the prose/thesis references used by the Research Report Writer. The root `SKILL.md` is adapted to Prime Reporter's unattended stage contract.

The upstream internal-memo, Twitter, publishing, image, Antigravity, extra-model rewrite, and cold-read workflows are intentionally omitted. They require tools or interactions unavailable to Reporter and would conflict with its one-root, one-child-per-Section orchestration.

The references are kept as one English edition that applies to every report language; the upstream Chinese originals are not bundled.

`src/writing_skill/run.py` exposes the scanner as Prime's native awaitable `writing_skill(...)`. Four upstream findings are removed and kept as statistics only. `char_count` (2000+ Han characters) and `h2_count` (one to four H2 Sections) encode the upstream author's article format, while a report's length and Section count are set by its Report Context and frozen outline. `embedded_links` (at least three links) and `bare_url` tell the Writer to author Markdown links by hand, which the Report Writer's citation contract forbids; Runtime validates `<cite>` citations itself. No other scanner rule was changed.
