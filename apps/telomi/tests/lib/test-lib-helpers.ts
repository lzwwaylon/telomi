import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { createSha256, sha256, stableJson } from "../../server/lib/hash.js";
import { envBoolean, envNumber } from "../../server/lib/env.js";
import {
	appendJsonl,
	listFilesRecursive,
	listJsonDir,
	listJsonl,
	readJson,
	readJsonl,
	writeFileAtomic,
	writeJsonAtomic,
} from "../../server/lib/fs.js";
import {
	assertFileNameSegment,
	assertInsideRoot,
	basenameNoExt,
	ensureWithinRoot,
	isFileNameSegment,
	isInsideRoot,
	safeName,
	safeSegment,
	sanitizeFileName,
} from "../../server/lib/paths.js";
import { clipSummary, isRecord, toErrorMessage } from "../../server/lib/values.js";
import * as log from "../../server/lib/log.js";

const root = mkdtempSync(join(tmpdir(), "telomi-lib-"));

// Existing serialized identities keep their exact ordering and JSON conventions.
const mixedKeys = { z: [{ Z: 1, a: 2 }], a: 3, A: 4, "10": 5, "2": 6, omitted: undefined };
assert.equal(stableJson(mixedKeys, "lexical"), '{"10":5,"2":6,"A":4,"a":3,"omitted":undefined,"z":[{"Z":1,"a":2}]}');
assert.equal(stableJson(mixedKeys, "native"), '{"2":6,"10":5,"A":4,"a":3,"z":[{"Z":1,"a":2}]}');
assert.equal(stableJson({ z: [{ b: 2, a: 1 }], a: 0 }), '{"a":0,"z":[{"a":1,"b":2}]}');
assert.equal(stableJson([undefined, null], "native"), '[null,null]');
assert.equal(stableJson([undefined, null], "lexical"), '[,null]');
const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
assert.equal(sha256("abc"), abcHash);
assert.equal(sha256(Buffer.from("abc")), abcHash);
assert.equal(sha256("abc", "base64url"), Buffer.from(abcHash, "hex").toString("base64url"));
assert.equal(createSha256().update("a").update(Buffer.from("bc")).digest("hex"), abcHash);

// Path guard escape table.
const guardRoot = join(root, "guard");
mkdirSync(guardRoot);
const escapeCases: Array<[string, boolean]> = [
	["", true],
	["file.txt", true],
	["nested/deep/file.txt", true],
	["..foo", true],
	["a/../b", true],
	["..", false],
	[`..${sep}outside`, false],
	["a/../../outside", false],
	[`${guardRoot}-sibling/file`, false],
	[join(tmpdir(), "absolute-elsewhere"), false],
];
for (const [candidate, inside] of escapeCases) {
	assert.equal(isInsideRoot(guardRoot, candidate), inside, `isInsideRoot(${JSON.stringify(candidate)})`);
	if (inside) assertInsideRoot(guardRoot, candidate, "Test path");
	else assert.throws(() => assertInsideRoot(guardRoot, candidate, "Test path"), /Test path escapes/u);
}
assert.equal(isInsideRoot(guardRoot, join(guardRoot, "inner")), true);
assert.equal(isInsideRoot(guardRoot, `${guardRoot}-sibling`), false);

// Filename and observability identity normalization.
assert.equal(sanitizeFileName("/nested/Report  一.pdf"), "Report_.pdf");
assert.equal(sanitizeFileName(""), "attachment");
assert.equal(sanitizeFileName("A-b_1.txt"), "A-b_1.txt");
assert.equal(safeSegment("  Agent / CHILD  ", "agent"), "agent-child");
assert.equal(safeSegment("x".repeat(200), "agent"), "x".repeat(160));
assert.throws(() => safeSegment(" / ", "agent"), /agent identity is empty/u);

// Browser name compatibility: punctuation, empty output, and truncation order.
assert.equal(safeName(" --Hello / 世界__v1.2-- "), "Hello-__v1.2");
assert.equal(safeName("你好 / --"), "");
assert.equal(safeName("a".repeat(119) + " / b"), "a".repeat(119) + "-");
assert.equal(safeName("profile_1.2-3"), "profile_1.2-3");
// Research source names: shorter limit and a fallback for names that normalize to nothing.
assert.equal(safeName("你好", { maxLength: 100, fallback: "source" }), "source");
assert.equal(safeName("a".repeat(120), { maxLength: 100 }), "a".repeat(100));

// One directory entry name: what JSON document ids and Case Bundle segments must satisfy.
for (const value of ["run_1", "a.b-c", "..hidden"]) assert.equal(isFileNameSegment(value), true, value);
for (const value of ["", ".", "..", "a/b", "a\\b", "a\0b", 1, undefined]) assert.equal(isFileNameSegment(value), false, String(value));
assert.equal(assertFileNameSegment("run_1", "Run id"), "run_1");
assert.throws(() => assertFileNameSegment("../x", "Run id"), /Run id must be one filename stem/u);

// Atomic write: parent directories, mode, no leftover temp files.
const target = join(root, "atomic", "nested", "file.txt");
writeFileAtomic(target, "hello", { mode: 0o600 });
assert.equal(readFileSync(target, "utf-8"), "hello");
assert.equal(statSync(target).mode & 0o777, 0o600);
writeFileAtomic(target, "replaced");
assert.equal(readFileSync(target, "utf-8"), "replaced");
writeJsonAtomic(target, { a: 1 }, { mode: 0o600 });
assert.equal(readFileSync(target, "utf-8"), '{\n  "a": 1\n}\n');
assert.equal(statSync(target).mode & 0o777, 0o600);
assert.deepEqual(readdirSync(join(root, "atomic", "nested")), ["file.txt"]);

// Atomic write failure cleanup: renaming a file over a directory fails, temp must be removed.
const blockedTarget = join(root, "atomic", "blocked");
mkdirSync(blockedTarget, { recursive: true });
writeFileSync(join(blockedTarget, "keep"), "x");
assert.throws(() => writeFileAtomic(blockedTarget, "boom"));
assert.deepEqual(readdirSync(join(root, "atomic")).sort(), ["blocked", "nested"]);
assert.equal(readFileSync(join(blockedTarget, "keep"), "utf-8"), "x");

// JSON helpers.
const jsonDir = join(root, "json");
writeFileAtomic(join(jsonDir, "b.json"), JSON.stringify({ id: "b" }));
writeFileAtomic(join(jsonDir, "a.json"), JSON.stringify({ id: "a" }));
writeFileAtomic(join(jsonDir, "notes.txt"), "ignored");
assert.deepEqual(readJson<{ id: string }>(join(jsonDir, "a.json")), { id: "a" });
assert.throws(() => readJson(join(jsonDir, "missing.json")), /missing\.json/u);
writeFileSync(join(jsonDir, "broken.json"), "{");
assert.throws(() => readJson(join(jsonDir, "broken.json")), /broken\.json/u);
assert.deepEqual(
	listJsonDir<{ id: string }>(jsonDir).map((entry) => entry.value.id),
	["a", "b"],
);
assert.deepEqual(listJsonDir(join(root, "does-not-exist")), []);
assert.throws(() => listJsonDir(jsonDir, { strict: true }), /broken\.json/u);

// JSONL helpers.
const jsonlPath = join(root, "jsonl", "events.jsonl");
appendJsonl(jsonlPath, { n: 1 });
appendJsonl(jsonlPath, { n: 2 });
assert.deepEqual(readJsonl<{ n: number }>(jsonlPath), [{ n: 1 }, { n: 2 }]);
assert.equal(readFileSync(jsonlPath, "utf-8"), '{"n":1}\n{"n":2}\n');
assert.deepEqual(readJsonl(join(root, "jsonl", "missing.jsonl")), []);
writeFileSync(jsonlPath, '{"n":1}\n\nnot json\n');
assert.throws(() => readJsonl(jsonlPath), /events\.jsonl:3/u);

// Recursive listing: relative posix paths, sorted, files only.
const treeRoot = join(root, "tree");
writeFileAtomic(join(treeRoot, "z.txt"), "");
writeFileAtomic(join(treeRoot, "sub", "deeper", "a.txt"), "");
writeFileAtomic(join(treeRoot, "sub", "b.txt"), "");
mkdirSync(join(treeRoot, "empty"));
assert.deepEqual(listFilesRecursive(treeRoot), ["sub/b.txt", "sub/deeper/a.txt", "z.txt"]);
assert.deepEqual(listFilesRecursive(join(root, "no-such-tree")), []);

// Value helpers.
assert.equal(toErrorMessage(new Error("boom")), "boom");
assert.equal(toErrorMessage("plain"), "plain");
assert.equal(toErrorMessage({ code: 1 }), "[object Object]");
assert.equal(toErrorMessage(undefined), "undefined");
assert.equal(isRecord({}), true);
assert.equal(isRecord({ a: 1 }), true);
assert.equal(isRecord([]), false);
assert.equal(isRecord(null), false);
assert.equal(isRecord("x"), false);

// Env helpers.
const key = "TELOMI_LIB_TEST_ENV";
for (const value of ["1", "true", "YES", " on "]) {
	process.env[key] = value;
	assert.equal(envBoolean(key), true, `envBoolean(${value})`);
}
for (const value of ["0", "false", "no", "off", "", "maybe"]) {
	process.env[key] = value;
	assert.equal(envBoolean(key), false, `envBoolean(${JSON.stringify(value)})`);
}
delete process.env[key];
assert.equal(envBoolean(key), false);
assert.equal(envBoolean(key, true), true);
process.env[key] = "42";
assert.equal(envNumber(key, 7), 42);
process.env[key] = "4.9";
assert.equal(envNumber(key, 7), 4.9);
for (const value of ["", "abc", "NaN", "Infinity"]) {
	process.env[key] = value;
	assert.equal(envNumber(key, 7), 7, `envNumber(${JSON.stringify(value)})`);
}
delete process.env[key];
assert.equal(envNumber(key, 7), 7);

// Logger lives in lib.
assert.equal(typeof log.logInfo, "function");
assert.equal(typeof log.logWarning, "function");

// lib must not import business modules.
const libDir = join(process.cwd(), "server", "lib");
for (const file of readdirSync(libDir)) {
	const source = readFileSync(join(libDir, file), "utf-8");
	const imports = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]!);
	for (const specifier of imports) {
		assert.ok(
			specifier.startsWith("node:") || specifier.startsWith("./"),
			`server/lib/${file} imports ${specifier}`,
		);
	}
}

assert.ok(existsSync(root));

// Migrated callers retain JSONL traversal and strict file-path policies.
const sessions = join(root, "sessions");
writeFileAtomic(join(sessions, "a", "nested.jsonl"), "");
writeFileAtomic(join(sessions, "z.jsonl"), "");
writeFileAtomic(join(sessions, "ignored.txt"), "");
symlinkSync(join(sessions, "z.jsonl"), join(sessions, "link.jsonl"));
assert.deepEqual(listJsonl(sessions), [join(sessions, "a", "nested.jsonl"), join(sessions, "link.jsonl"), join(sessions, "z.jsonl")]);
assert.deepEqual(listJsonl(sessions, { regularFilesOnly: true }), [join(sessions, "a", "nested.jsonl"), join(sessions, "z.jsonl")]);
assert.deepEqual(listJsonl(join(sessions, "z.jsonl")), [join(sessions, "z.jsonl")]);
assert.deepEqual(listJsonl(join(root, "missing")), []);
for (const candidate of ["", ".", "..", "../outside", "..hidden", `${guardRoot}-sibling/file`]) {
	assert.throws(() => ensureWithinRoot(guardRoot, candidate), /escapes the workspace root/);
}
assert.equal(ensureWithinRoot(guardRoot, "nested/file"), join(guardRoot, "nested/file"));
assert.throws(() => ensureWithinRoot(guardRoot, "..", "artifacts root"), /escapes the artifacts root/);
assert.equal(basenameNoExt("nested/report.part.md"), "report.part");
assert.equal(basenameNoExt(".hidden"), ".hidden");
assert.equal(basenameNoExt("plain"), "plain");
assert.equal(clipSummary("  one\n two\t "), "one two");
assert.equal(clipSummary("a".repeat(80)), "a".repeat(80));
assert.equal(clipSummary("a".repeat(81)), `${"a".repeat(80)}…`);

// Replay traversal preserves depth-first order and exposes unsafe Bundle entries for rejection.
assert.deepEqual(listFilesRecursive(sessions, { absolute: true, sort: false }), [
	join(sessions, "a", "nested.jsonl"), join(sessions, "ignored.txt"), join(sessions, "z.jsonl"),
]);
symlinkSync(join(sessions, "a"), join(sessions, "linked-directory"));
assert.deepEqual(listFilesRecursive(sessions, { includeNonRegular: true }), [
	"a/nested.jsonl", "ignored.txt", "link.jsonl", "linked-directory", "z.jsonl",
]);
assert.throws(() => listFilesRecursive(join(root, "missing"), { strict: true }), /ENOENT/);

// Consolidated callers retain their stricter path and traversal policies.
assert.equal(isInsideRoot(guardRoot, "..hidden", { rejectDotPrefix: true }), false);
assert.equal(isInsideRoot(guardRoot, guardRoot, { rejectDotPrefix: true }), true);
assert.equal(isInsideRoot(guardRoot, "nested/file", { rejectDotPrefix: true }), true);
assert.throws(() => assertInsideRoot(guardRoot, guardRoot, "fixture", { allowRoot: false }), /fixture escapes/u);
assert.equal(assertInsideRoot(guardRoot, "..hidden", "fixture", { allowRoot: false }), join(guardRoot, "..hidden"));
assert.equal(isInsideRoot(guardRoot, "", { allowRoot: false }), false);
assert.equal(isInsideRoot(guardRoot, guardRoot, { allowRoot: false }), false);
assert.equal(isInsideRoot(guardRoot, "..hidden", { rejectDotPrefix: true, allowRoot: false }), false);
assert.equal(isInsideRoot(guardRoot, "nested", { rejectDotPrefix: true, allowRoot: false }), true);
assert.deepEqual(listFilesRecursive(treeRoot, { strict: true, rejectNonRegular: true }), ["sub/b.txt", "sub/deeper/a.txt", "z.txt"]);
assert.throws(() => listFilesRecursive(sessions, { strict: true, rejectNonRegular: true }), /contains non-file/u);

console.log("lib helpers passed");
