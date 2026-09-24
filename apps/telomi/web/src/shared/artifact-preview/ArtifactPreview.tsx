import { lazy, Suspense, type ReactNode } from "react";
import { uiText } from "@/app/ui-text";
import { getFileType, isBinaryArtifact } from "@/shared/artifact-preview/artifact-type";
import type { ArtifactContentState } from "@/shared/artifact-preview/artifact-content";
import { CodeArtifact } from "@/shared/artifact-renderers/CodeArtifact";
import { CsvArtifact } from "@/shared/artifact-renderers/CsvArtifact";
import { DatatableArtifact } from "@/shared/artifact-renderers/DatatableArtifact";
import { ImageArtifact } from "@/shared/artifact-renderers/ImageArtifact";
import { JsonArtifact } from "@/shared/artifact-renderers/JsonArtifact";
import { SpreadsheetArtifact } from "@/shared/artifact-renderers/SpreadsheetArtifact";
import { SandboxedIframe } from "@/shared/markdown/SandboxedIframe";

// react-pdf and exceljs are large; only pay for them when such a file is opened.
const PdfArtifact = lazy(() => import("@/shared/artifact-renderers/PdfArtifact").then((module) => ({ default: module.PdfArtifact })));
const XlsxArtifact = lazy(() => import("@/shared/artifact-renderers/XlsxArtifact").then((module) => ({ default: module.XlsxArtifact })));

export interface ArtifactPreviewProps extends ArtifactContentState {
	/** Basename; decides the artifact type, syntax highlighting and download name. */
	filename: string;
	/** Blob URL of this artifact, or null when the surface cannot address it. */
	url: string | null;
	/** 1-based line to reveal, for surfaces that navigate from a citation. */
	highlightLine?: number;
	/** HTML surfaces may reserve different reading heights. */
	htmlHeight?: number;
	/**
	 * Markdown surface of the calling entry point: the reader pane in the Goal
	 * overlay, the line-locating view in the chat dock. Markdown owns its own
	 * layout and is rendered outside `className`.
	 */
	renderMarkdown: (content: string) => ReactNode;
	renderAudio: (url: string, filename: string) => ReactNode;
	/** Padding the entry point wants around non-Markdown bodies. */
	className?: string;
}

/**
 * The one artifact preview: classification, error reporting and format dispatch
 * for every surface that shows a Goal's files. Entry-point differences are
 * inputs, not forks.
 */
export function ArtifactPreview({ filename, url, content, error, highlightLine, htmlHeight, renderMarkdown, renderAudio, className }: ArtifactPreviewProps) {
	const type = getFileType(filename);
	if (type === "markdown" && content !== null) return <>{renderMarkdown(content)}</>;
	return (
		<div className={className}>
			{/* Keyed by the artifact it shows: selecting another one mounts a fresh
			    body, so non-Markdown renderers cannot carry page counts, sheets, failures or
			    measurements over from the previous file. */}
			<PreviewBody
				key={`${filename}\u0000${url ?? ""}`}
				renderAudio={renderAudio}
				type={type}
				filename={filename}
				url={url}
				content={content}
				error={error}
				highlightLine={highlightLine}
				htmlHeight={htmlHeight}
			/>
		</div>
	);
}

function PreviewBody({
	renderAudio,
	type,
	filename,
	url,
	content,
	error,
	highlightLine,
	htmlHeight,
}: ArtifactContentState & {
	type: ReturnType<typeof getFileType>;
	renderAudio: ArtifactPreviewProps["renderAudio"];
	filename: string;
	url: string | null;
	highlightLine?: number;
	htmlHeight?: number;
}) {
	if (error) {
		return (
			<div className="px-2 py-3 text-[12px] text-[var(--warm-deep)]" data-testid="artifact-preview-error">
				{uiText("common.failedToLoad")} {error}
			</div>
		);
	}
	if (isBinaryArtifact(filename)) {
		if (!url) return <Unavailable />;
		if (type === "image") return <ImageArtifact url={url} filename={filename} />;
		if (type === "audio") return <>{renderAudio(url, filename)}</>;
		return (
			<Suspense fallback={<Loading />}>
				{type === "pdf" ? <PdfArtifact url={url} /> : <XlsxArtifact url={url} />}
			</Suspense>
		);
	}
	if (content === null) return url ? <Loading /> : <Unavailable />;

	switch (type) {
		case "html":
			return <SandboxedIframe title={filename} html={content} height={htmlHeight} />;
		case "json":
			return <JsonArtifact content={content} />;
		case "datatable":
			return <DatatableArtifact content={content} />;
		case "spreadsheet":
			return <SpreadsheetArtifact content={content} />;
		case "csv":
		case "tsv":
			return <CsvArtifact content={content} delimiter={type === "tsv" ? "\t" : ","} />;
		case "svg":
			return (
				<div
					className="flex justify-center rounded-[8px] border border-[var(--line-soft)] bg-white p-3"
					dangerouslySetInnerHTML={{ __html: content }}
				/>
			);
		case "code":
		case "diff":
		case "mermaid":
			return <CodeArtifact filename={filename} content={content} highlightLine={highlightLine} />;
		default:
			return (
				<pre className="m-0 max-h-[80vh] overflow-auto whitespace-pre-wrap rounded-[8px] border border-[var(--line-soft)] bg-[var(--paper-2)] p-3 text-[12px] text-[var(--ink)] font-mono">
					{content}
				</pre>
			);
	}
}

function Loading() {
	return <div className="px-2 py-3 text-[12px] italic text-[var(--ink-faint)]">{uiText("common.loading")}</div>;
}

function Unavailable() {
	return <div className="py-6 text-center text-[12px] text-[var(--ink-mut)]">{uiText("artifacts.preview.cannotPreview")}</div>;
}
