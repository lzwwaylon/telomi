import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDocumentStore } from "../../server/lib/json-document-store.js";

const root = mkdtempSync(join(tmpdir(), "telomi-json-store-"));
try {
	const store = new JsonDocumentStore<{ count: number }>(join(root, "documents"));
	assert.deepEqual(store.list(), []);
	assert.equal(store.get("missing"), undefined);
	store.delete("missing");
	store.put("a", { count: 1 });
	assert.deepEqual(store.get("a"), { count: 1 });
	store.put("a", { count: 2 });
	assert.deepEqual(store.list(), [{ count: 2 }]);
	assert.equal(statSync(join(root, "documents", "a.json")).mode & 0o777, 0o600);
	assert.equal(readFileSync(join(root, "documents", "a.json"), "utf-8"), '{\n  "count": 2\n}\n');
	store.delete("a");
	assert.equal(store.get("a"), undefined);
	assert.deepEqual(store.list(), []);
	const validated = new JsonDocumentStore(join(root, "validated"), (value) => {
		if (typeof value !== "object" || value === null || !("count" in value) || typeof value.count !== "number") {
			throw new Error("count: expected number");
		}
		return { count: value.count };
	});
	assert.deepEqual(validated.list(), []);
	validated.put("good", { count: 3 });
	assert.deepEqual(validated.get("good"), { count: 3 });
	assert.deepEqual(validated.list(), [{ count: 3 }]);
	validated.delete("good");
	assert.equal(validated.get("good"), undefined);
	const badPath = join(root, "validated", "bad.json");
	writeFileSync(badPath, '{"count":"wrong"}');
	assert.throws(() => validated.get("bad"), (error: Error) => error.message.includes(badPath) && error.message.includes("count"));
	assert.throws(() => validated.list(), /bad\.json.*count/u);
	const unchecked = new JsonDocumentStore(join(root, "validated"));
	assert.deepEqual(unchecked.get("bad"), { count: "wrong" });
	assert.deepEqual(unchecked.list(), [{ count: "wrong" }]);
	writeFileSync(badPath, "{");
	assert.throws(() => validated.get("bad"), /bad\.json/u);
	assert.throws(() => validated.list(), /bad\.json/u);
	assert.throws(() => unchecked.get("bad"), /bad\.json/u);
	assert.deepEqual(unchecked.list(), []);
	writeFileSync(join(root, "validated", "notes.txt"), "ignored");
	mkdirSync(join(root, "validated", "directory.json"));
	assert.deepEqual(unchecked.list(), []);
	for (const id of ["", ".", "..", "../escape", "/absolute", "a/b", "a\\b", "a\0b"]) {
		assert.throws(() => store.get(id), /filename stem/u);
		assert.throws(() => store.put(id, { count: 1 }), /filename stem/u);
		assert.throws(() => store.delete(id), /filename stem/u);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("JSON document store passed");
