import assert from "node:assert/strict";
import { buildTree, mergeArtifacts } from "../../web/src/features/chat/ChatRightDock.js";
import {
	displayPathLabel, downloadName, fileLabel, folderLabel,
} from "../../web/src/features/chat/workspace-file-names.js";
import { uiText } from "../../web/src/app/ui-text.js";

const attachmentKey = "6d5a72e2-a417-42fa-ba89-a28f12a9adbb";
const folderKey = "5d47a047-a8e1-4f67-ad62-1cbf0b136355";
const documentKey = "d".repeat(64);
const otherDocumentKey = "e".repeat(64);
const unparsedKey = "f".repeat(64);

const file = (path: string, displayPath?: string, mtimeMs = 0) => ({
	path, ...(displayPath ? { displayPath } : {}), size: 1, modifiedAt: new Date(mtimeMs).toISOString(), mtimeMs,
});

const files = mergeArtifacts(new Map(), [
	file(`/attachments/${attachmentKey}_parse-test.pdf`, "/attachments/parse-test.pdf", 6),
	// Two uploads of the same name read alike and must still address different files.
	file(`/attachments/${folderKey}_duplicate.md`, "/attachments/duplicate.md", 5),
	file(`/attachments/${attachmentKey}_duplicate.md`, "/attachments/duplicate.md", 5),
	// A nested member keeps whatever the user named it, even when that looks like a storage key.
	file(`/attachments/${folderKey}_folder-check/${attachmentKey}_user-file.md`, `/attachments/folder-check/${attachmentKey}_user-file.md`, 4),
	file(`/documents/${documentKey}/document.md`, "/documents/parse-test.pdf/document.md", 3),
	file(`/documents/${otherDocumentKey}/document.md`, "/documents/parse-test.pdf/document.md", 2),
	file(`/documents/${unparsedKey}/document.md`, undefined, 1),
]);

// Rows are keyed by the guest path: same-name uploads stay separate files.
assert.deepEqual([...files.keys()], [
	`/attachments/${attachmentKey}_parse-test.pdf`,
	`/attachments/${folderKey}_duplicate.md`,
	`/attachments/${attachmentKey}_duplicate.md`,
	`/attachments/${folderKey}_folder-check/${attachmentKey}_user-file.md`,
	`/documents/${documentKey}/document.md`,
	`/documents/${otherDocumentKey}/document.md`,
	`/documents/${unparsedKey}/document.md`,
]);
assert.equal(files.get(`/attachments/${attachmentKey}_parse-test.pdf`)?.filename,
	`${attachmentKey}_parse-test.pdf`, "the on-disk name still drives type and preview");

const label = (path: string) => fileLabel(path, files.get(path)!.displayPath);
assert.equal(label(`/attachments/${attachmentKey}_parse-test.pdf`), "parse-test.pdf");
assert.equal(label(`/attachments/${folderKey}_folder-check/${attachmentKey}_user-file.md`), `${attachmentKey}_user-file.md`);
assert.equal(label(`/documents/${documentKey}/document.md`), uiText("chat.rightdock.parsedTextOf", { name: "parse-test.pdf" }));
assert.ok(label(`/documents/${documentKey}/document.md`).includes("parse-test.pdf"));
assert.equal(label(`/documents/${otherDocumentKey}/document.md`), label(`/documents/${documentKey}/document.md`));
// No source name is still no reason to show a 64-character key as a file name.
assert.equal(label(`/documents/${unparsedKey}/document.md`), uiText("chat.rightdock.parsedText"));
assert.equal(label(`/documents/${unparsedKey}/document.md`).includes(unparsedKey), false);
// Only a parse output is renamed; ordinary files keep their own names wherever they sit.
assert.equal(fileLabel("/work/document.md", "/work/document.md"), "document.md");
assert.equal(fileLabel("/documents/parsed/document.md", "/documents/parsed/document.md"), "document.md");

// The directory line under a Recent row reads the same way as the tree.
assert.equal(displayPathLabel(`/documents/${documentKey}/document.md`, "/documents/parse-test.pdf/document.md"),
	"/documents/parse-test.pdf/document.md");
assert.equal(displayPathLabel(`/documents/${unparsedKey}/document.md`, `/documents/${unparsedKey}/document.md`),
	`/documents/${uiText("chat.rightdock.parsedDocument")}/document.md`);
assert.equal(folderLabel("/documents/parsed", "parsed"), "parsed", "only a cache key needs a stand-in");

const tree = buildTree([...files.values()]);
const documents = tree.find((node) => node.name === "documents")!;
// Siblings are ordered by the name on disk, so an entry with no source name sorts by its key.
assert.deepEqual(documents.children?.map((node) => folderLabel(node.path, node.name)),
	[uiText("chat.rightdock.parsedDocument"), "parse-test.pdf", "parse-test.pdf"]);
assert.deepEqual(documents.children?.map((node) => node.path), [
	`/documents/${unparsedKey}`, `/documents/${documentKey}`, `/documents/${otherDocumentKey}`,
]);
const attachments = tree.find((node) => node.name === "attachments")!;
assert.deepEqual(attachments.children?.map((node) => node.name),
	["folder-check", "duplicate.md", "duplicate.md", "parse-test.pdf"]);
assert.deepEqual(attachments.children?.filter((node) => node.name === "duplicate.md").map((node) => node.path),
	[`/attachments/${folderKey}_duplicate.md`, `/attachments/${attachmentKey}_duplicate.md`],
	"two files reading alike still open by their own guest paths");
assert.equal(attachments.children?.[0]?.path, `/attachments/${folderKey}_folder-check`);

// A download saves the file that was fetched, under the name the list shows for it.
assert.equal(downloadName(`/attachments/${attachmentKey}_parse-test.pdf`, "/attachments/parse-test.pdf"), "parse-test.pdf");
assert.equal(downloadName(`/documents/${documentKey}/document.md`, "/documents/parse-test.pdf/document.md"), "document.md");
assert.equal(downloadName(`/attachments/${attachmentKey}_parse-test.pdf`), `${attachmentKey}_parse-test.pdf`);

console.log("Goal file browser display names passed");
