import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { AttachmentPayload } from "../../shared/types.js";
import { attachmentOriginalPath, attachmentRelativePath } from "../../server/main-agent/attachment-utils.js";
import { readSessionAttachments, sessionEntryAttachments } from "../../server/main-agent/session-attachments.js";
import { attachmentDisplayPaths, workspaceDisplayPath } from "../../server/workspaces/workspace-display.js";
import { GoalService } from "../../server/goals/service.js";
import { unusedGoalExecution } from "../goals/unused-execution.js";

const root = mkdtempSync(join(tmpdir(), "attachment-display-names-"));
const goalId = "goal_names";
const goalDir = join(root, goalId);
mkdirSync(goalDir, { recursive: true });

const document = (fields: Partial<AttachmentPayload>): AttachmentPayload => ({
	id: "11111111-2222-3333-4444-555555555555", type: "document", fileName: "file.md",
	mimeType: "text/markdown", size: 1, content: "", ...fields,
});

// The stored name is sanitized, so it is only a key; the record keeps what the user typed.
const chinese = document({ id: "0ea556f4-c463-4036-811e-b2d70204ac8e", fileName: "中文文件 145.md" });
assert.equal(attachmentRelativePath(chinese), "0ea556f4-c463-4036-811e-b2d70204ac8e__145.md");
assert.equal(attachmentOriginalPath(chinese), "中文文件 145.md");

const folderId = "5d47a047-a8e1-4f67-ad62-1cbf0b136355";
const member = document({ folderId, relativePath: "资料 folder/子目录/记录 1.md" });
assert.equal(attachmentRelativePath(member), join(`${folderId}__folder`, "_", "_1.md"));
assert.equal(attachmentOriginalPath(member), "资料 folder/子目录/记录 1.md");
// A label path must line up with the path it labels, segment for segment.
for (const attachment of [chinese, member, document({ folderId, relativePath: "flat.md" })]) {
	assert.equal(attachmentOriginalPath(attachment)!.split("/").length,
		attachmentRelativePath(attachment).split(/[\\/]/u).length, attachment.fileName);
}
// Nothing usable as a name leaves the stored name in place.
assert.equal(attachmentOriginalPath(document({ fileName: ".." })), undefined);
assert.equal(attachmentOriginalPath(document({ fileName: "" })), undefined);

const recorded = attachmentDisplayPaths([chinese, member]);
assert.equal(recorded.get("/attachments/0ea556f4-c463-4036-811e-b2d70204ac8e__145.md"),
	"/attachments/中文文件 145.md");
assert.equal(recorded.get(`/attachments/${folderId}__folder/_/_1.md`), "/attachments/资料 folder/子目录/记录 1.md");
assert.equal(workspaceDisplayPath(goalDir, "/attachments/0ea556f4-c463-4036-811e-b2d70204ac8e__145.md", recorded),
	"/attachments/中文文件 145.md", "the record the name came from wins over the stored name");
assert.equal(workspaceDisplayPath(goalDir, "/attachments/0ea556f4-c463-4036-811e-b2d70204ac8e_text-test.md", recorded),
	"/attachments/text-test.md", "an unrecorded file still loses its storage key");
assert.equal(workspaceDisplayPath(goalDir, "/attachments/plain.md", recorded), undefined);

// Cold Goal: the same records come from the Session log, with no Agent and no runner.
const contextFile = join(goalDir, "context.jsonl");
const session = SessionManager.open(contextFile, goalDir, goalDir);
const firstTurn = session.appendMessage({
	role: "user-with-attachments", content: "看看这个", attachments: [chinese, member], timestamp: Date.now(),
} as never);
session.appendMessage({ role: "assistant", content: [{ type: "text", text: "收到" }], timestamp: Date.now() } as never);
// Compaction drops summarized turns from the model context, but their files are still on disk.
const kept = session.appendMessage({ role: "user", content: "继续", timestamp: Date.now() } as never);
session.appendCompaction("earlier turns", kept, 1000);
const later = document({ id: "7c1b6d20-1111-4222-8333-444455556666", fileName: "后来的 文件.md" });
session.appendMessage({
	role: "user-with-attachments", content: "再看这个", attachments: [later], timestamp: Date.now(),
} as never);
session.appendMessage({ role: "assistant", content: [{ type: "text", text: "好" }], timestamp: Date.now() } as never);

const contextNames = session.buildSessionContext().messages
	.flatMap((message) => (message as { attachments?: AttachmentPayload[] }).attachments ?? [])
	.map((attachment) => attachment.fileName);
assert.equal(contextNames.includes(chinese.fileName), false,
	"fixture must actually summarize the first turn out of the model context");
assert.deepEqual(readSessionAttachments(goalDir).map((attachment) => attachment.fileName),
	[chinese.fileName, member.fileName, later.fileName],
	"a name whose file is still on disk survives Compaction");
assert.deepEqual(sessionEntryAttachments(session.getEntries()), readSessionAttachments(goalDir),
	"a loaded Session and its log yield the same records");
assert.ok(firstTurn);
assert.deepEqual(readSessionAttachments(join(root, "goal_missing")), [], "no Session log, no records");

const service = new GoalService(root, unusedGoalExecution);
service.ensureImportedGoal(goalId, "Names");
assert.deepEqual(service.listAttachments(goalId).map((attachment) => attachment.fileName),
	[chinese.fileName, member.fileName, later.fileName], "an unloaded Goal reads its own Session log");
const loaded = document({ id: "99999999-9999-4999-8999-999999999999", fileName: "已加载.md" });
(service as unknown as { runners: Map<string, { listAttachments: () => AttachmentPayload[] }> })
	.runners.set(goalId, { listAttachments: () => [loaded] });
assert.deepEqual(service.listAttachments(goalId).map((attachment) => attachment.fileName), [loaded.fileName],
	"a loaded Session is the live record and is not re-read from disk");

rmSync(root, { recursive: true, force: true });
console.log("Attachment display names and Session records passed");
