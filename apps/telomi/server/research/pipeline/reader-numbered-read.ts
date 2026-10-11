import { posix } from "node:path";
import { createReadToolDefinition, type ReadOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MAX_DISPLAY_BYTES = 32 * 1024;
const MAX_LINES = 2000;

/** Number the display, never the immutable Source or the native raw result. */
export function createReaderNumberedRead(cwd: string, operations: ReadOperations, resolveGuestPath: (path: string) => string): ToolDefinition<any, any, any> {
	const native = createReadToolDefinition(cwd, { operations });
	const { renderCall: _renderCall, renderResult: _renderResult, ...definition } = native;
	return {
		...definition,
		description: `${native.description} Reader evidence view: format=auto (default) adds L123 | labels to .md, .markdown, .txt, .json and .jsonl files under /work/source; other files use native raw reading. format=numbered adds labels to UTF-8 text. format=raw preserves native output for programmatic parsing; before citing raw-read content, use format=numbered to confirm original line positions instead of estimating them. Displayed lines use original 1-based citation positions (CRLF/CR normalized, UTF-8 BOM removed). Pages contain complete lines, at most 2000 lines and 32 KiB including labels and footer. The footer gives the displayed range, total lines and next_offset; continue where relevant. An oversized single line is reported without skipping it; use bash/Python to inspect bounded character ranges. Images retain native handling.`,
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to /work or absolute" }),
			offset: Type.Optional(Type.Integer({ minimum: 1, description: "Original 1-based starting line" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum lines in this page" })),
			format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("numbered"), Type.Literal("raw")])),
		}),
		async execute(callId, params, signal, onUpdate, context) {
			signal?.throwIfAborted();
			const input = params as {
				path: string; offset?: number; limit?: number; format?: string;
			};
			const { path, offset = 1, limit = MAX_LINES, format = "auto" } = input;
			if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("read requires a file path");
			if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) {
				throw new Error("read offset and limit must be positive safe integers");
			}
			if (!["auto", "numbered", "raw"].includes(format)) throw new Error("Unknown read format");
			const absolutePath = resolveGuestPath(path);
			const sourceText = absolutePath.startsWith("/work/source/") && [".md", ".markdown", ".txt", ".json", ".jsonl"].includes(posix.extname(absolutePath).toLowerCase());
			const view = format === "auto" ? (sourceText ? "numbered" : "raw") : format;
			if (view === "raw") return native.execute(callId, input, signal, onUpdate, context);
			await abortable(operations.access(absolutePath), signal);
			signal?.throwIfAborted();
			const image = await abortable(Promise.resolve(operations.detectImageMimeType?.(absolutePath)), signal);
			signal?.throwIfAborted();
			if (image) return native.execute(callId, input, signal, onUpdate, context);
			const buffer = await abortable(operations.readFile(absolutePath), signal);
			signal?.throwIfAborted();
			// Match Note evidence validation, including lone CR and the UTF-8 BOM.
			const lines = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/\r\n?/gu, "\n").split("\n");
			if (offset > lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
			const footer = (end: number) => `\n\n[Showing original lines ${offset}-${end} of ${lines.length}. ${end < lines.length
				? `next_offset=${end + 1}; use offset=${end + 1} to continue.` : "End of file; next_offset=null."}]`;
			const page: string[] = [];
			let bytes = 0;
			const stop = Math.min(lines.length, offset - 1 + Math.min(limit, MAX_LINES));
			for (let index = offset - 1; index < stop; index++) {
				const line = `L${index + 1} | ${lines[index]}`;
				const size = Buffer.byteLength(line) + (page.length ? 1 : 0);
				if (bytes + size + Buffer.byteLength(footer(index + 1)) > MAX_DISPLAY_BYTES) break;
				page.push(line);
				bytes += size;
			}
			if (!page.length) {
				const text = `[Original line ${offset} exceeds the 32 KiB display budget. No lines were displayed or skipped. Use bash/Python to inspect bounded character ranges of this line; normalize CRLF and CR to LF when selecting original citation lines. A line fragment is not a complete line. No next_offset is provided.]`;
				return { content: [{ type: "text", text }], details: { format: view, start_line: offset, end_line: null, total_lines: lines.length, next_offset: null, blocked_line: offset } };
			}
			const end = offset + page.length - 1;
			const text = page.join("\n") + footer(end);
			return { content: [{ type: "text", text }], details: { format: view, start_line: offset, end_line: end, total_lines: lines.length, next_offset: end < lines.length ? end + 1 : null } };
		},
	};
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	let abort: () => void = () => undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
			abort = () => reject(signal.reason ?? new Error("Operation aborted"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		})]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
