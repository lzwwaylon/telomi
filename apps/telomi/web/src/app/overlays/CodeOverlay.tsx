import { PenLine } from "lucide-react";
import { BookIcon as BookOpen } from "@/shared/ui/icons";
import { uiText } from "@/app/ui-text";
import { CodeBlock } from "@/shared/markdown/CodeBlock";
import { OverlayShell } from "@/app/overlays/OverlayShell";

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	cs: "csharp",
	cpp: "cpp",
	cc: "cpp",
	c: "c",
	h: "c",
	hpp: "cpp",
	swift: "swift",
	php: "php",
	sh: "bash",
	zsh: "bash",
	fish: "bash",
	yml: "yaml",
	yaml: "yaml",
	json: "json",
	toml: "toml",
	xml: "xml",
	html: "html",
	css: "css",
	scss: "scss",
	md: "markdown",
	mdx: "markdown",
	sql: "sql",
};

function detectLanguage(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return EXT_TO_LANG[ext] ?? "text";
}

export interface CodeOverlayProps {
	open: boolean;
	onClose: () => void;
	mode: "read" | "write";
	filePath: string;
	content: string;
	error?: string;
}

export function CodeOverlay({ open, onClose, mode, filePath, content, error }: CodeOverlayProps) {
	const isEmpty = content.length === 0;
	const lineCount = isEmpty ? 0 : content.split("\n").length;
	const subtitle = isEmpty
		? mode === "write"
			? uiText("app.codeoverlay.emptyContent")
			: error
				? undefined
				: uiText("app.codeoverlay.emptyFile")
		: uiText("app.codeoverlay.countLines", { count: lineCount });
	const language = detectLanguage(filePath);

	return (
		<OverlayShell
			open={open}
			onClose={onClose}
			badge={{
				icon: mode === "write" ? PenLine : BookOpen,
				label: mode === "write" ? uiText("app.codeoverlay.write") : uiText("app.codeoverlay.read"),
				variant: mode === "write" ? "amber" : "blue",
			}}
			title={filePath}
			subtitle={subtitle}
			error={error ? { label: mode === "write" ? uiText("app.codeoverlay.writeFailed") : uiText("app.codeoverlay.readFailed"), message: error } : undefined}
		>
			<div className="max-w-[1000px] mx-auto">
				{isEmpty ? (
					<div className="text-[var(--foreground-50)] text-[13px] italic px-1 py-2 font-[ui-monospace,SFMono-Regular,monospace]">
						{mode === "write" ? uiText("app.codeoverlay.wroteEmptyContent") : uiText("app.codeoverlay.emptyFile.8b4bcdf")}
					</div>
				) : (
					<CodeBlock code={content} language={language} mode="full" />
				)}
			</div>
		</OverlayShell>
	);
}
