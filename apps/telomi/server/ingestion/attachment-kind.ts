import { extname } from "node:path";

/**
 * How the Runtime treats one uploaded file. `parse` goes through the document parsing
 * service; `text` is readable as-is by the Main Agent and research; `binary` is stored
 * untouched and never handed to a parser.
 */
export type AttachmentKind = "parse" | "text" | "binary";

export const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".webm", ".ogg", ".flac", ".aiff", ".aif"]);

/** Formats the internal FastAPI document parsing service (and audio transcription) handle natively. */
export const PARSE_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm", ...AUDIO_EXTENSIONS]);

/** Source and data files that are already text; parsing them would only add noise. */
export const TEXT_EXTENSIONS = new Set([
	".md", ".markdown", ".txt", ".rst", ".tex", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".toml",
	".ini", ".cfg", ".conf", ".env", ".log", ".sql", ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java", ".kt",
	".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".rb", ".php", ".swift", ".sh", ".bash", ".zsh", ".ps1",
	".css", ".scss", ".less", ".vue", ".svelte", ".graphql", ".proto", ".makefile", ".gitignore", ".dockerfile",
]);

export function attachmentKind(fileName: string, mimeType?: string): AttachmentKind {
	const ext = extname(fileName).toLowerCase();
	if (PARSE_EXTENSIONS.has(ext)) return "parse";
	if (TEXT_EXTENSIONS.has(ext)) return "text";
	const mime = (mimeType ?? "").toLowerCase();
	if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
	return "binary";
}
