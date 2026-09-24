import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttachmentPayload } from "../../shared/types.js";
import { createMainAgentSandboxExecutionSpec } from "../../server/agent-runtime/sandbox.js";
import { FileIngestService } from "../../server/ingestion/service.js";
import { parsedDocumentsDir } from "../../server/workspaces/goal-runtime-paths.js";
import type { FastApiDocumentParser } from "../../server/research/documents/fastapi-parser.js";
import {
	attachmentCaseDescriptors,
	attachmentPayloadsFromCase,
	persistAttachments,
	parseDocumentAttachmentsForTurn,
	type IngestAttachmentDocument,
} from "../../server/main-agent/attachment-utils.js";
import { canonicalDocumentResponse } from "../ingestion/canonical-document-stub.js";
import { PARSED_DOCUMENT_FILES } from "../../server/ingestion/parsed-documents.js";

const parsedArtifacts = Object.values(PARSED_DOCUMENT_FILES).slice().sort();

const root = mkdtempSync(join(tmpdir(), "telomi-attachment-routing-"));
const goalId = "goal";
const goalDir = join(root, goalId);
const sandboxDir = join(root, "sandbox");
for (const dir of [goalDir, join(sandboxDir, "artifacts", "main"), join(sandboxDir, "skills", "main-agent"), join(root, "history")]) {
	mkdirSync(dir, { recursive: true });
}

type ParserBehaviour = "ok" | "fail" | "hang";
let behaviour: ParserBehaviour = "ok";
let parseCalls = 0;
let releaseHang: (() => void) | null = null;
const parser: FastApiDocumentParser = {
	async parse(request) {
		parseCalls += 1;
		if (behaviour === "fail") throw new Error("parser refused the document");
		if (behaviour === "hang") await new Promise<void>((resolve) => { releaseHang = resolve; });
		return canonicalDocumentResponse(request, "Parsed attachment body", "doc-attachment");
	},
};

const service = new FileIngestService({
	workspaceDir: root,
	listGoalIds: () => [goalId],
	requestTimeoutMs: 5_000,
	documentParser: parser,
});

/** The Runtime's hand-off closure, with the wait budget shortened so the timeout case stays fast. */
const ingestDocument = (timeoutMs?: number): IngestAttachmentDocument => async ({ absPath, title }) => {
	const job = await service.enqueue(goalId, { inputPath: absPath, title, requestedBy: "main-agent-attachment" });
	ingestedTitles.push(job.title ?? "");
	ingestedRequesters.push(job.requestedBy ?? "");
	return service.waitForJob(goalId, job.id, timeoutMs);
};
const ingestedTitles: string[] = [];
const ingestedRequesters: string[] = [];

function attachmentPair(): AttachmentPayload[] {
	return [
		{
			id: "doc-1",
			type: "document",
			fileName: "paper.pdf",
			mimeType: "application/pdf",
			content: Buffer.from("<h1>Parsed attachment body</h1>").toString("base64"),
		},
		{
			id: "image-1",
			type: "image",
			fileName: "figure.png",
			mimeType: "image/png",
			content: Buffer.from("image bytes").toString("base64"),
		},
	];
}

try {
	service.start({ resumeQueued: false });

	// Parsed: the notice carries both mount-derived guest paths and the parsed status.
	const attachments = attachmentPair();
	const savedPaths = await persistAttachments(goalDir, attachments);
	await parseDocumentAttachmentsForTurn(attachments, savedPaths, ingestDocument());

	assert.equal(savedPaths.length, 2);
	assert.ok(savedPaths.every(existsSync));
	assert.equal(attachments[0]?.content, "");
	assert.equal(attachments[1]?.content, Buffer.from("image bytes").toString("base64"),
		"image attachments still reach the model as images");
	assert.equal(parseCalls, 1, "only the document attachment is parsed");
	assert.deepEqual(ingestedTitles, ["paper.pdf"], "the job title is the original file name");
	assert.deepEqual(ingestedRequesters, ["main-agent-attachment"], "the job records the attachment as its requester");
	assert.equal(attachments[0]?.parseStatus, "parsed", "the chat file chip learns the document was parsed");
	assert.equal(attachments[0]?.parseError, undefined);
	assert.equal(attachments[1]?.parseStatus, undefined, "images are never parsed, so they carry no parse status");

	// The notice must agree with the mounts the Main Agent actually gets, so both guest paths come from the spec.
	const spec = createMainAgentSandboxExecutionSpec({
		id: "attachment-routing",
		goalDir,
		sandboxDir,
		historyDirectory: join(root, "history"),
	});
	const attachmentsMount = spec.mounts.find((mount) => mount.hostPath === realpathSync(join(goalDir, "attachments")));
	const documentsMount = spec.mounts.find((mount) => mount.hostPath === realpathSync(parsedDocumentsDir(goalDir)));
	assert.ok(attachmentsMount, "sandbox spec must mount the Goal attachments directory");
	assert.ok(documentsMount, "sandbox spec must mount the parsed documents directory");
	assert.equal(documentsMount.access, "read-only");
	const attachmentsGuestPath = attachmentsMount.guestPath;
	const documentsGuestPath = documentsMount.guestPath;
	const notice = attachments[0]?.extractedText || "";
	assert.ok(notice.includes(`${attachmentsGuestPath}/doc-1_paper.pdf`), `notice must use the attachment mount point: ${notice}`);
	assert.doesNotMatch(notice, /\/workspace\/attachments/u);
	assert.match(notice, /internal FastAPI document parsing service/u);
	assert.doesNotMatch(notice, /must use research/u);

	const parsedRoot = realpathSync(parsedDocumentsDir(goalDir));
	const [cacheKey, ...extraKeys] = readdirSync(parsedRoot);
	assert.equal(extraKeys.length, 0, "one attachment produces one parsed document entry");
	assert.ok(cacheKey);
	const markdownGuestPath = `${documentsGuestPath}/${cacheKey}/document.md`;
	assert.ok(notice.includes(markdownGuestPath), `notice must give the parsed Markdown path: ${notice}`);
	assert.deepEqual(readdirSync(join(parsedRoot, cacheKey)).sort(), parsedArtifacts,
		"the mounted tree holds parsed artifacts only, never the original bytes");
	assert.match(readFileSync(join(parsedRoot, cacheKey, PARSED_DOCUMENT_FILES.markdown), "utf-8"), /Parsed attachment body/u);

	// Cache hit: the same saved file is not parsed twice, and the notice is unchanged.
	const cached = attachmentPair();
	await parseDocumentAttachmentsForTurn(cached, savedPaths, ingestDocument());
	assert.equal(parseCalls, 1, "a cache hit does not re-parse");
	assert.equal(cached[0]?.extractedText, notice, "a cache hit produces the same notice");

	// Failure: the reason reaches the notice, the original path survives, nothing throws.
	behaviour = "fail";
	const failing = attachmentPair();
	failing[0]!.id = "doc-fail";
	const failingPaths = await persistAttachments(goalDir, failing);
	await parseDocumentAttachmentsForTurn(failing, failingPaths, ingestDocument());
	const failureNotice = failing[0]?.extractedText || "";
	assert.match(failureNotice, /could not parse it: .*parser refused the document/u);
	assert.ok(failureNotice.includes(`${attachmentsGuestPath}/doc-fail_paper.pdf`), "a failed parse keeps the original file path");
	assert.doesNotMatch(failureNotice, /document\.md/u, "a failed parse offers no Markdown path");
	assert.equal(failing[0]?.parseStatus, "failed", "the chat file chip shows the failed parse");
	assert.match(failing[0]?.parseError ?? "", /parser refused the document/u, "the chip keeps the reason");

	// Timeout: parsing is reported as unfinished, not as a failure, and the turn still proceeds.
	behaviour = "hang";
	const slow = attachmentPair();
	slow[0]!.id = "doc-slow";
	const slowPaths = await persistAttachments(goalDir, slow);
	await parseDocumentAttachmentsForTurn(slow, slowPaths, ingestDocument(20));
	const slowNotice = slow[0]?.extractedText || "";
	assert.match(slowNotice, /still parsing it and parsing has not finished yet/u);
	assert.doesNotMatch(slowNotice, /could not parse/u, "a timeout is not a parse failure");
	assert.equal(slow[0]?.parseStatus, "pending", "the chat file chip shows a timeout as unfinished, not failed");
	assert.ok(slowNotice.includes(`${attachmentsGuestPath}/doc-slow_paper.pdf`), "a timeout keeps the original file path");
	assert.match(slowNotice, new RegExp(`${documentsGuestPath}/[0-9a-f]+/document\\.md`, "u"),
		"a timeout still tells the Main Agent where the Markdown will appear");

	// Text and unrecognised binary files are never parsed; the notice says how to treat each.
	behaviour = "ok";
	const callsBefore = parseCalls;
	const typed: AttachmentPayload[] = [
		{ id: "src-1", type: "document", fileName: "runtime.py", mimeType: "", content: Buffer.from("print(1)").toString("base64"), extractedText: "print(1)" },
		{ id: "bin-1", type: "document", fileName: "firmware.bin", mimeType: "application/octet-stream", content: Buffer.from([0, 1, 2, 255]).toString("base64") },
	];
	const typedPaths = await persistAttachments(goalDir, typed);
	await parseDocumentAttachmentsForTurn(typed, typedPaths, ingestDocument());
	assert.equal(parseCalls, callsBefore, "text and binary attachments never reach the parser");
	const textNotice = typed[0]?.extractedText || "";
	assert.match(textNotice, /text file .*Read it directly/u);
	assert.doesNotMatch(textNotice, /print\(1\)/u, "the client's extracted text never enters the session");
	assert.ok(textNotice.includes(`${attachmentsGuestPath}/src-1_runtime.py`));
	const binaryNotice = typed[1]?.extractedText || "";
	assert.deepEqual(typed.map((attachment) => attachment.parseStatus), [undefined, undefined],
		"text and binary files are never parsed, so they carry no parse status");
	assert.match(binaryNotice, /does not recognise this file type and stored it untouched/u);
	assert.doesNotMatch(binaryNotice, /document\.md/u);

	// A folder is one group: the tree lands under one directory, unsafe segments are dropped,
	// each file is routed by kind, and the Main Agent gets one directory-level notice.
	const folderId = "f1";
	const folder: AttachmentPayload[] = [
		{ id: "fa", type: "document", fileName: "README.md", mimeType: "text/markdown", folderId, relativePath: "project/README.md", content: Buffer.from("# Project").toString("base64") },
		{ id: "fb", type: "document", fileName: "paper.pdf", mimeType: "application/pdf", folderId, relativePath: "project/docs/../docs/paper.pdf", content: Buffer.from("<h1>Folder paper</h1>").toString("base64") },
		{ id: "fc", type: "document", fileName: "blob.dat", mimeType: "application/octet-stream", folderId, relativePath: "project/bin/blob.dat", content: Buffer.from([9, 9]).toString("base64") },
		{ id: "fd", type: "image", fileName: "logo.png", mimeType: "image/png", folderId, relativePath: "project/logo.png", content: Buffer.from("png").toString("base64") },
	];
	const folderPaths = await persistAttachments(goalDir, folder);
	const folderRoot = join(goalDir, "attachments", "f1_project");
	assert.deepEqual(folderPaths.map((path) => path.slice(folderRoot.length + 1)).sort(),
		["README.md", "bin/blob.dat", "docs/docs/paper.pdf", "logo.png"], "dot-dot segments are dropped, never resolved");
	await parseDocumentAttachmentsForTurn(folder, folderPaths, ingestDocument());
	assert.equal(parseCalls, callsBefore + 1, "only the PDF inside the folder is parsed");
	const folderNoticeText = folder[0]?.extractedText || "";
	assert.equal(folder[1]?.extractedText, undefined, "folder members after the first carry no notice of their own");
	assert.equal(folder[2]?.extractedText, undefined);
	assert.match(folderNoticeText, /Folder attachment: project \(3 files\)/u);
	assert.ok(folderNoticeText.includes(`${attachmentsGuestPath}/f1_project`), folderNoticeText);
	assert.match(folderNoticeText, new RegExp(`${attachmentsGuestPath}/f1_project/README\\.md — text, read it directly`, "u"));
	assert.match(folderNoticeText, new RegExp(`${attachmentsGuestPath}/f1_project/docs/docs/paper\\.pdf — parsed; Markdown at ${documentsGuestPath}/[0-9a-f]+/document\\.md`, "u"));
	assert.match(folderNoticeText, new RegExp(`${attachmentsGuestPath}/f1_project/bin/blob\\.dat — unrecognised binary`, "u"));
	assert.doesNotMatch(folderNoticeText, /logo\.png/u, "images are not documents and stay out of the folder notice");
	assert.equal(folder[3]?.content, Buffer.from("png").toString("base64"), "folder images still reach the model as images");

	// A Node Evaluation Case keeps descriptors only; a Candidate Replay rebuilds the payloads from the
	// restored Goal workspace, byte for byte, including folder members.
	const original = [...attachmentPair(), ...folder.map((item) => ({ ...item }))];
	original[0]!.id = "case-doc";
	original[1]!.id = "case-image";
	for (const item of original) if (item.folderId) item.folderId = "f2";
	const originalBytes = original.map((item) => item.content);
	await persistAttachments(goalDir, original);
	const descriptors = attachmentCaseDescriptors(original);
	assert.ok(descriptors.every((descriptor) => !("content" in descriptor) && !("extractedText" in descriptor)),
		"descriptors never carry bytes or extracted text");
	const rebuilt = attachmentPayloadsFromCase(goalDir, descriptors);
	assert.deepEqual(rebuilt.map((item) => item.content), originalBytes, "replayed payloads carry the original bytes");
	assert.deepEqual(rebuilt.map(({ content: _content, ...rest }) => rest), descriptors);
	assert.equal(rebuilt.find((item) => item.fileName === "paper.pdf" && item.folderId)?.relativePath, "project/docs/../docs/paper.pdf");

	console.log("attachment routing test passed");
} finally {
	releaseHang?.();
	service.stop();
	rmSync(root, { recursive: true, force: true });
}
