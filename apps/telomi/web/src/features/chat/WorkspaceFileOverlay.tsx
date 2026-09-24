import { AudioArtifact } from "@/features/media/player/AudioArtifact";
import { useContext, useEffect, useMemo, useRef } from "react";
import { DocumentIcon as FileText, DownloadIcon as Download } from "@/shared/ui/icons";
import { OverlayShell } from "@/app/overlays/OverlayShell";
import { uiText } from "@/app/ui-text";
import { ArtifactPreview } from "@/shared/artifact-preview/ArtifactPreview";
import { useArtifactContent, type ArtifactContentState } from "@/shared/artifact-preview/artifact-content";
import { MarkdownPane } from "@/shared/markdown/MarkdownPane";
import { MarkdownLineLocator } from "@/shared/markdown/MarkdownLineLocator";
import { LinkClickContext } from "@/shared/markdown/MarkdownView";
import { resolveWorkspaceFileTarget } from "@/shared/markdown/markdown-link-target";
import { downloadName, fileLabel } from "@/features/chat/workspace-file-names";

interface WorkspaceFileOverlayProps {
	goalId: string;
	path: string;
	line?: number;
	anchor?: string;
	/** Label path from the file list, when the file was opened there. Naming only. */
	displayPath?: string;
	onOpenFile: (path: string, line?: number, anchor?: string) => void;
	onClose: () => void;
}

export function WorkspaceFileOverlay({ goalId, path, line, anchor, displayPath, onOpenFile, onClose }: WorkspaceFileOverlayProps) {
	// The guest path stays the identity: it fetches the bytes and decides the renderer.
	const filename = path.split("/").pop() || path;
	const { title, saveAs } = workspaceFileNaming(path, displayPath);
	const url = `/api/goals/${encodeURIComponent(goalId)}/workspace/blob?path=${encodeURIComponent(path)}`;
	const content = useArtifactContent({ filename, url });
	const currentPath = path;
	const outerContext = useContext(LinkClickContext);
	const linkContext = useMemo(() => ({
		...outerContext,
		goalId,
		resolveFileUrl: (target: string) => {
			const next = resolveWorkspaceFileTarget(target, currentPath);
			return next ? `/api/goals/${encodeURIComponent(goalId)}/workspace/blob?path=${encodeURIComponent(next.path)}` : target;
		},
		onFileClick: (target: string, targetLine?: number) => {
			const next = resolveWorkspaceFileTarget(target, currentPath);
			if (next) onOpenFile(next.path, targetLine ?? next.line, next.anchor);
		},
	}), [outerContext, goalId, currentPath, onOpenFile]);
	return (
		<LinkClickContext.Provider value={linkContext}>
			<OverlayShell open onClose={onClose} title={title}
				badge={{ icon: FileText, label: uiText("search.groups.file") }}
				headerActions={<a href={url} download={saveAs}
					title={uiText("artifacts.preview.downloadFilename", { filename: saveAs })}
					aria-label={uiText("artifacts.preview.downloadFilename", { filename: saveAs })}
					className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-[var(--ink-mut)] hover:bg-[var(--paper-2)]">
					<Download size={16} aria-hidden />
				</a>}
			>
				<div data-testid="workspace-file-overlay" data-path={currentPath}>
					<WorkspaceFileBody key={`${url}:${line ?? ""}:${anchor ?? ""}`} goalId={goalId} path={currentPath}
						url={url} line={line} anchor={anchor} {...content} />
				</div>
			</OverlayShell>
		</LinkClickContext.Provider>
	);
}

/**
 * What the preview calls one file, and what a download saves it as. Callers that only know a path
 * (citations, Markdown links) fall back to it, so the preview never depends on the list.
 */
export function workspaceFileNaming(path: string, displayPath?: string): { title: string; saveAs: string } {
	return { title: fileLabel(path, displayPath ?? path), saveAs: downloadName(path, displayPath) };
}

/** Citation previews address published artifacts, while navigation uses guest paths. */
export function workspaceArtifactName(path: string): string {
	return path.replace(/^\/reports\/([^/]+)\//, "wiki/runs/$1/report/")
		.replace(/^\/work\//, "main/")
		.replace(/^\/artifacts\//, "");
}

export function WorkspaceFileBody({ goalId, path, url, line, anchor, content, error }: ArtifactContentState & {
	goalId: string; path: string; url: string; line?: number; anchor?: string;
}) {
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!anchor || content === null) return;
		const target = Array.from(root.current?.querySelectorAll<HTMLElement>("[id]") ?? [])
			.find((element) => element.id === anchor);
		target?.scrollIntoView({ block: "start" });
	}, [anchor, content]);
	return <div ref={root}><ArtifactPreview renderAudio={(audioUrl, filename) => <AudioArtifact url={audioUrl} filename={filename} />} filename={path.split("/").pop() || path} url={url}
		content={content} error={error} highlightLine={line}
		renderMarkdown={(text) => <MarkdownLineLocator highlightLine={line}>
			<MarkdownPane content={text} goalId={goalId} artifactName={workspaceArtifactName(path)} messageId={path} />
		</MarkdownLineLocator>}
	/></div>;
}
