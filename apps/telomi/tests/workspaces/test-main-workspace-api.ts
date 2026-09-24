import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkspaceRouter } from "../../server/workspaces/api.js";
import { GoalService } from "../../server/goals/service.js";
import { unusedGoalExecution } from "../goals/unused-execution.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/store.js";
import { fileIngestCacheEntryDir, parsedDocumentsDir } from "../../server/workspaces/goal-runtime-paths.js";

const root = mkdtempSync(join(tmpdir(), "main-workspace-api-"));
const goalId = "goal_workspace";
const goal = join(root, goalId);
const put = (path: string, text = path) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const service = new GoalService(root, unusedGoalExecution);
service.ensureImportedGoal(goalId, "Workspace");
put(join(goal, "artifacts/main/note.md"), "# Note\n\nWorkspace body\n");
put(join(goal, "artifacts/chart.json"), "{}");
put(join(goal, "attachments/input.txt"), "input");
// Attachment ids are the storage key; folder members and everything nested keep the user's own names.
const attachmentKey = "6d5a72e2-a417-42fa-ba89-a28f12a9adbb";
const folderKey = "5d47a047-a8e1-4f67-ad62-1cbf0b136355";
const unicodeKey = "0ea556f4-c463-4036-811e-b2d70204ac8e";
put(join(goal, `attachments/${attachmentKey}_parse-test.pdf`), "%PDF-1.4");
// The Goal's own Session log, with no runner loaded: a cold list still knows the user's own names.
put(join(goal, `attachments/${unicodeKey}__145.md`), "# 中文");
const unicodeAttachment = {
	id: unicodeKey, type: "document", fileName: "中文文件 145.md", mimeType: "text/markdown", size: 7, content: "",
};
const session = SessionManager.open(join(goal, "context.jsonl"), goal, goal);
session.appendMessage({ role: "user-with-attachments", content: "private session", attachments: [unicodeAttachment], timestamp: Date.now() } as never);
session.appendMessage({ role: "assistant", content: [{ type: "text", text: "好" }], timestamp: Date.now() } as never);
put(join(goal, `attachments/${folderKey}_parser.metadata.json`), "{\"mine\":true}");
put(join(goal, `attachments/${folderKey}_folder-check/${attachmentKey}_user-file.md`), "# Nested");
const documentKey = "d".repeat(64);
const duplicateKey = "e".repeat(64);
const memberKey = "0".repeat(64);
const unparsedKey = "f".repeat(64);
for (const [key, title] of [[documentKey, "parse-test.pdf"], [duplicateKey, "parse-test.pdf"], [memberKey, "folder-check/user-file.md"]]) {
	put(join(fileIngestCacheEntryDir(goal, key!), "metadata.json"), JSON.stringify({ version: 1, title }));
}
for (const key of [documentKey, duplicateKey, memberKey, unparsedKey]) {
	put(join(parsedDocumentsDir(goal), key, "document.md"), "# Parsed text");
	put(join(parsedDocumentsDir(goal), key, "document.canonical.json"), "{}");
	put(join(parsedDocumentsDir(goal), key, "parser.metadata.json"), "{}");
}
put(join(parsedDocumentsDir(goal), "parsed/doc.md"), "# Parsed");
put(join(goal, "wiki/runs/report_1/report/final.md"), "# Report");
put(join(goal, "wiki/runs/report_1/raw/private.txt"), "private source");
put(join(goal, ".pi/credentials/secret"), "secret");
put(join(root, "outside.txt"), "outside");
symlinkSync(join(root, "outside.txt"), join(goal, "artifacts/main/escape.txt"));
symlinkSync(join(goal, "artifacts/main"), join(goal, "artifacts/alias"), "dir");
for (let index = 0; index < 4001; index++) put(join(goal, "artifacts/main/many", `${index}.txt`), "x");
let activeDirectories: { workDirectory: string; artifactsDirectory: string } | undefined;
service.getMainWorkspaceDirectories = () => activeDirectories;
const app = express();
app.use(createWorkspaceRouter(root, service));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/api/goals/${goalId}/workspace`;
try {
	const listed = await (await fetch(`${base}/list`)).json() as { files: Array<{ path: string; displayPath?: string }>; truncated: boolean };
	const paths = listed.files.map((file) => file.path);
	assert.ok(paths.includes("/work/note.md"), "list must use the same guest paths as Main Agent");
	assert.ok(paths.includes("/work/many/4000.txt"), "all visible files must be listed beyond the old 4000 cap");
	assert.ok(paths.includes("/work/topic-plan.json"), "The derived Topic Plan exists even before a work directory is prepared");
	assert.equal(paths.length, 4015);
	assert.equal(listed.truncated, false);
	const displayed = new Map(listed.files.map((file) => [file.path, file.displayPath]));
	assert.equal(displayed.get(`/attachments/${attachmentKey}_parse-test.pdf`), "/attachments/parse-test.pdf");
	assert.equal(displayed.get(`/attachments/${folderKey}_folder-check/${attachmentKey}_user-file.md`),
		`/attachments/folder-check/${attachmentKey}_user-file.md`,
		"only the stored attachment key is a key; a nested name that looks like one belongs to the user");
	assert.equal(displayed.get("/attachments/input.txt"), undefined, "a name without a storage key needs no display name");
	assert.equal(displayed.get(`/attachments/${unicodeKey}__145.md`), "/attachments/中文文件 145.md",
		"a cold Goal names its files from its own Session log, before any Agent is loaded");
	assert.equal(displayed.get(`/documents/${documentKey}/document.md`), "/documents/parse-test.pdf/document.md");
	assert.equal(displayed.get(`/documents/${duplicateKey}/document.md`), "/documents/parse-test.pdf/document.md",
		"two sources sharing a name keep separate entries under their own keys");
	assert.equal(displayed.get(`/documents/${memberKey}/document.md`), "/documents/user-file.md/document.md",
		"a folder member is titled by its folder-relative path; only the file name is a label");
	assert.equal(displayed.get(`/documents/${unparsedKey}/document.md`), undefined,
		"a missing ingestion record leaves the guest path as it is");
	assert.equal(paths.some((path) => path.startsWith(`/documents/${documentKey}/`) && !path.endsWith("/document.md")), false,
		"parser internals stay out of the user file list");
	assert.ok(paths.includes(`/attachments/${folderKey}_parser.metadata.json`),
		"a user file sharing the name of a parser internal stays listed");
	assert.ok(paths.includes("/documents/parsed/doc.md"), "only a parsed entry directory holds parser internals");
	for (const internal of ["document.canonical.json", "parser.metadata.json"]) {
		const response = await fetch(`${base}/blob?path=${encodeURIComponent(`/documents/${documentKey}/${internal}`)}`);
		assert.equal(response.status, 200, "hiding parser internals from the list must not change what is readable");
	}
	for (const path of ["note.md", "./note.md", "/work/note.md"]) {
		const response = await fetch(`${base}/blob?path=${encodeURIComponent(path)}`);
		assert.equal(response.status, 200, path);
		assert.equal(response.headers.get("x-workspace-path"), "/work/note.md");
		assert.match(await response.text(), /Workspace body/u);
	}
	for (const [path, guest] of [["/reports/report_1/final.md", "/reports/report_1/final.md"], ["/attachments/input.txt", "/attachments/input.txt"]]) {
		const response = await fetch(`${base}/blob?path=${encodeURIComponent(path!)}`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-workspace-path"), guest);
	}
	const slice = await (await fetch(`${base}/file-slice?path=note.md&start=1`)).json() as { path: string; lines: Array<{ text: string }> };
	assert.equal(slice.path, "/work/note.md");
	assert.equal(slice.lines[0]?.text, "# Note");
	for (const path of ["artifacts/main/note.md", "wiki/runs/report_1/report/final.md", "attachments/input.txt", join(goal, "artifacts/main/note.md"), join(root, "outside.txt"), "/artifacts/main/note.md", "/artifacts/alias/note.md", "/work/escape.txt", "../../outside.txt", "context.jsonl", ".pi/credentials/secret", "wiki/runs/report_1/raw/private.txt"]) {
		for (const endpoint of ["blob", "file-slice"]) {
			const response = await fetch(`${base}/${endpoint}?path=${encodeURIComponent(path)}&start=1`);
			assert.ok(response.status >= 400, `${endpoint} must reject ${path}`);
			assert.doesNotMatch(await response.text(), /private session|private source|"secret"/u);
		}
	}
	assert.equal((await fetch(base.replace(goalId, "missing") + "/list")).status, 404);
	assert.equal((await fetch(base.replace(goalId, "%2e%2e%2fother") + "/list")).status, 400);
	const topicStore = new GoalTopicPlanStore(goalId, root);
	const draft = { topics: [{ title: "Speech synthesis", intent: "Understand speech models" }] };
	const proposed = topicStore.syncDocument({ document: draft, source: "main_agent", summary: "Draft" });
	assert.ok(proposed.proposal);
	// A stale published file must not win over the current unconfirmed document.
	put(join(goal, "artifacts/main/topic-plan.json"), JSON.stringify({ topics: [] }));
	const topicResponse = await fetch(`${base}/blob?path=topic-plan.json`);
	assert.equal(topicResponse.status, 200);
	assert.equal(topicResponse.headers.get("x-workspace-path"), "/work/topic-plan.json");
	assert.deepEqual(await topicResponse.json(), draft, "Unconfirmed Topic IDs remain absent, just like Main Agent prepare");
	const topicSlice = await (await fetch(`${base}/file-slice?path=/work/topic-plan.json&start=1&end=20`)).json() as { lines: Array<{ text: string }> };
	assert.match(topicSlice.lines.map((line) => line.text).join("\n"), /Speech synthesis/u);
	const revised = { topics: [{ ...draft.topics[0]!, title: "Voice models" }] };
	topicStore.syncDocument({ document: revised, source: "main_agent", summary: "Revised" });
	assert.deepEqual(await (await fetch(`${base}/blob?path=/work/topic-plan.json`)).json(), revised);
	const artifactsDirectory = join(root, "live/artifacts");
	const workDirectory = join(artifactsDirectory, "main");
	put(join(workDirectory, "note.md"), "# Live draft");
	put(join(workDirectory, "topic-plan.json"), JSON.stringify(draft));
	put(join(artifactsDirectory, "live-only.txt"), "Live artifact");
	activeDirectories = { workDirectory, artifactsDirectory };
	assert.equal(await (await fetch(`${base}/blob?path=note.md`)).text(), "# Live draft");
	assert.deepEqual(await (await fetch(`${base}/blob?path=topic-plan.json`)).json(), draft, "Active Agent edits take precedence over the stored proposal");
	const activeList = await (await fetch(`${base}/list`)).json() as { files: Array<{ path: string }> };
	assert.ok(activeList.files.some((file) => file.path === "/artifacts/live-only.txt"));
	assert.equal(activeList.files.some((file) => file.path.startsWith("/work/many/")), false,
		"Active isolated files replace the published work/artifacts view");
	activeDirectories = undefined;
	assert.match(await (await fetch(`${base}/blob?path=note.md`)).text(), /Workspace body/u);
	rmSync(join(goal, "artifacts/main"), { recursive: true, force: true });
	assert.deepEqual(await (await fetch(`${base}/blob?path=topic-plan.json`)).json(), revised,
		"The derived document remains readable without a physical work directory");
	const noWork = await (await fetch(`${base}/list`)).json() as { files: Array<{ path: string }> };
	assert.equal(noWork.files.filter((file) => file.path === "/work/topic-plan.json").length, 1);
	// Even a symlink to another directory inside this Goal must not widen a business mount.
	rmSync(parsedDocumentsDir(goal), { recursive: true, force: true });
	symlinkSync(join(goal, ".pi/credentials"), parsedDocumentsDir(goal), "dir");
	assert.ok((await fetch(`${base}/blob?path=${encodeURIComponent("/documents/secret")}`)).status >= 400);
	assert.equal((await fetch(`${base}/list`)).status, 500);
	console.log("Main Agent business workspace HTTP paths, visibility, and isolation passed");
} finally {
	server.close();
	await once(server, "close");
	rmSync(root, { recursive: true, force: true });
}
