// Modified for Telomi.
import { File, Image as ImageIcon } from "lucide-react";
import { uiText } from "@/app/ui-text";
import { cn } from "@/shared/lib/utils";

export type AttachmentType = "image" | "pdf" | "office" | "text" | "other";

const MIME_TYPE_LABELS: Record<string, string> = {
	"application/pdf": "PDF",
	"application/msword": "Word",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
	"application/vnd.ms-excel": "Excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
	"application/vnd.ms-powerpoint": "PowerPoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
	"application/rtf": "RTF",
	"text/plain": "Text",
	"text/markdown": "Markdown",
	"text/html": "HTML",
	"text/css": "CSS",
	"text/csv": "CSV",
	"text/xml": "XML",
	"application/xml": "XML",
	"application/json": "JSON",
	"application/x-yaml": "YAML",
	"text/yaml": "YAML",
	"text/javascript": "JavaScript",
	"application/javascript": "JavaScript",
	"text/typescript": "TypeScript",
	"application/typescript": "TypeScript",
	"text/x-python": "Python",
	"text/x-java": "Java",
	"text/x-c": "C",
	"text/x-c++": "C++",
	"text/x-csharp": "C#",
	"text/x-go": "Go",
	"text/x-rust": "Rust",
	"text/x-swift": "Swift",
	"text/x-kotlin": "Kotlin",
	"text/x-ruby": "Ruby",
	"text/x-php": "PHP",
	"application/x-sh": "Shell",
	"text/x-shellscript": "Shell",
	"image/png": "PNG",
	"image/jpeg": "JPEG",
	"image/gif": "GIF",
	"image/webp": "WebP",
	"image/svg+xml": "SVG",
	"image/bmp": "BMP",
	"image/tiff": "TIFF",
	"image/heic": "HEIC",
	"image/heif": "HEIF",
	"application/zip": "ZIP",
	"application/x-rar-compressed": "RAR",
	"application/x-7z-compressed": "7-Zip",
	"application/gzip": "GZIP",
	"application/x-tar": "TAR",
	"audio/mpeg": "MP3",
	"audio/wav": "WAV",
	"video/mp4": "MP4",
	"video/quicktime": "MOV",
};

const EXTENSION_LABELS: Record<string, string> = {
	js: "JavaScript",
	ts: "TypeScript",
	tsx: "React TSX",
	jsx: "React JSX",
	py: "Python",
	rb: "Ruby",
	go: "Go",
	rs: "Rust",
	swift: "Swift",
	kt: "Kotlin",
	java: "Java",
	c: "C",
	cpp: "C++",
	h: "Header",
	cs: "C#",
	php: "PHP",
	sh: "Shell",
	bash: "Bash",
	zsh: "Zsh",
	json: "JSON",
	yaml: "YAML",
	yml: "YAML",
	toml: "TOML",
	xml: "XML",
	ini: "Config",
	env: "Env",
	md: "Markdown",
	txt: "Text",
	rtf: "RTF",
	pdf: "PDF",
	doc: "Word",
	docx: "Word",
	xls: "Excel",
	xlsx: "Excel",
	ppt: "PowerPoint",
	pptx: "PowerPoint",
	csv: "CSV",
};

export function inferAttachmentType(mimeType: string, fileName?: string): AttachmentType {
	const mt = (mimeType || "").toLowerCase();
	if (mt.startsWith("image/")) return "image";
	if (mt === "application/pdf") return "pdf";
	if (
		mt === "application/msword" ||
		mt === "application/vnd.ms-excel" ||
		mt === "application/vnd.ms-powerpoint" ||
		mt.startsWith("application/vnd.openxmlformats-officedocument")
	) {
		return "office";
	}
	if (mt.startsWith("text/") || mt === "application/json" || mt === "application/xml") {
		return "text";
	}
	const ext = fileName?.split(".").pop()?.toLowerCase();
	if (ext) {
		if (["pdf"].includes(ext)) return "pdf";
		if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)) return "office";
		if (EXTENSION_LABELS[ext]) return "text";
	}
	return "other";
}

export function getFileTypeLabel(type: AttachmentType, mimeType: string, fileName?: string): string {
	if (MIME_TYPE_LABELS[mimeType]) return MIME_TYPE_LABELS[mimeType];
	if (fileName) {
		const ext = fileName.split(".").pop()?.toLowerCase();
		if (ext && EXTENSION_LABELS[ext]) return EXTENSION_LABELS[ext];
	}
	switch (type) {
		case "pdf":
			return "PDF";
		case "office":
			return uiText("home.document");
		case "text":
			return uiText("chat.attachmentHelpers.text");
		case "image":
			return uiText("home.image");
		default:
			return uiText("chat.attachmentHelpers.file");
	}
}

export interface FileTypeIconProps {
	type: AttachmentType;
	mimeType: string;
	className?: string;
}

export function FileTypeIcon({ type, mimeType, className }: FileTypeIconProps) {
	const baseClass = cn("h-4 w-4", className);
	if (type === "image") {
		return <ImageIcon className={cn(baseClass, "text-accent")} />;
	}
	const colorClass = getFileColor(type, mimeType);
	return <File className={cn(baseClass, colorClass)} />;
}

function getFileColor(type: AttachmentType, mimeType: string): string {
	if (isCodeFile(mimeType)) return "text-success";
	switch (type) {
		case "pdf":
			return "text-destructive";
		case "office":
			return "text-accent";
		case "text":
			return "text-muted-foreground";
		default:
			return "text-muted-foreground";
	}
}

function isCodeFile(mimeType: string): boolean {
	const codeTypes = [
		"application/javascript",
		"application/typescript",
		"application/json",
		"text/javascript",
		"text/typescript",
		"text/x-python",
		"text/x-java",
		"text/css",
		"text/html",
		"text/xml",
		"application/xml",
		"text/yaml",
	];
	return codeTypes.includes(mimeType) || mimeType.startsWith("text/x-");
}
