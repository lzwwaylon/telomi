/**
 * How a tool's output is shown: structure the tool reported, JSON text, Markdown, a Python traceback or
 * plain text. Pure functions so both the chat tool overlay and the Activity execution record share them.
 */

export interface OutputTable {
	/** Field that held the rows when they came from inside an object, such as `results`. */
	label?: string;
	columns: Array<{ key: string; label: string }>;
	rows: Array<Record<string, string>>;
}

const TABLE_MAX_COLUMNS = 8;
const TABLE_CELL_CHARS = 160;

/**
 * The structure behind an output. The text the tool returned leads: when it is a JSON object or array,
 * that is the structure to show. Tools also report `details`, but often as a wrapper around the same
 * text (an execution envelope repeating stdout) or as metadata about it (truncation), so details only
 * lead when there is no text, and otherwise become a secondary view unless they merely restate the text.
 */
export function outputStructures(output: string, details: unknown): { primary?: unknown; secondary?: unknown } {
	const fromText = parseStructure(output);
	if (fromText !== undefined) return { primary: fromText };
	if (!isNonEmptyStructure(details) || restatesText(details, output)) return {};
	return output.trim() ? { secondary: details } : { primary: details };
}

/**
 * Rows worth a table: an array of objects, or the longest array of objects directly inside an object.
 * Columns are the keys at least half of the rows share, in first-seen order; cells are flattened and
 * shortened, since the field tree and raw views keep the full values.
 */
export function outputTable(value: unknown): OutputTable | undefined {
	if (isObjectList(value)) return tableFromRows(value);
	if (!isPlainObject(value)) return undefined;
	const [label, rows] = Object.entries(value)
		.filter((entry): entry is [string, Array<Record<string, unknown>>] => isObjectList(entry[1]))
		.sort((left, right) => right[1].length - left[1].length)[0] ?? [];
	if (!label || !rows) return undefined;
	const table = tableFromRows(rows);
	return table && { ...table, label };
}

export function isScalarList(value: unknown): value is Array<string | number | boolean | null> {
	return Array.isArray(value) && value.length > 0 && value.every((item) => item === null || typeof item !== "object");
}

/** Tool output as a code block: JSON is re-indented and highlighted, anything else stays as written. */
export function formatToolOutput(output: string): { code: string; language: string } {
	const trimmed = output.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return { code: JSON.stringify(JSON.parse(trimmed), null, 2), language: "json" };
		} catch {
			// Not JSON, such as a Python repr; show it as written.
		}
	}
	return { code: output, language: "text" };
}

// Heuristic: detect markdown-like text so OUTPUT can opt in automatically.
// Catches headings, lists, fenced code, tables, and link-rich multi-line
// content. Length floor avoids upgrading short stderr lines like "Done.";
// fence/heading tests are anchored to line starts so source code with stray
// `*` or `#` does not trigger.
const MD_BLOCK_RE = /(^|\n)(\s{0,3})(#{1,6}\s+\S|[-*+]\s+\S|\d+\.\s+\S|```|>\s+\S|\|.*\|)/;
const MD_LINK_RE = /\[[^\]\n]{1,200}\]\([^)\n]{1,400}\)/;
export function looksLikeMarkdown(text: string | undefined): boolean {
	if (!text || text.length < 50) return false;
	if (MD_BLOCK_RE.test(text)) return true;
	if (MD_LINK_RE.test(text) && text.includes("\n")) return true;
	return false;
}

export function looksLikeTraceback(text: string): boolean {
	return /(^|\n)Traceback \(most recent call last\):/u.test(text);
}

function tableFromRows(rows: Array<Record<string, unknown>>): OutputTable | undefined {
	const counts = new Map<string, number>();
	for (const row of rows) {
		for (const key of Object.keys(row)) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const keys = [...counts].filter(([, count]) => count * 2 >= rows.length).map(([key]) => key).slice(0, TABLE_MAX_COLUMNS);
	if (keys.length === 0) return undefined;
	return {
		columns: keys.map((key) => ({ key, label: key })),
		rows: rows.map((row) => Object.fromEntries(keys.map((key) => [key, tableCell(row[key])]))),
	};
}

function tableCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	// A score like 0.032266458495966696 only widens its column; the field tree and raw views keep the exact value.
	if (typeof value === "number" && !Number.isInteger(value)) return String(Number(value.toPrecision(4)));
	const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > TABLE_CELL_CHARS ? `${flat.slice(0, TABLE_CELL_CHARS)}…` : flat;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectList(value: unknown): value is Array<Record<string, unknown>> {
	return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

function parseStructure(output: string): unknown {
	const trimmed = output.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		const value = JSON.parse(trimmed) as unknown;
		return isNonEmptyStructure(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Details that carry a string the text already contains wrap that text rather than add structure to it. */
function restatesText(details: unknown, output: string): boolean {
	return isPlainObject(details) && Object.values(details)
		.some((value) => typeof value === "string" && value.trim() !== "" && output.includes(value.trim()));
}

function isNonEmptyStructure(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return isPlainObject(value) && Object.keys(value).length > 0;
}
