import { AudioArtifact } from "@/features/media/player/AudioArtifact";
import { formatRelativeTime } from "@/shared/lib/format";
import { useNow } from "@/shared/hooks/useNow";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ArrowUp,
	ChevronLeft,
	ChevronRight,
	Maximize2,
	PanelLeft,
	PanelLeftClose,
} from "lucide-react";
import { CopyIcon as Copy, DownloadIcon as Download, CloseIcon as X } from "@/shared/ui/icons";
import { useGoalArtifactFiles, type ArtifactFileMeta } from "@/features/goals/data/useGoalArtifactFiles";
import { getFileType, iconForArtifact } from "@/shared/artifact-preview/artifact-type";
import { useArtifactContent } from "@/shared/artifact-preview/artifact-content";
import { ArtifactPreview } from "@/shared/artifact-preview/ArtifactPreview";
import { MarkdownPane } from "@/shared/markdown/MarkdownPane";
import { cn } from "@/shared/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { uiText } from "@/app/ui-text";

export interface ArtifactsOverlayProps {
	goalId: string;
	filename: string;
	onClose: () => void;
	onSelect: (filename: string) => void;
	onFullscreen: () => void;
}

export function ArtifactsOverlay({ goalId, filename, onClose, onSelect, onFullscreen }: ArtifactsOverlayProps) {
	const { files: allFiles } = useGoalArtifactFiles(goalId);
	const files = useMemo(() => allFiles.filter(file => file.product !== false), [allFiles]);
	const active = useMemo<ArtifactFileMeta>(() => {
		const found = allFiles.find((f) => f.name === filename);
		if (found) return found;
		return {
			name: filename,
			size: 0,
			modifiedAt: "",
			mtimeMs: 0,
		};
	}, [allFiles, filename]);

	const navigate = useCallback(
		(dir: 1 | -1) => {
			if (!files.length) return;
			const idx = files.findIndex((f) => f.name === filename);
			if (idx < 0) {
				onSelect(files[0].name);
				return;
			}
			const next = (idx + dir + files.length) % files.length;
			onSelect(files[next].name);
		},
		[files, filename, onSelect],
	);


	const blobUrl = blobHref(goalId, active.name);

	const onCopyName = async () => {
		try {
			await navigator.clipboard.writeText(active.name);
		} catch {
			/* ignore */
		}
	};

	// Right pane scroll state — drives progress bar + back-to-top.
	const scrollRef = useRef<HTMLElement | null>(null);
	const [progress, setProgress] = useState(0);
	const [showBackTop, setShowBackTop] = useState(false);

	// Left file-list sidebar — collapsed by default, user toggles via toolbar.
	const [sidebarOpen, setSidebarOpen] = useState(false);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const max = Math.max(1, el.scrollHeight - el.clientHeight);
		const pct = Math.max(0, Math.min(1, el.scrollTop / max));
		setProgress(pct);
		setShowBackTop(el.scrollTop > 240);
	}, []);

	useEffect(() => {
		// Reset scroll + progress whenever the active file changes.
		const el = scrollRef.current;
		if (el) el.scrollTop = 0;
		setProgress(0);
		setShowBackTop(false);
	}, [filename]);

	const onBackTop = useCallback(() => {
		scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
	}, []);

	return (
		<Dialog open onOpenChange={(value) => { if (!value) onClose(); }}>
			<DialogContent
				showCloseButton={false}
				aria-describedby={undefined}
				overlayClassName="bg-black/40 backdrop-blur-[2px]"
				data-testid="artifacts-overlay"
				onKeyDown={(event) => {
					if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true], [role=slider]")) return;
					if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
						event.preventDefault();
						navigate(event.key === "ArrowLeft" ? -1 : 1);
					}
				}}
				className={cn(
					"grid max-w-none sm:max-w-none gap-0 p-0 bg-[var(--paper)] border border-[var(--line)] rounded-[14px] overflow-hidden",
					"w-[min(1200px,calc(100vw-3rem))] h-[min(820px,calc(100vh-3rem))]",
					"transition-[grid-template-columns] duration-200 ease-out",
				)}
				style={{
					gridTemplateColumns: sidebarOpen ? "260px 1fr" : "0 1fr",
					gridTemplateRows: "auto 2px minmax(0,1fr)",
					boxShadow: "var(--shadow-float)",
				}}
			>
				<DialogTitle className="sr-only">{uiText("goals.artifactsoverlay.artifactPreview")}</DialogTitle>
				{/* Top toolbar (spans both columns) */}
				<div
					className="grid items-center gap-2 px-3 py-2 border-b border-[var(--line-soft)] bg-[var(--paper-2)]"
					style={{ gridColumn: "1 / span 2", gridTemplateColumns: "1fr auto" }}
				>
					<div className="flex items-center gap-2 min-w-0">
						<IconBtn
							title={sidebarOpen ? uiText("goals.artifactsoverlay.collapseFileList") : uiText("goals.artifactsoverlay.expandFileList")}
							onClick={() => setSidebarOpen((v) => !v)}
							testid="artifacts-overlay-sidebar-toggle"
						>
							{sidebarOpen ? (
								<PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
							) : (
								<PanelLeft className="h-3.5 w-3.5" aria-hidden />
							)}
						</IconBtn>
						<span className="hidden sm:inline text-[10px] uppercase tracking-[0.04em] font-semibold px-1.5 py-px bg-[var(--paper)] border border-[var(--line-soft)] rounded text-[var(--ink-mut)]">
								{uiText("common.artifacts")}
						</span>
						<span className="font-mono text-[12.5px] text-[var(--ink)] truncate min-w-0">
							{active.title || active.name}
						</span>
						<span className="hidden sm:inline text-[10px] uppercase tracking-[0.04em] px-1.5 py-px bg-[var(--paper)] border border-[var(--line-soft)] rounded text-[var(--ink-mut)] font-sans">
							{getFileType(active.name)}
						</span>
					</div>
					<div className="inline-flex items-center gap-px">
						<IconBtn title={uiText("common.previous")} onClick={() => navigate(-1)} testid="artifacts-overlay-prev">
							<ChevronLeft className="h-3.5 w-3.5" aria-hidden />
						</IconBtn>
						<IconBtn title={uiText("common.next")} onClick={() => navigate(1)} testid="artifacts-overlay-next">
							<ChevronRight className="h-3.5 w-3.5" aria-hidden />
						</IconBtn>
						<span className="w-px h-3.5 bg-[var(--line-soft)] mx-1" />
						<IconBtn title={uiText("goals.artifactsoverlay.copyFilename")} onClick={onCopyName}>
							<Copy className="h-3.5 w-3.5" aria-hidden />
						</IconBtn>
						<a
							href={blobUrl}
							download={active.name}
							title={uiText("common.download")}
							className="inline-flex items-center justify-center h-7 w-7 rounded-[6px] text-[var(--ink-mut)] hover:text-[var(--ink)] hover:bg-[var(--paper)] cursor-pointer"
							data-testid="artifacts-overlay-download"
						>
							<Download className="h-3.5 w-3.5" aria-hidden />
						</a>
						<span className="w-px h-3.5 bg-[var(--line-soft)] mx-1" />
						{getFileType(active.name) === "markdown" && <IconBtn title={uiText("goals.mediacard.readFullscreen")} onClick={onFullscreen} testid="artifacts-overlay-fullscreen"><Maximize2 className="h-3.5 w-3.5" aria-hidden /></IconBtn>}
						<IconBtn title={uiText("common.closeEsc")} onClick={onClose} testid="artifacts-overlay-close">
							<X className="h-3.5 w-3.5" aria-hidden />
						</IconBtn>
					</div>
				</div>

				{/* Progress strip (spans both columns) */}
				<div
					className="bg-[var(--line-soft)]"
					style={{ gridColumn: "1 / span 2" }}
					data-testid="artifacts-overlay-progress"
					role="progressbar"
					aria-valuenow={Math.round(progress * 100)}
					aria-valuemin={0}
					aria-valuemax={100}
				>
					<div
						className="h-full bg-[var(--accent,#3b82f6)] transition-[width] duration-150"
						style={{ width: `${progress * 100}%` }}
					/>
				</div>

				{/* Left: file list — collapsible. The grid track animates between
				    260px and 0 so the right pane reflows; aside crops content via
				    overflow-hidden, and we drop the right border when fully closed. */}
				<aside
					className={cn(
						"min-h-0 overflow-hidden",
						sidebarOpen ? "border-r border-[var(--line-soft)]" : "border-r-0",
					)}
				>
					<div className="h-full overflow-y-auto" style={{ width: 260 }}>
						{files.length === 0 ? (
							<div className="p-4 text-[12px] italic text-[var(--ink-faint)]">{uiText("goal.productsEmpty")}</div>
						) : (
							files.map((f) => (
								<FileRow key={f.name} file={f} active={f.name === filename} onPick={() => onSelect(f.name)} />
							))
						)}
					</div>
				</aside>

				{/* Right: preview */}
				<section
					ref={scrollRef}
					onScroll={onScroll}
					className="relative min-h-0 overflow-auto bg-[var(--background)]"
				>
					<PreviewBody goalId={goalId} file={active} />
					{showBackTop && (
						<button
							type="button"
							onClick={onBackTop}
							title={uiText("goals.artifactsoverlay.backToTop")}
							data-testid="artifacts-overlay-back-top"
							className="absolute bottom-4 right-4 z-10 h-9 w-9 rounded-full border border-[var(--line)] bg-[var(--paper)] shadow-sm hover:bg-[var(--paper-2)] inline-flex items-center justify-center text-[var(--ink-mut)] hover:text-[var(--ink)] cursor-pointer"
						>
							<ArrowUp className="h-4 w-4" aria-hidden />
						</button>
					)}
				</section>
			</DialogContent>
		</Dialog>
	);
}

function blobHref(goalId: string, name: string): string {
	return `/api/goals/${encodeURIComponent(goalId)}/artifacts/blob?name=${encodeURIComponent(name)}`;
}

function FileRow({
	file,
	active,
	onPick,
}: {
	file: ArtifactFileMeta;
	active: boolean;
	onPick: () => void;
}) {
	const Icon = iconForArtifact(getFileType(file.name));
	const display = file.title || file.name;
	const now = useNow();
	return (
		<button
			type="button"
			onClick={onPick}
			className={cn(
				"w-full grid grid-cols-[18px_1fr_auto] items-center gap-2 text-left text-[12.5px] px-3 py-1.5 cursor-pointer",
				active
					? "bg-[var(--paper-2)] text-[var(--ink)]"
					: "text-[var(--ink-mut)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]",
			)}
			data-testid={`artifacts-overlay-row-${file.name}`}
		>
			<span className="text-[var(--ink-faint)] inline-flex items-center justify-center">
				<Icon className="h-3.5 w-3.5" aria-hidden />
			</span>
			<span className="truncate">{display}</span>
			<span className="font-mono text-[10px] text-[var(--ink-faint)]">{formatRelativeTime(file.mtimeMs, undefined, now)}</span>
		</button>
	);
}

function IconBtn({
	children,
	title,
	onClick,
	testid,
}: {
	children: React.ReactNode;
	title: string;
	onClick?: () => void;
	testid?: string;
}) {
	return (
		<button
			type="button"
			title={title}
			aria-label={title}
			onClick={onClick}
			data-testid={testid}
			className="inline-flex items-center justify-center h-7 w-7 rounded-[6px] text-[var(--ink-mut)] hover:text-[var(--ink)] hover:bg-[var(--paper)] cursor-pointer"
		>
			{children}
		</button>
	);
}

function PreviewBody({ goalId, file }: { goalId: string; file: ArtifactFileMeta }) {
	const url = blobHref(goalId, file.name);
	const { content, error } = useArtifactContent({ filename: file.name, url });
	return (
		<ArtifactPreview renderAudio={(audioUrl, filename) => <AudioArtifact url={audioUrl} filename={filename} />}
			filename={file.name}
			url={url}
			content={content}
			error={error}
			htmlHeight={720}
			className="px-4 py-3"
			renderMarkdown={(text) => (
				<MarkdownPane
					content={text}
					goalId={goalId}
					artifactName={file.name}
					messageId={file.cardId || file.name}
				/>
			)}
		/>
	);
}
