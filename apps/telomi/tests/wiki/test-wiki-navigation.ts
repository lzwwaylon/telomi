import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import type { GoalService } from "../../server/goals/service.js";
import { createWikiRouter } from "../../server/wiki/api.js";
import { createWikiRuntime } from "../../server/wiki/model/index.js";
import { GoalWikiSearch } from "../../server/wiki/local-search.js";

const workspace = mkdtempSync(join(tmpdir(), "wiki-navigation-"));
const goalId = "goal-navigation";
const root = join(workspace, goalId, "wiki", "knowledge");
mkdirSync(join(root, "entities"), { recursive: true });
mkdirSync(join(root, "concepts"));
const objectPath = join(root, "entities", "object.md");
const conceptPath = join(root, "concepts", "concept.md");
const object = "---\npage_id: entity:canonical-object\ntype: entity\ntitle: Actual object\ndescription: Independent operating procedure\nprimary_topic_ref: obsolete\ntopic_refs: [obsolete]\n---\n# Actual object\n\n## Procedure\n\nSelective filtering procedure.\n";
const concept = "---\npage_id: concept:canonical-concept\ntype: concept\ntitle: General principle\ndescription: Explanation\n---\n# General principle\n\n## Principle\n\nGeneral explanation.\n";
writeFileSync(objectPath, object);
writeFileSync(conceptPath, concept);
const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value));
write(".topic-plan.json", { schema_version: 1, goal_id: goalId, revision: "navigation-test", status: "active", topics: [
	{ id: "procedure", title: "Procedure", intent: "Operating procedures", questions: [], include: [], exclude: [] },
	{ id: "principle", title: "Principle", intent: "General principles", questions: [], include: [], exclude: [] },
] });
const sections = [
	{ ref: "section:object", pageId: "entity:canonical-object", heading: "Procedure", anchor: "procedure" },
	{ ref: "section:concept", pageId: "concept:canonical-concept", heading: "Principle", anchor: "principle" },
];
const index = { schema_version: 1, sections, topics: [
	{ topicId: "procedure", sections: ["section:object"] }, { topicId: "principle", sections: ["section:concept"] },
] };
const edge = { from: "entity:canonical-object", to: "concept:canonical-concept", label: "provides a concrete example" };
write(".topic-index.json", index);
write(".object-first-relations.json", [edge]);
const app = express();
app.use(createWikiRouter(workspace, { getGoal: (id: string) => id === goalId ? { id } : undefined } as unknown as GoalService));
const server = app.listen(0);
await new Promise<void>(resolve => server.once("listening", resolve));
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/goals/${goalId}/wiki`;
try {
	const runtime = createWikiRuntime(root);
	const tree = await runtime.readTree();
	assert.deepEqual(tree.pages.find(page => page.pageId === edge.from)?.topicRefs, ["procedure"]);
	assert.equal(tree.pages.find(page => page.pageId === edge.from)?.primaryTopicRef, "");
	assert.equal(tree.pages.find(page => page.pageId === edge.from)?.path, "entities/object.md");
	const target = await runtime.readPage("concepts/concept.md");
	assert.deepEqual(target.backlinks, ["entities/object"]);
	assert.equal(target.relations[0]?.direction, "incoming");
	assert.equal(target.relations[0]?.label, edge.label);
	assert.equal(target.relations[0]?.page.path, "entities/object.md");
	assert.deepEqual(target.sections[0]?.topicRefs, ["principle"]);
	const source = await runtime.readPage("entities/object.md");
	assert.equal(source.relations[0]?.direction, "outgoing");
	assert.equal(source.relations[0]?.from, edge.from);
	assert.equal(source.relations[0]?.to, edge.to);
	const graph = await runtime.buildGraph();
	assert.equal(graph.edges.length, 1, "explicit relation creates navigable graph edge without a Markdown link");
	assert.deepEqual(graph.relations, [edge]);
	const unpublished = await fetch(`${api}?revision=confirmed-but-pending`);
	assert.equal(unpublished.status, 404, "a confirmed plan need not have a published Edition yet");
	const publishedWhilePending = await fetch(api);
	assert.equal(publishedWhilePending.status, 200);
	assert.equal((await publishedWhilePending.json()).pages.length, 2, "current reading continues to serve the published pages during navigation updates");
	const pinned = await fetch(`${api}?revision=navigation-test`);
	assert.equal(pinned.status, 200, "an explicit existing historical revision remains readable");
	assert.equal((await pinned.json()).edition.revision, "navigation-test");
	const response = await fetch(`${api}/page?path=concepts/concept.md`);
	assert.equal(response.status, 200);
	assert.equal((await response.json()).relations[0].page.pageId, edge.from);
	const search = new GoalWikiSearch(root, { embedding: async () => undefined });
	assert.equal((await search.search("filtering", 10, undefined, "procedure")).results[0]?.path, "wiki/entities/object.md");
	assert.equal((await search.search("filtering", 10, undefined, "principle")).results.length, 0);
	assert.equal((await search.search("filtering", 10, undefined, "obsolete")).results.length, 0);
	assert.equal(readFileSync(objectPath, "utf8"), object);
	assert.equal(readFileSync(conceptPath, "utf8"), concept);
	write(".topic-index.json", { ...index, topics: [] });
	assert.ok((await createWikiRuntime(root).readTree()).pages.every(page => page.topicRefs.length === 0), "empty independent index never revives stale Topic refs");
	write(".topic-index.json", { ...index, topics: [{ topicId: "broken", sections: ["unknown"] }] });
	await assert.rejects(createWikiRuntime(root).readTree(), /unknown Topic section/u);
	write(".topic-index.json", index);
	write(".object-first-relations.json", [{ ...edge, to: "missing" }]);
	await assert.rejects(createWikiRuntime(root).buildGraph(), /unknown or identical endpoint/u);
	write(".object-first-relations.json", []);
	rmSync(conceptPath);
	write(".topic-index.json", { schema_version: 1, sections: [sections[0]], topics: [index.topics[0]] });
	const onlyObject = await createWikiRuntime(root).readTree();
	assert.equal(onlyObject.pages.length, 1);
	assert.deepEqual(onlyObject.pages[0]?.topicRefs, ["procedure"]);
	assert.equal((await createWikiRuntime(root).readPage("entities/object.md")).relations.length, 0);
	rmSync(join(root, ".topic-index.json"));
	rmSync(join(root, ".object-first-relations.json"));
	assert.deepEqual((await createWikiRuntime(root).readTree()).pages[0]?.topicRefs, ["obsolete"], "historical Editions retain frontmatter membership");
	console.log("Wiki navigation: canonical sections, directed relationships, API, search, object-only and legacy compatibility passed");
} finally {
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	rmSync(workspace, { recursive: true, force: true });
}
