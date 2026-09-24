import { parse } from "yaml";

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export function splitFrontmatter(content: string): { fields?: Record<string, unknown>; body: string } {
	const match = BLOCK.exec(content);
	if (!match) return { body: content };
	try {
		const fields = parse(`\n${match[1]}`, {
			maxAliasCount: 100,
			schema: "core",
			uniqueKeys: true,
		});
		return fields && typeof fields === "object" && !Array.isArray(fields)
			? { fields: fields as Record<string, unknown>, body: content.slice(match[0].length) }
			: { body: content.slice(match[0].length) };
	} catch {
		return { body: content.slice(match[0].length) };
	}
}
