/**
 * GFM only recognises a table when the delimiter row has exactly as many cells as the header row.
 * Writers occasionally miscount, which silently turns the whole table into one paragraph, so the
 * delimiter row is rebuilt to the header's cell count before the Markdown is published.
 */

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;

function splitCells(row: string): string[] {
	let cells = row.trim();
	if (cells.startsWith("|")) cells = cells.slice(1);
	if (cells.endsWith("|") && !cells.endsWith("\\|")) cells = cells.slice(0, -1);
	return cells.split(/(?<!\\)\|/u);
}

export function normalizeGfmTables(markdown: string): string {
	const lines = markdown.split("\n");
	let fence: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			if (!fence) fence = fenceMatch[1]!;
			else if (fenceMatch[1]!.startsWith(fence[0]!)) fence = null;
			continue;
		}
		// A pipe-less `---` under text is a setext heading, never a table delimiter.
		if (fence || !line.includes("|") || !DELIMITER_ROW.test(line)) continue;
		const header = lines[i - 1]!;
		if (!header.includes("|")) continue;
		const headerCount = splitCells(header).length;
		const cells = splitCells(line).map((cell) => cell.trim()).slice(0, headerCount);
		if (cells.length === headerCount && cells.length === splitCells(line).length) continue;
		while (cells.length < headerCount) cells.push("---");
		lines[i] = `|${cells.join("|")}|`;
	}
	return lines.join("\n");
}
