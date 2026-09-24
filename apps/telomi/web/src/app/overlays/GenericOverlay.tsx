import { Wrench } from "lucide-react";
import { CodeBlock } from "@/shared/markdown/CodeBlock";
import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { OverlayShell } from "@/app/overlays/OverlayShell";
import { ToolOutputView } from "@/app/overlays/ToolOutputView";
import { uiText } from "@/app/ui-text";

export interface GenericOverlayImage {
	data: string;
	mimeType: string;
}

export interface GenericOverlayProps {
	open: boolean;
	onClose: () => void;
	toolName: string;
	input: Record<string, unknown> | undefined;
	output: string | undefined;
	/** Structured result the tool reported beside its text output. */
	outputDetails?: unknown;
	images?: GenericOverlayImage[];
	error?: string;
	renderOutputAsMarkdown?: boolean;
	markdownInputField?: { key: string; content: string };
}

/** Input keys that carry source text for the tool to run. */
const CODE_INPUT_KEYS = new Set(["code", "command", "cmd", "script", "source"]);

export interface CodeInputField {
	key: string;
	content: string;
	language: string;
}

/**
 * Top-level string inputs that read better as code than as an escaped JSON string: named source
 * fields, or any multi-line value. The tool name picks the highlighting language.
 */
export function codeInputFields(toolName: string, input: Record<string, unknown> | undefined): CodeInputField[] {
	if (!input) return [];
	return Object.entries(input).flatMap(([key, value]) =>
		typeof value === "string" && (CODE_INPUT_KEYS.has(key) || value.includes("\n"))
			? [{ key, content: value, language: codeLanguage(toolName, key) }]
			: []);
}

function codeLanguage(toolName: string, key: string): string {
	const name = toolName.toLowerCase();
	if (name.includes("python")) return "python";
	if (key === "command" || key === "cmd" || /bash|shell/u.test(name)) return "bash";
	return "text";
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

const SECTION_LABEL = "text-[11.5px] font-semibold uppercase tracking-[0.04em] text-[var(--foreground-50)] mb-[0.4rem]";

export function GenericOverlay({
	open,
	onClose,
	toolName,
	input,
	output,
	outputDetails,
	images,
	error,
	renderOutputAsMarkdown,
	markdownInputField,
}: GenericOverlayProps) {
	const hasImages = !!images && images.length > 0;
	const hasOutput = !!output || outputDetails !== undefined;
	// A known markdown-bearing field renders as markdown and source fields render as code; whatever
	// remains stays as JSON, and the JSON block is skipped when nothing remains.
	const codeFields = markdownInputField ? [] : codeInputFields(toolName, input);
	const separatedKeys = new Set([
		...(markdownInputField ? [markdownInputField.key] : []),
		...codeFields.map((field) => field.key),
	]);
	const remainingInputJson = (() => {
		if (!input) return undefined;
		if (separatedKeys.size === 0) return safeStringify(input);
		const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !separatedKeys.has(key)));
		return Object.keys(rest).length > 0 ? safeStringify(rest) : undefined;
	})();
	return (
		<OverlayShell
			open={open}
			onClose={onClose}
			badge={{ icon: Wrench, label: toolName, variant: "gray" }}
			title={uiText("app.genericoverlay.toolCall")}
			error={error ? { label: uiText("app.genericoverlay.toolFailed"), message: error } : undefined}
		>
			<div className="max-w-[1000px] mx-auto flex flex-col gap-4">
				<section className="flex flex-col gap-3">
					{markdownInputField && (
						<div>
							<div className={SECTION_LABEL}>
								{uiText("app.genericoverlay.input")} · {markdownInputField.key}
							</div>
							<div className="bg-[var(--card)] border border-[var(--border)] rounded-[10px] px-4 py-[0.85rem]">
								<MarkdownView text={markdownInputField.content} />
							</div>
						</div>
					)}
					{codeFields.map((field) => (
						<div key={field.key}>
							<div className={SECTION_LABEL}>
								{uiText("app.genericoverlay.input")} · {field.key}
							</div>
							<CodeBlock code={field.content} language={field.language} mode="full" />
						</div>
					))}
					{separatedKeys.size === 0 ? (
						<div>
							<div className={SECTION_LABEL}>{uiText("app.genericoverlay.input")}</div>
							<CodeBlock
								code={remainingInputJson ?? uiText("app.genericoverlay.noArguments")}
								language="json"
								mode="full"
								wrap
							/>
						</div>
					) : remainingInputJson && (
						<div>
							<div className={SECTION_LABEL}>{uiText("app.genericoverlay.otherInput")}</div>
							<CodeBlock code={remainingInputJson} language="json" mode="full" wrap />
						</div>
					)}
				</section>
				{(hasOutput || !hasImages) && (
					<section>
						<div className={SECTION_LABEL}>{uiText("app.genericoverlay.output")}</div>
						<ToolOutputView output={output} details={outputDetails} renderAsMarkdown={renderOutputAsMarkdown} />
					</section>
				)}
				{hasImages && (
					<section>
						<div className={SECTION_LABEL}>
							{uiText("app.genericoverlay.imagesCount", { count: images!.length })}
						</div>
						<div className="flex flex-col gap-2">
							{images!.map((img, i) => (
								<div
									key={i}
									className="bg-[color-mix(in_oklch,var(--muted)_30%,var(--background))] border border-[var(--border)] rounded-[8px] p-2 overflow-auto"
								>
									<img
										src={`data:${img.mimeType};base64,${img.data}`}
										alt={uiText("app.genericoverlay.toolResultImageNumber", { number: i + 1 })}
										className="max-w-full h-auto block mx-auto"
									/>
								</div>
							))}
						</div>
					</section>
				)}
			</div>
		</OverlayShell>
	);
}
