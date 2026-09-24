import { DocumentIcon as FileText, ArrowLeftIcon as ArrowLeft, DownloadIcon as Download } from "@/shared/ui/icons";
import { useMemo } from "react";
import { useArtifactMarkdownBody } from "@/features/goals/data/useArtifactMarkdownBody";
import { useGoalArtifactFiles } from "@/features/goals/data/useGoalArtifactFiles";
import { MarkdownPane } from "@/shared/markdown/MarkdownPane";
import { uiText } from "@/app/ui-text";

interface ArtifactReaderPageProps {
	goalId: string;
	filename: string;
	onBack: () => void;
}

function blobHref(goalId: string, name: string): string {
	return `/api/goals/${encodeURIComponent(goalId)}/artifacts/blob?name=${encodeURIComponent(name)}`;
}

function basename(name: string): string {
	return name.split("/").pop() || name;
}

function normalizeHeadingText(text: string): string {
	return text
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function readerMarkdown(markdown: string, title: string): string {
	let next = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");
	const lines = next.split(/\r?\n/);
	const firstContent = lines.findIndex((line) => line.trim().length > 0);
	if (firstContent >= 0) {
		const match = /^#\s+(.+?)\s*$/.exec(lines[firstContent]?.trim() ?? "");
		if (match && normalizeHeadingText(match[1]) === normalizeHeadingText(title)) {
			lines.splice(firstContent, 1);
			next = lines.join("\n").replace(/^\s+/, "");
		}
	}
	return next;
}

export function ArtifactReaderPage({ goalId, filename, onBack }: ArtifactReaderPageProps) {
	const { files } = useGoalArtifactFiles(goalId);
	const meta = useMemo(() => files.find((file) => file.name === filename) ?? null, [files, filename]);
	const { markdown, loading, error } = useArtifactMarkdownBody(goalId, filename, true);
	const title = meta?.title || basename(filename);
	const messageId = meta?.cardId || filename;
	const href = blobHref(goalId, filename);
	const displayMarkdown = useMemo(() => readerMarkdown(markdown, title), [markdown, title]);

	return (
		<section className="artifact-reader-page" data-testid="artifact-reader-page">
			<header className="artifact-reader-head">
				<div className="artifact-reader-head-inner">
					<button type="button" className="artifact-reader-icon-btn" onClick={onBack} title={uiText("topbar.backToGoal")}>
						<ArrowLeft size={16} aria-hidden />
					</button>
					<div className="artifact-reader-titleblock">
						<div className="artifact-reader-kicker">
							<FileText size={13} aria-hidden />
							<span>Markdown</span>
						</div>
						<h1>{title}</h1>
						<p>{filename}</p>
					</div>
					<a
						href={href}
						download={filename}
						className="artifact-reader-icon-btn"
						title={uiText("goals.artifactreaderpage.downloadMarkdown")}
						aria-label={uiText("goals.artifactreaderpage.downloadMarkdown")}
					>
						<Download size={16} aria-hidden />
					</a>
				</div>
			</header>

			<main className="artifact-reader-body">
				{error ? (
					<div className="artifact-reader-state">{uiText("common.failedToReadMarkdown")} {error}</div>
				) : loading && !markdown ? (
					<div className="artifact-reader-state">{uiText("common.loadingName", { name: filename })}</div>
				) : (
					<MarkdownPane
						content={displayMarkdown}
						goalId={goalId}
						artifactName={filename}
						messageId={messageId}
						variant="reader"
					/>
				)}
			</main>
		</section>
	);
}
