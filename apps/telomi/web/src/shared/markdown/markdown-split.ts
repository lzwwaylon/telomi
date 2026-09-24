/**
 * Block splitter + content hash for streaming markdown memoization.
 *
 * Strategy: split on paragraph boundaries (blank lines) and code-fence
 * transitions. Every "stable" block past the tail gets a content-hash key so
 * React.memo can short-circuit re-renders during streaming. The tail block
 * (still being typed) gets a positional `active-N` key and re-renders freely.
 */
export interface MarkdownBlock {
	content: string;
	isCodeBlock: boolean;
}

/**
 * djb2 hash → base36. Fast, no deps, good distribution for short strings.
 * Used as the React `key` for completed blocks; collisions just cause an
 * unnecessary re-render — never a correctness bug.
 */
export function simpleHash(str: string): string {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
	}
	return (hash >>> 0).toString(36);
}

/**
 * Split markdown into blocks (paragraphs and code blocks).
 *
 * Block boundaries:
 * - Blank lines (paragraph separators)
 * - Code fences (``` at the start of a line)
 *
 * Intentionally simple — single pass, no regex per line. Unclosed fences
 * keep the trailing block flagged as code so the streaming tail renders
 * inside a `<pre>` until the closer arrives.
 */
export function splitIntoBlocks(content: string): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	const lines = content.split("\n");
	let currentBlock = "";
	let inCodeBlock = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.startsWith("```")) {
			if (!inCodeBlock) {
				if (currentBlock.trim()) {
					blocks.push({ content: currentBlock.trim(), isCodeBlock: false });
					currentBlock = "";
				}
				inCodeBlock = true;
				currentBlock = line + "\n";
			} else {
				currentBlock += line;
				blocks.push({ content: currentBlock, isCodeBlock: true });
				currentBlock = "";
				inCodeBlock = false;
			}
		} else if (inCodeBlock) {
			currentBlock += line + "\n";
		} else if (line === "") {
			if (currentBlock.trim()) {
				blocks.push({ content: currentBlock.trim(), isCodeBlock: false });
				currentBlock = "";
			}
		} else {
			if (currentBlock) {
				currentBlock += "\n" + line;
			} else {
				currentBlock = line;
			}
		}
	}

	if (currentBlock) {
		blocks.push({
			content: inCodeBlock ? currentBlock : currentBlock.trim(),
			isCodeBlock: inCodeBlock, // Unclosed fence = still streaming inside a code block
		});
	}

	return blocks;
}
