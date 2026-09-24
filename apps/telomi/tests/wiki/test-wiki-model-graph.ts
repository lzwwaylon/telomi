import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWikiGraph } from "../../server/wiki/model/graph.js";

const root = mkdtempSync(join(tmpdir(), "telomi-wiki-graph-"));
mkdirSync(join(root, "concepts"));
writeFileSync(join(root, "concepts", "alpha.md"), page("Alpha", "beta.md"));
writeFileSync(join(root, "concepts", "beta.md"), page("Beta", "alpha.md"));
writeFileSync(join(root, "README.md"), "# Goal Wiki\n\nNavigation index only.\n");

const graph = await buildWikiGraph(root);
assert.deepEqual(graph.edges.map(({ source, target }) => [source, target]), [
	["concepts/alpha", "concepts/beta"],
]);
assert.deepEqual(graph.nodes.map(({ id, linkCount }) => [id, linkCount]), [
	["concepts/alpha", 1],
	["concepts/beta", 1],
]);
assert.deepEqual(graph.nodes.map(({ primaryTopicRef, topicRefs }) => [primaryTopicRef, topicRefs]), [
	["topic-alpha", ["topic-alpha"]],
	["topic-alpha", ["topic-alpha"]],
]);
assert.deepEqual(graph.edges[0]?.signals, { direct: 6, sourceOverlap: 0, adamicAdar: 0, typeAffinity: 0.8 });
assert.equal(graph.edges[0]?.weight, 6.8);
console.log("wiki runtime graph: reciprocal links collapse to one undirected edge");

function page(title: string, related: string): string {
	return `---\ntype: concept\ntitle: ${JSON.stringify(title)}\nprimary_topic_ref: topic-alpha\ntopic_refs: [topic-alpha]\n---\n\n# ${title}\n\n## Related\n\n- [Related](${related}) - related\n`;
}
