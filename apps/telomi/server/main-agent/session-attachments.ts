import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSessionEntries, type FileEntry } from "@earendil-works/pi-coding-agent";

import type { AttachmentPayload } from "../../shared/types.js";

function messageAttachments(message: unknown): AttachmentPayload[] {
	const entry = message as { role?: string; attachments?: AttachmentPayload[] };
	return entry?.role === "user-with-attachments" && Array.isArray(entry.attachments) ? entry.attachments : [];
}

/** Attachment records carried by the messages the model currently sees. */
export function collectAttachments(messages: unknown[]): AttachmentPayload[] {
	return messages.flatMap((message) => messageAttachments(message));
}

/**
 * 同样的记录，但取自 Session 存下来的条目。Compaction 只压缩模型上下文，附件文件本身还在，
 * 所以文件名要从存储条目读，才不会随上下文压缩一起消失。
 */
export function sessionEntryAttachments(entries: FileEntry[]): AttachmentPayload[] {
	return entries.flatMap((entry) => entry.type === "message" ? messageAttachments(entry.message) : []);
}

/**
 * Runner 没加载时的同一份记录：用 Pi 原生的 Session 解析函数读 Goal 自己的 `context.jsonl`，
 * 不构造 Agent、不起轮次、不写任何文件，冷启动的第一次请求也能拿到原始文件名。
 * 读的是整份 Session 日志，所以只在没有已加载 Session 时才走这条路。
 */
export function readSessionAttachments(goalDir: string): AttachmentPayload[] {
	const contextFile = join(goalDir, "context.jsonl");
	if (!existsSync(contextFile)) return [];
	try {
		return sessionEntryAttachments(parseSessionEntries(readFileSync(contextFile, "utf-8")));
	} catch {
		// A half-written or unreadable log is no reason to fail a file listing; names fall back.
		return [];
	}
}
