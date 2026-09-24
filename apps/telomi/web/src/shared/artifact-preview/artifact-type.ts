import { Code2, FileCode, FileJson, type LucideIcon } from "lucide-react";
import { DocumentIcon as FileText } from "@/shared/ui/icons";
import { uiText } from "@/app/ui-text";

/**
 * Artifact classification shared by every preview surface. Filenames are the
 * only input: the same name must always resolve to the same type, renderer,
 * icon and label no matter which entry point shows the file.
 */
export type ArtifactType =
	| "html"
	| "svg"
	| "markdown"
	| "image"
	| "audio"
	| "json"
	| "datatable"
	| "spreadsheet"
	| "csv"
	| "tsv"
	| "mermaid"
	| "diff"
	| "code"
	| "pdf"
	| "xlsx"
	| "text";

const CODE_EXTS = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs",
	"py", "rb", "php", "go", "rs", "java", "kt", "swift", "scala",
	"c", "cpp", "cc", "h", "hpp",
	"sh", "bash", "zsh", "fish",
	"sql", "yaml", "yml", "toml", "ini", "conf",
	"css", "scss", "less",
	"xml", "vue", "svelte",
	"r", "lua", "pl", "pm",
	"dart", "ex", "exs", "elm", "clj", "hs",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac", "aiff"]);

export function getFileType(filename: string): ArtifactType {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".datatable.json")) return "datatable";
	if (lower.endsWith(".spreadsheet.json")) return "spreadsheet";

	const ext = lower.split(".").pop() ?? "";
	if (ext === "html" || ext === "htm") return "html";
	if (ext === "svg") return "svg";
	if (ext === "md" || ext === "markdown") return "markdown";
	if (ext === "json") return "json";
	if (ext === "csv") return "csv";
	if (ext === "tsv") return "tsv";
	if (ext === "mmd" || ext === "mermaid") return "mermaid";
	if (ext === "diff" || ext === "patch") return "diff";
	if (ext === "pdf") return "pdf";
	if (ext === "xlsx" || ext === "xls") return "xlsx";
	if (IMAGE_EXTS.has(ext)) return "image";
	if (AUDIO_EXTS.has(ext)) return "audio";
	if (CODE_EXTS.has(ext)) return "code";
	return "text";
}

/**
 * The type name a card shows for an artifact. Derived from the filename, so the
 * same report reads the same in the home feed, the Goal column and chat; an
 * attached podcast never renames the Markdown report it belongs to.
 */
export function artifactKindLabel(filename: string): string {
	switch (getFileType(filename)) {
		case "markdown":
			return uiText("home.document");
		case "html":
			return uiText("home.visualReport");
		case "pdf":
			return "PDF";
		case "image":
		case "svg":
			return uiText("home.image");
		default:
			return uiText("home.artifact");
	}
}

const BINARY_TYPES = new Set<ArtifactType>(["image", "audio", "pdf", "xlsx"]);

/** Binary artifacts render straight from their blob URL and are never read as text. */
export function isBinaryArtifact(filename: string): boolean {
	return BINARY_TYPES.has(getFileType(filename));
}

/**
 * Map artifact filename → Shiki language hint for the CodeBlock component.
 * Falls back to 'text' when no specific mapping exists.
 */
export function languageForArtifact(filename: string): string {
	const lower = filename.toLowerCase();
	const ext = lower.split(".").pop() ?? "";
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		go: "go",
		rs: "rust",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		cpp: "cpp",
		cc: "cpp",
		h: "c",
		hpp: "cpp",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		sql: "sql",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		ini: "ini",
		css: "css",
		scss: "scss",
		less: "less",
		xml: "xml",
		vue: "vue",
		svelte: "svelte",
		r: "r",
		lua: "lua",
		pl: "perl",
		pm: "perl",
		dart: "dart",
		ex: "elixir",
		exs: "elixir",
		elm: "elm",
		clj: "clojure",
		hs: "haskell",
		php: "php",
		diff: "diff",
		patch: "diff",
		md: "markdown",
		markdown: "markdown",
	};
	return map[ext] ?? "text";
}

/** File-list icon for an artifact type; shared so both file lists stay in sync. */
export function iconForArtifact(type: ArtifactType): LucideIcon {
	switch (type) {
		case "html":
			return Code2;
		case "json":
			return FileJson;
		case "code":
			return FileCode;
		default:
			return FileText;
	}
}
