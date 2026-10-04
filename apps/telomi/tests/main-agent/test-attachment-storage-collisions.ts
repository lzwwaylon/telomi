import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import type { AttachmentPayload } from "../../shared/types.js";
import {
	attachmentCaseDescriptors, attachmentPayloadsFromCase, attachmentRelativePath, persistAttachments,
} from "../../server/main-agent/attachment-utils.js";
import { attachmentDisplayPaths } from "../../server/workspaces/workspace-display.js";

const root = mkdtempSync(join(tmpdir(), "attachment-collisions-"));
const member = (relativePath: string, content: string, folderId = "folder"): AttachmentPayload => ({
	id: content, type: "document", fileName: relativePath.split("/").at(-1)!,
	mimeType: "text/plain", size: Buffer.byteLength(content), folderId, relativePath,
	content: Buffer.from(content).toString("base64"),
});

try {
	const paths = ["project/项目甲.txt", "project/项目乙.txt", "project/a b.txt", "project/a_b.txt",
		"project/a?b.txt", "project/a*b.txt", "project/目录甲/same.txt", "project/目录乙/same.txt",
		"project/a b/same.txt", "project/a_b/same.txt"];
	const attachments = paths.map((path, index) => member(path, `CONTENT-${index}`));
	const saved = await persistAttachments(root, attachments);
	assert.equal(new Set(saved).size, attachments.length, "normalized names and directories must not share storage");
	for (const [index, path] of saved.entries()) {
		assert.equal(readFileSync(path, "utf8"), `CONTENT-${index}`);
		assert.ok(path.endsWith(".txt"), "storage preserves the extension used by previews and downloads");
	}
	const display = attachmentDisplayPaths(attachments);
	for (const [index, attachment] of attachments.entries()) {
		const guest = `/attachments/${attachmentRelativePath(attachment).split(sep).join("/")}`;
		assert.equal(display.get(guest), `/attachments/${paths[index]}`, "original hierarchy stays independent of storage keys");
	}
	const descriptors = attachmentCaseDescriptors(attachments);
	assert.ok(descriptors.every((descriptor) => descriptor.storageVersion === 2));
	assert.deepEqual(attachmentPayloadsFromCase(root, descriptors).map((item) => item.content), attachments.map((item) => item.content));
	assert.deepEqual(await persistAttachments(root, attachments), saved, "an identical retry is idempotent");
	await assert.rejects(persistAttachments(root, [{ ...attachments[0]!, content: Buffer.from("REPLACEMENT").toString("base64") }]), /conflicts with an existing file/u);
	assert.equal(readFileSync(saved[0]!, "utf8"), "CONTENT-0", "conflicting retries cannot change existing bytes");
	const fresh = member("project/new.txt", "NEW");
	await assert.rejects(persistAttachments(root, [fresh, { ...attachments[0]!, content: Buffer.from("REPLACEMENT").toString("base64") }]), /conflicts with an existing file/u);
	assert.equal(existsSync(join(root, "attachments", attachmentRelativePath(fresh))), false,
		"an existing conflict is detected before an earlier new member is written");
	assert.equal(readFileSync(saved[0]!, "utf8"), "CONTENT-0");

	const duplicates = [member("duplicate/same.txt", "FIRST", "duplicate"), member("duplicate/same.txt", "SECOND", "duplicate")];
	await assert.rejects(persistAttachments(root, duplicates), /conflicting storage paths/u);
	assert.equal(existsSync(join(root, "attachments", "duplicate_duplicate")), false, "duplicate input fails before writing either member");
	await assert.rejects(persistAttachments(root, [member("project/file.txt", "ESCAPE", "../escape")]), /safe relative path/u);

	// Historical records and Cases keep their original, unversioned storage path.
	const legacy = member("project/历史.txt", "LEGACY");
	const legacyPath = attachmentRelativePath(legacy);
	assert.equal(legacyPath, join("folder_project", "_.txt"));
	await writeFile(join(root, "attachments", legacyPath), "LEGACY");
	const legacyDescriptors = attachmentCaseDescriptors([legacy]);
	assert.equal(legacyDescriptors[0]!.storageVersion, undefined);
	assert.equal(attachmentPayloadsFromCase(root, legacyDescriptors)[0]!.content, legacy.content);
	assert.equal(attachmentDisplayPaths([legacy]).get("/attachments/folder_project/_.txt"), "/attachments/project/历史.txt");
	console.log("Attachment collision protection, original hierarchy, retries and historical Case paths passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
