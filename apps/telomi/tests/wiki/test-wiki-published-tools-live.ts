import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveDataDir } from "../../server/config/data-dir.js";
import { GoalWikiSearch } from "../../server/wiki/local-search.js";

const goalId = requiredEnv("EVIDENCE_WIKI_LIVE_GOAL");
const goalDir = join(resolveDataDir(), goalId);
// The embedding connection and credential come from the unified configuration of this data directory.
const wiki = new GoalWikiSearch(join(goalDir, "wiki", "knowledge"), { goalDir });
const search = await wiki.search("SHA-256 checksum payload rejection", 5);
assert.equal(search.mode, "hybrid");
const hit = search.results.find((result) => result.path.includes("orchid-protocol"));
assert.ok(hit, "published LLM Wiki page was not searchable");
const page = await wiki.readPage(hit.path);
assert.match(page.content, /checksum/iu);
assert.match(page.content, /integrity error/iu);
const graph = await wiki.graphSearch("Orchid Protocol", 5);
assert.ok(graph.nodes.some((node) => node.id.includes("orchid-protocol")));
console.log(JSON.stringify({
	searchMode: search.mode,
	hit: hit.path,
	sources: hit.sources,
	page: page.path,
	graphNodes: graph.nodes.map((node) => node.id),
}, null, 2));

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}
