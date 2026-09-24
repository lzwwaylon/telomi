import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AttachmentParseStatus, AttachmentPayload, UserMessageWithAttachmentsPayload } from "../../shared/types.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import {
	MAIN_AGENT_ATTACHMENTS_GUEST_PATH,
	MAIN_AGENT_PARSED_DOCUMENTS_GUEST_PATH,
} from "../agent-runtime/sandbox.js";
import { attachmentKind, type AttachmentKind } from "../ingestion/attachment-kind.js";
import { PARSED_DOCUMENT_FILES } from "../ingestion/parsed-documents.js";
import type { FileIngestJob } from "../ingestion/types.js";
import { isFileNameSegment, sanitizeFileName } from "../lib/paths.js";
import { toErrorMessage } from "../lib/values.js";

/**
 * 落盘后的文档交给 Ingestion 解析并等到终态。返回等待结束时的 Job：
 * 非终态表示解析还在进行（超时或服务停止），不是失败。
 */
export type IngestAttachmentDocument = (args: { absPath: string; title: string }) => Promise<FileIngestJob | null>;

function parsedMarkdownGuestPath(cacheKey: string): string {
	return `${MAIN_AGENT_PARSED_DOCUMENTS_GUEST_PATH}/${cacheKey}/${PARSED_DOCUMENT_FILES.markdown}`;
}

/**
 * notice 模板按这些状态分支。`text` 和 `binary` 由文件类型决定，不经过解析；
 * 其余三种是解析 Job 的结果。模板和这里共用同一组取值，改一处必须改另一处。
 */
type NoticeParseStatus = "parsed" | "pending" | "failed" | "text" | "binary";

interface NoticeParseVariables {
	parse_status: NoticeParseStatus;
	markdown_path: string;
	parse_error: string;
}

/**
 * Job 状态到 notice 变量的唯一映射。终态 done 给出可读的 Markdown 路径，
 * 终态 error 只给原因，其余（queued/running）都是"尚未完成"，不算失败。
 */
function noticeParseVariables(job: FileIngestJob | null, unavailableReason?: string): NoticeParseVariables {
	if (job?.status === "done" && job.result) {
		return { parse_status: "parsed", markdown_path: parsedMarkdownGuestPath(job.result.cacheKey), parse_error: "" };
	}
	if (job?.status === "error" || unavailableReason) {
		return { parse_status: "failed", markdown_path: "", parse_error: job?.error?.trim() || unavailableReason || "unknown parsing error" };
	}
	return {
		parse_status: "pending",
		markdown_path: job ? parsedMarkdownGuestPath(job.cacheKey) : "",
		parse_error: "",
	};
}

/** Directory-safe segments of a folder-relative path: no empty, `.` or `..` entries. */
function relativeSegments(relativePath: string): string[] {
	return relativePath.split(/[\\/]+/u)
		.filter((segment) => segment && segment !== "." && segment !== "..");
}

/** Host path of one attachment under the Goal attachments directory, folder members inside their folder. */
export function attachmentRelativePath(attachment: AttachmentPayload): string {
	const segments = attachment.folderId && attachment.relativePath ? relativeSegments(attachment.relativePath) : [];
	if (attachment.folderId && segments.length > 1) {
		const [folderName, ...rest] = segments.map((segment) => sanitizeFileName(segment));
		return join(`${attachment.folderId}_${folderName}`, ...rest);
	}
	return `${attachment.id}_${sanitizeFileName(attachment.fileName)}`;
}

/**
 * 用户给这个附件起的名字，段数与 `attachmentRelativePath` 一一对应。落盘名经过 sanitize，
 * 中文、空格等字符会丢失，所以它只能当键；显示名取自附件记录本身。
 * 记录里没有一个合法文件名段时返回 undefined，由调用方退回落盘名。
 */
export function attachmentOriginalPath(attachment: AttachmentPayload): string | undefined {
	const segments = attachment.folderId && attachment.relativePath ? relativeSegments(attachment.relativePath) : [];
	const names = segments.length > 1 ? segments : relativeSegments(attachment.fileName).slice(-1);
	return names.length && names.every((name) => isFileNameSegment(name)) ? names.join("/") : undefined;
}

function guestPath(relativePath: string): string {
	return `${MAIN_AGENT_ATTACHMENTS_GUEST_PATH}/${relativePath.split(sep).join("/")}`;
}

/**
 * What a Node Evaluation Case keeps about one attachment: everything except the bytes, which live in
 * the Case input tree under `attachments/`. A Candidate Replay rebuilds the payload from both.
 */
export type AttachmentCaseDescriptor = Pick<AttachmentPayload, "id" | "type" | "fileName" | "mimeType" | "size" | "folderId" | "relativePath">;

export function attachmentCaseDescriptors(attachments: AttachmentPayload[]): AttachmentCaseDescriptor[] {
	return attachments.map(({ id, type, fileName, mimeType, size, folderId, relativePath }) => ({
		id, type, fileName, mimeType, size,
		...(folderId ? { folderId } : {}),
		...(relativePath ? { relativePath } : {}),
	}));
}

/** Rebuild the attachment payloads of a replayed turn from the Case descriptors and the restored Goal workspace. */
export function attachmentPayloadsFromCase(goalDir: string, descriptors: AttachmentCaseDescriptor[]): AttachmentPayload[] {
	return descriptors.map((descriptor) => {
		const payload: AttachmentPayload = { ...descriptor, content: "" };
		payload.content = readFileSync(join(goalDir, "attachments", attachmentRelativePath(payload))).toString("base64");
		return payload;
	});
}

export async function persistAttachments(goalDir: string, attachments: AttachmentPayload[]): Promise<string[]> {
	const attachmentsDir = join(goalDir, "attachments");
	const savedPaths: string[] = [];
	for (const attachment of attachments) {
		const filePath = join(attachmentsDir, attachmentRelativePath(attachment));
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, Buffer.from(attachment.content, "base64"));
		savedPaths.push(filePath);
	}
	return savedPaths;
}

interface DocumentOutcome {
	attachment: AttachmentPayload;
	relativePath: string;
	kind: AttachmentKind;
	parse: NoticeParseVariables;
}

async function resolveDocument(
	attachment: AttachmentPayload,
	savedPath: string,
	ingestDocument?: IngestAttachmentDocument,
): Promise<DocumentOutcome> {
	const relativePath = attachmentRelativePath(attachment);
	const kind = attachmentKind(attachment.fileName, attachment.mimeType);
	if (kind !== "parse") {
		return { attachment, relativePath, kind, parse: { parse_status: kind, markdown_path: "", parse_error: "" } };
	}
	let job: FileIngestJob | null = null;
	let unavailableReason: string | undefined;
	if (ingestDocument) {
		try {
			job = await ingestDocument({ absPath: savedPath, title: attachment.relativePath || attachment.fileName });
		} catch (error) {
			unavailableReason = toErrorMessage(error);
		}
	} else {
		unavailableReason = "the file ingestion service is not available in this Runtime";
	}
	return { attachment, relativePath, kind, parse: noticeParseVariables(job, unavailableReason) };
}

function documentNotice(outcome: DocumentOutcome): string {
	return renderAgentPrompt("main", "router", "user", {
		document_name: outcome.attachment.fileName,
		document_path: guestPath(outcome.relativePath),
		...outcome.parse,
	}, "document-attachment-notice").content;
}

function folderNotice(outcomes: DocumentOutcome[]): string {
	const folderRelative = outcomes[0]!.relativePath.split(sep)[0]!;
	const folderName = folderRelative.replace(/^[^_]*_/u, "");
	return renderAgentPrompt("main", "router", "user", {
		folder_name: folderName,
		folder_path: guestPath(folderRelative),
		file_count: outcomes.length,
		files: outcomes.map((outcome) => ({
			path: guestPath(outcome.relativePath),
			...outcome.parse,
		})),
	}, "folder-attachment-notice").content;
}

/**
 * 文档落盘后按类型分流：可解析格式交给 Ingestion 解析并等到终态；文本类和其他二进制
 * 不解析。notice 给出原文件路径、解析 Markdown 路径和状态；同一文件夹的文件合成一条
 * 目录级 notice。正文本身不进会话：主 Agent 用 read Tool 自己读挂载里的产物。
 * 解析失败或超时只体现为 notice 文本与附件上的解析状态，聊天轮次照常进行。图片附件不解析。
 * 解析状态写回附件本身，聊天在文件卡片上展示；附件解析不形成 Activity。
 */
export async function parseDocumentAttachmentsForTurn(
	attachments: AttachmentPayload[],
	savedPaths: string[],
	ingestDocument?: IngestAttachmentDocument,
): Promise<void> {
	const folders = new Map<string, DocumentOutcome[]>();
	for (const [index, attachment] of attachments.entries()) {
		if (attachment.type !== "document") continue;
		const savedPath = savedPaths[index];
		if (!savedPath) continue;
		const outcome = await resolveDocument(attachment, savedPath, ingestDocument);
		// The original bytes are already persisted. Keeping a multi-megabyte base64
		// payload (or the client's extracted text) in the dispatcher session wastes memory.
		attachment.content = "";
		attachment.extractedText = undefined;
		if (outcome.kind === "parse") {
			attachment.parseStatus = outcome.parse.parse_status as AttachmentParseStatus;
			attachment.parseError = outcome.parse.parse_error || undefined;
		}
		if (attachment.folderId && attachment.relativePath) {
			const group = folders.get(attachment.folderId) ?? [];
			group.push(outcome);
			folders.set(attachment.folderId, group);
		} else {
			attachment.extractedText = documentNotice(outcome);
		}
	}
	for (const outcomes of folders.values()) {
		outcomes[0]!.attachment.extractedText = folderNotice(outcomes);
	}
}

export function convertAttachmentMessageToLlm(message: UserMessageWithAttachmentsPayload): {
	role: "user";
	content: (TextContent | ImageContent)[];
	timestamp: number;
} {
	const content: (TextContent | ImageContent)[] = [];
	const text = message.content.trim();

	if (text) {
		content.push({ type: "text", text });
	}

	for (const attachment of message.attachments) {
		if (attachment.type === "image") {
			content.push({
				type: "image",
				data: attachment.content,
				mimeType: attachment.mimeType,
			});
			continue;
		}

		if (attachment.extractedText) {
			content.push({
				type: "text",
				text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
			});
		}
	}

	if (content.length === 0) {
		content.push({ type: "text", text: "[User sent attachments]" });
	}

	return {
		role: "user",
		content,
		timestamp: message.timestamp ?? Date.now(),
	};
}

export function isAttachmentPrompt(input: string | UserMessageWithAttachmentsPayload): input is UserMessageWithAttachmentsPayload {
	return typeof input !== "string" && input.role === "user-with-attachments";
}
