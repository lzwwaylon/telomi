import { uiText } from "@/app/ui-text";

/**
 * 工作区文件的可见名字。guest path 始终是身份：打开、预览、类型和请求都用它；
 * 这里只产出标签。名字在渲染处现算，不随列表缓存，界面语言换了就是新的名字。
 */

/** One parse output per source document, stored under its cache key. */
const PARSED_ENTRY = /^\/documents\/[0-9a-f]{64}$/u;
/** The one parse output worth reading; the API keeps its parser-internal siblings out of the list. */
const PARSED_MARKDOWN = /^\/documents\/[0-9a-f]{64}\/document\.md$/u;

export function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(0, i) : "";
}

/** Folder label: the user's own directory name, or a parse entry whose source name is gone. */
export function folderLabel(path: string, name: string): string {
	return PARSED_ENTRY.test(path) && name === basename(path) ? uiText("chat.rightdock.parsedDocument") : name;
}

/** File label: the user's own file name, or a parse output named after the document it came from. */
export function fileLabel(path: string, displayPath: string): string {
	if (!PARSED_MARKDOWN.test(path)) return basename(displayPath);
	return displayPath === path
		? uiText("chat.rightdock.parsedText")
		: uiText("chat.rightdock.parsedTextOf", { name: basename(dirname(displayPath)) });
}

/** Visible form of one whole path: every segment still holding a storage key gets its stand-in. */
export function displayPathLabel(path: string, displayPath: string): string {
	const parts = path.split("/");
	return displayPath.split("/")
		.map((name, index) => folderLabel(parts.slice(0, index + 1).join("/"), name))
		.join("/");
}

/**
 * Name for a download: the file's own name as the user knows it. Display paths rename directories
 * and the user's own files, never the extension, so the saved file stays the file that was fetched.
 */
export function downloadName(path: string, displayPath?: string): string {
	return basename(displayPath ?? path);
}
