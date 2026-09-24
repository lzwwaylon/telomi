import { useMemo, useState } from "react";
import { DatatableArtifact } from "@/shared/artifact-renderers/DatatableArtifact";
import { CodeBlock } from "@/shared/markdown/CodeBlock";
import { MarkdownJsonBlock } from "@/shared/markdown/MarkdownJsonBlock";
import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";
import {
	formatToolOutput,
	isScalarList,
	looksLikeMarkdown,
	looksLikeTraceback,
	outputStructures,
	outputTable,
} from "@/app/overlays/tool-output";

type OutputView = "table" | "list" | "tree" | "rendered" | "raw";

const VIEW_LABEL = {
	table: "app.genericoverlay.viewTable",
	list: "app.genericoverlay.viewList",
	tree: "app.genericoverlay.viewTree",
	rendered: "app.genericoverlay.viewRendered",
	raw: "app.genericoverlay.viewRaw",
} as const;

/**
 * A tool output in the most readable form its shape allows: rows as a table, scalar arrays as a list,
 * other structure as a collapsible field tree, Markdown rendered. The raw view keeps the exact text, and
 * structure the tool reported beside readable text stays one click away as a field tree.
 */
export function ToolOutputView({
	output,
	details,
	renderAsMarkdown = false,
}: {
	output: string | undefined;
	/** Structured result the tool reported beside its text, preferred over parsing the text. */
	details?: unknown;
	renderAsMarkdown?: boolean;
}) {
	const text = output ?? "";
	const { primary: structured, secondary } = useMemo(() => outputStructures(text, details), [text, details]);
	const table = useMemo(() => (structured === undefined ? undefined : outputTable(structured)), [structured]);
	const views: OutputView[] = structured !== undefined
		? [...(table ? ["table" as const] : []), ...(isScalarList(structured) ? ["list" as const] : []), "tree", "raw"]
		: [
			...(text && (renderAsMarkdown || looksLikeMarkdown(text)) ? ["rendered" as const] : []),
			"raw",
			...(secondary !== undefined ? ["tree" as const] : []),
		];
	const [chosen, setChosen] = useState<OutputView | null>(null);
	const view = chosen && views.includes(chosen) ? chosen : views[0]!;
	return (
		<div className="flex flex-col gap-2">
			{views.length > 1 && (
				<div
					role="group"
					aria-label={uiText("app.genericoverlay.outputViews")}
					className="inline-flex self-start rounded-[7px] border border-[var(--border)] bg-[var(--background)] p-0.5 text-[11.5px]"
				>
					{views.map((kind) => (
						<button
							key={kind}
							type="button"
							aria-pressed={view === kind}
							onClick={() => setChosen(kind)}
							className={cn(
								"rounded-[5px] border-0 bg-transparent px-2 py-0.5 text-[var(--foreground-50)] transition-colors hover:text-[var(--foreground)]",
								view === kind && "bg-[var(--foreground-5)] text-[var(--foreground)]",
							)}
						>
							{uiText(VIEW_LABEL[kind])}
						</button>
					))}
				</div>
			)}
			{view === "table" && table && (
				<DatatableArtifact
					content={JSON.stringify({ ...(table.label ? { title: table.label } : {}), columns: table.columns, rows: table.rows })}
					wrapCells
				/>
			)}
			{view === "list" && isScalarList(structured) && (
				<ol className="m-0 flex list-decimal flex-col gap-1 rounded-[8px] border border-[var(--border)] bg-[var(--background)] py-2 pl-8 pr-3 text-[0.8rem] text-[var(--foreground)]">
					{structured.map((item, index) => (
						<li key={index} className="break-words [overflow-wrap:anywhere]">{item === null ? "null" : String(item)}</li>
					))}
				</ol>
			)}
			{view === "tree" && <MarkdownJsonBlock code={JSON.stringify(structured ?? secondary)} />}
			{view === "rendered" && (
				<div className="rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-4 py-[0.85rem]">
					<MarkdownView text={text} />
				</div>
			)}
			{view === "raw" && <RawOutput text={text} details={details} />}
		</div>
	);
}

function RawOutput({ text, details }: { text: string; details: unknown }) {
	if (!text.trim() && outputStructures("", details).primary !== undefined) {
		return <CodeBlock code={JSON.stringify(details, null, 2)} language="json" mode="full" wrap />;
	}
	if (!text) return <CodeBlock code={uiText("common.noOutput")} language="text" mode="full" wrap />;
	if (looksLikeTraceback(text)) return <CodeBlock code={text} language="python" mode="full" />;
	const formatted = formatToolOutput(text);
	return <CodeBlock code={formatted.code} language={formatted.language} mode="full" wrap />;
}
