import { sourceAssetHttpUrl } from "@/shared/markdown/source-asset";

export interface ReportCover {
	sourceId: string;
	path: string;
}

// Muted slate, sage, sand, olive, teal and stone, with matching dark ink.
const COVER_PALETTE = [
	["#CAD4DA", "#344650"],
	["#CDD5C9", "#3D4B38"],
	["#DED3C1", "#544634"],
	["#D4D4BE", "#494B32"],
	["#C5D5D1", "#314C46"],
	["#D5CEC5", "#4C443B"],
] as const;

/** Deterministic SVG cover: a title-selected muted palette. Works as `<img src>` and MediaSession artwork. */
export function generatedCoverUrl(title: string): string {
	let hash = 0;
	for (const ch of title) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
	const [background, foreground] = COVER_PALETTE[hash % COVER_PALETTE.length];
	const lines = wrapTitle(title.replace(/[<>&"]/g, ""));
	const tspans = lines
		.map((line, i) => `<tspan x="22" dy="${i === 0 ? 0 : 34}">${line}</tspan>`)
		.join("");
	// 4:3 to match the card thumbnail exactly, so no backdrop shows around it.
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
<rect width="320" height="240" fill="${background}"/>
<text x="22" y="58" font-family="system-ui, sans-serif" font-size="28" font-weight="600" fill="${foreground}">${tspans}</text>
</svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const LINE_UNITS = 20;
const MAX_LINES = 4;

const WIDE = /[\u1100-\uFFFF]/u;

/** Approximate rendered width: CJK and other wide glyphs count double. */
function units(text: string): number {
	let total = 0;
	for (const ch of text) total += WIDE.test(ch) ? 2 : 1;
	return total;
}

/** Greedy wrap over tokens: Latin words stay whole, every wide glyph may break, spaces only between Latin tokens. */
function wrapTitle(text: string): string[] {
	const tokens = text.match(/[\u1100-\uFFFF]|[^\s\u1100-\uFFFF]+/gu) ?? [];
	const lines: string[] = [];
	let current = "";
	for (const token of tokens) {
		const glue = current && !WIDE.test(current.at(-1)!) && !WIDE.test(token) ? " " : "";
		const pieces = units(token) > LINE_UNITS ? token.match(new RegExp(`.{1,${LINE_UNITS}}`, "gu"))! : [token];
		for (const [index, piece] of pieces.entries()) {
			const joint = index === 0 ? glue : "";
			if (current && units(current + joint + piece) > LINE_UNITS) {
				lines.push(current);
				current = piece;
			} else {
				current += joint + piece;
			}
		}
	}
	if (current) lines.push(current);
	if (lines.length > MAX_LINES) return [...lines.slice(0, MAX_LINES - 1), `${lines[MAX_LINES - 1]}…`];
	return lines;
}

export function reportCoverUrl(goalId: string, title: string, cover?: ReportCover | null): string {
	const asset = cover ? sourceAssetHttpUrl(`source-asset:${cover.sourceId}/${cover.path}`, goalId) : null;
	return asset ?? generatedCoverUrl(title);
}
