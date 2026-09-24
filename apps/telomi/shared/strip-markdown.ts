/**
 * Strip Markdown syntax for single-line pill display (pulse-band, headers, badges).
 *
 * Keeps content but removes formatting characters that look like noise inside an
 * ellipsis-truncated single-line span. Order matters — code-block fences are
 * stripped before inline backticks so we don't leave dangling tokens.
 *
 * Apply before truncating a preview so formatting tokens remain complete.
 */
export function stripMarkdownForPill(raw: string): string {
	if (!raw) return "";
	let s = raw;

	// 1. Fenced code blocks ```...``` (multi-line) — drop entirely.
	s = s.replace(/```[\s\S]*?(?:```|$)/g, " ");

	// Keep link labels, including citation labels like [[1]]; tolerate old truncated URLs.
	s = s.replace(/!?\[((?:\[[^\]]*\]|[^\]])*)\]\((?:[^()]|\([^()]*\))*(?:\)|$)/g, "$1");
	s = s.replace(/!?\[([^\]]+)\]\[[^\]]*\]/g, "$1");
	s = s.replace(/~~([^~]+)~~/g, "$1");

	// 2. Inline code `xxx` — keep content, drop fences.
	s = s.replace(/`([^`]+)`/g, "$1");

	// 3. Bold/italic/underscore emphasis — keep content, drop markers.
	//    **bold** / __underline__ first (greedier), then single * / _.
	s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
	s = s.replace(/__([^_]+)__/g, "$1");
	s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
	s = s.replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "$1$2");

	// 4. Strip leading list markers on each line: `- `, `* `, `+ `, `1. `, `12) ` etc.
	s = s.replace(/(^|\n)\s*(?:[-*+]|\d+[.)])\s+/g, "$1");

	// 5. Heading hashes at line start: `### Title` → `Title`.
	s = s.replace(/(^|\n)\s*#{1,6}\s+/g, "$1");

	// 6. Blockquote markers: `> quote` → `quote`.
	s = s.replace(/(^|\n)\s*>+\s?/g, "$1");

	// 7. Collapse newlines + tabs into a single space (single-line pill).
	s = s.replace(/[\r\n\t]+/g, " ");

	// 8. Collapse runs of spaces.
	s = s.replace(/ {2,}/g, " ");

	return s.trim();
}
