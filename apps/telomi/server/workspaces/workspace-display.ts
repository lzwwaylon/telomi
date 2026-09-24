import { sep } from "node:path";

import {
	MAIN_AGENT_ATTACHMENTS_GUEST_PATH,
	MAIN_AGENT_PARSED_DOCUMENTS_GUEST_PATH,
} from "../agent-runtime/sandbox.js";
import { PARSED_DOCUMENT_INTERNAL_FILES, parsedDocumentSourceName } from "../ingestion/parsed-documents.js";
import { attachmentOriginalPath, attachmentRelativePath } from "../main-agent/attachment-utils.js";
import type { AttachmentPayload } from "../../shared/types.js";

/**
 * 文件列表的显示名。落盘键（附件 id、解析缓存 key）只是定位用的键，可见标签用用户
 * 自己的文件名。显示名只用于标签和搜索：定位、预览、下载和权限判断始终用 guest path。
 */

/** 只有挂载下的第一段带附件 id 前缀，文件夹成员不带。 */
const ATTACHMENT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/iu;

function mountSegments(guestPath: string): { mount: string; rest: string[] } {
	const parts = guestPath.split("/").filter(Boolean);
	return { mount: `/${parts[0] ?? ""}`, rest: parts.slice(1) };
}

/** 一个解析条目下的解析器内部文件：仍可按路径读取，但不进用户文件列表。 */
export function isParserInternalFile(guestPath: string): boolean {
	const { mount, rest } = mountSegments(guestPath);
	return mount === MAIN_AGENT_PARSED_DOCUMENTS_GUEST_PATH
		&& rest.length === 2
		&& PARSED_DOCUMENT_INTERNAL_FILES.includes(rest[1]!);
}

/**
 * Goal 自己记下的附件名，按 guest path 索引。只覆盖记录里有的文件，不引入列表之外的条目。
 */
export function attachmentDisplayPaths(attachments: AttachmentPayload[]): Map<string, string> {
	const recorded = new Map<string, string>();
	for (const attachment of attachments) {
		const original = attachmentOriginalPath(attachment);
		if (!original) continue;
		const stored = attachmentRelativePath(attachment).split(sep).join("/");
		recorded.set(`${MAIN_AGENT_ATTACHMENTS_GUEST_PATH}/${stored}`, `${MAIN_AGENT_ATTACHMENTS_GUEST_PATH}/${original}`);
	}
	return recorded;
}

/**
 * 一个文件的标签路径：段数与 guest path 相同，其中的落盘键换成用户自己的名字。
 * 没有可用来源时返回 undefined，调用方继续显示原路径。
 */
export function workspaceDisplayPath(
	goalDir: string,
	guestPath: string,
	recorded?: Map<string, string>,
): string | undefined {
	const { mount, rest } = mountSegments(guestPath);
	const [key, ...inside] = rest;
	if (!key) return undefined;
	if (mount === MAIN_AGENT_ATTACHMENTS_GUEST_PATH) {
		// 附件记录里的原名优先：落盘名被 sanitize 过，只是键。
		const original = recorded?.get(guestPath);
		if (original) return original === guestPath ? undefined : original;
	}
	const name = mount === MAIN_AGENT_ATTACHMENTS_GUEST_PATH
		? key.replace(ATTACHMENT_KEY, "")
		: mount === MAIN_AGENT_PARSED_DOCUMENTS_GUEST_PATH
			? parsedDocumentSourceName(goalDir, key)
			: undefined;
	return name && name !== key ? [mount, name, ...inside].join("/") : undefined;
}
