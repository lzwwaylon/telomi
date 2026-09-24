import { formatRelativeTime } from "@/shared/lib/format";
import { useNow } from "@/shared/hooks/useNow";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ForwardedRef,
} from "react";
import {
	ChevronDown,
	Folder,
	FolderOpen,
	PanelRightClose,
	RotateCw,
	Sparkles,
	Volume2,
} from "lucide-react";
import { SearchIcon as Search } from "@/shared/ui/icons";
import type { ReactArtifact } from "@/features/goals/data/useArtifacts";
import { getFileType, iconForArtifact } from "@/shared/artifact-preview/artifact-type";
import { useGoalWorkspaceFiles, type WorkspaceFileMeta } from "@/features/goals/data/useGoalWorkspaceFiles";
import { ResizeHandle } from "@/app/ResizeHandle";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";
import { currentUiLocale } from "@/app/i18n";
import { basename, dirname, displayPathLabel, fileLabel, folderLabel } from "@/features/chat/workspace-file-names";
import { GoalActivityPanel } from "@/features/goals/GoalActivityPanel";
import { GoalResearchSchedulePanel } from "@/features/goals/GoalResearchSchedulePanel";
import type { GoalSnapshot } from "@shared/types";

export interface ChatRightDockProps {
	goalId: string | null;
	artifacts: Map<string, ReactArtifact>;
	snapshot?: GoalSnapshot | null;
	onCollapse?: () => void;
	onResize?: (deltaPx: number) => void;
	/** `displayPath` travels with the pick so the preview can name the file the way this list does. */
	onOpenFile: (path: string, line?: number, anchor?: string, displayPath?: string) => void;
}

/** Both the file list and external callers open the same file overlay. */
export interface ChatRightDockHandle {
	openFile: (path: string, line?: number) => void;
}

// File rows use only metadata returned by the Workspace API.
interface DockArtifact {
	/** Guest path: the file's identity for opening, previews and its type. */
	path: string;
	filename: string;
	/** Same segments as `path`, storage keys replaced by the user's own names. Labels and search only. */
	displayPath: string;
	createdAt: number;
	updatedAt: number;
	size: number;
	title?: string;
	summary?: string;
}

/** Disk listing is authoritative; cached metadata can only enrich listed files. */
export function mergeArtifacts(
	memory: Map<string, ReactArtifact>,
	disk: WorkspaceFileMeta[],
): Map<string, DockArtifact> {
	return new Map(disk.map((file) => {
		const cached = memory.get(file.path);
		return [file.path, {
			path: file.path,
			filename: basename(file.path),
			displayPath: file.displayPath ?? file.path,
			createdAt: cached?.createdAt ?? file.mtimeMs,
			updatedAt: file.mtimeMs,
			size: file.size,
			title: file.title,
			summary: file.summary,
		}];
	}));
}

/** Activity overview and the Main Agent Workspace file list. */
export const ChatRightDock = forwardRef(function ChatRightDock(
	{ goalId, artifacts, snapshot, onCollapse, onResize, onOpenFile }: ChatRightDockProps,
	ref: ForwardedRef<ChatRightDockHandle>,
) {
	const [view, setView] = useState<"overview" | "list">("overview");
	const [filter, setFilter] = useState("");
	// Folder expansion and scroll position survive opening a file overlay.
	// expanded is a Set of folder paths; an
	// empty Set means every folder is collapsed (the default first impression).
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [recentCollapsed, setRecentCollapsed] = useState(false);
	const listScrollTopRef = useRef(0);
	const searchRef = useRef<HTMLInputElement>(null);
	const autoExpandedGoalRef = useRef<string | null>(null);

	const diskFiles = useGoalWorkspaceFiles(goalId);
	const merged = useMemo(
		() => mergeArtifacts(artifacts, diskFiles.files),
		[artifacts, diskFiles.files],
	);
	useEffect(() => {
		setView("overview");
		setFilter("");
		setExpanded(new Set());
		setRecentCollapsed(false);
		autoExpandedGoalRef.current = null;
		listScrollTopRef.current = 0;
	}, [goalId]);

	useImperativeHandle(ref, () => ({ openFile: onOpenFile }), [onOpenFile]);

	const items = useMemo(() => Array.from(merged.values()), [merged]);
	const recent = useMemo(
		() => [...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6),
		[items],
	);
	// Search matches what the user reads as well as the guest path they can copy from a tooltip.
	const locale = currentUiLocale();
	const filtered = useMemo(() => {
		if (!filter.trim()) return items;
		const q = filter.trim().toLowerCase();
		return items.filter((a) => [a.path, displayPathLabel(a.path, a.displayPath), fileLabel(a.path, a.displayPath)]
			.some((text) => text.toLowerCase().includes(q)));
	}, [items, filter, locale]);
	const tree = useMemo(() => buildTree(items), [items]);

	useEffect(() => {
		if (!goalId || autoExpandedGoalRef.current === goalId || tree.length === 0) return;
		const topLevelFolders = tree
			.filter((node) => !!node.children?.length)
			.map((node) => node.path);
		setExpanded(new Set(topLevelFolders));
		autoExpandedGoalRef.current = goalId;
	}, [goalId, tree]);


	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (view === "list" && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
				if (searchRef.current) {
					e.preventDefault();
					searchRef.current.focus();
				}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [view]);

	return (
		<aside
			className="relative h-full min-h-0 grid bg-[var(--paper)] border-l border-[var(--line-soft)]"
			style={{ gridTemplateRows: "auto minmax(0,1fr)" }}
			aria-label={uiText("chat.rightdock.chatSidePanel")}
			data-testid="chat-right-dock"
		>
			{onResize && (
				<ResizeHandle
					side="left"
					onResize={onResize}
						label={uiText("chat.rightdock.resizeSidePanel")}
				/>
			)}
			{/* Header */}
			<div className="flex items-center gap-0 px-3 border-b border-[var(--line-soft)]">
				<button
					type="button"
					onClick={() => setView("overview")}
					aria-pressed={view === "overview"}
					className={cn(
						"flex items-center gap-1.5 px-3.5 py-2.5 text-[12.5px] font-medium border-b-2 -mb-px cursor-pointer",
						view === "overview"
							? "text-[var(--ink)] border-[var(--ink)]"
							: "text-[var(--ink-faint)] border-transparent hover:text-[var(--ink)]",
					)}
					data-testid="chat-dock-overview-tab"
				>
						<span>{uiText("chat.rightdock.overview")}</span>
				</button>
				<button
					type="button"
					onClick={() => setView("list")}
					aria-pressed={view === "list"}
					className={cn(
						"flex items-center gap-1.5 px-3.5 py-2.5 text-[12.5px] font-medium border-b-2 -mb-px cursor-pointer",
						view === "list"
							? "text-[var(--ink)] border-[var(--ink)]"
							: "text-[var(--ink-faint)] border-transparent hover:text-[var(--ink)]",
					)}
					data-testid="chat-dock-files-tab"
				>
						<span>{uiText("search.groups.file")}</span>
					<span className="text-[10.5px] font-mono px-1.5 py-px rounded bg-[var(--paper-2)] text-[var(--ink-mut)]">
						{items.length}
					</span>
				</button>
				<div className="ml-auto flex items-center">
					{onCollapse && (
						<button
							type="button"
							onClick={onCollapse}
							title={uiText("chat.rightdock.collapseSidePanel")}
							aria-label={uiText("chat.rightdock.collapseSidePanel")}
							data-testid="chat-right-dock-collapse"
							className="inline-flex items-center justify-center h-7 w-7 max-[760px]:h-[44px] max-[760px]:w-[44px] rounded-[6px] text-[var(--ink-mut)] hover:text-[var(--ink)] hover:bg-[var(--paper-2)] cursor-pointer"
						>
							<PanelRightClose className="h-3.5 w-3.5" aria-hidden />
						</button>
					)}
				</div>
			</div>

			{/* Body */}
			<div className="min-h-0 overflow-hidden relative">
				{/* Keep the file list mounted while the overview or file overlay is open. */}
				<div
					className={cn(
						"absolute inset-0 grid min-h-0",
					)}
					style={{ gridTemplateRows: "minmax(0,1fr)" }}
				>
					{view === "overview" && goalId && (
						<section
							className="goal-side-stack chat-goal-side-stack h-full overflow-y-auto"
							aria-label={uiText("goal.activityAside")}
						>
							<GoalResearchSchedulePanel goalId={goalId} />
							<GoalActivityPanel goalId={goalId} snapshot={snapshot} />
						</section>
					)}
					<div className={cn("min-h-0", view === "overview" && "hidden")}>
						<FilesList
							goalId={goalId}
							items={items}
							recent={recent}
							tree={tree}
							filter={filter}
							filtered={filtered}
							setFilter={setFilter}
							searchRef={searchRef}
							loading={diskFiles.loading}
							truncated={diskFiles.truncated}
							onRefresh={diskFiles.refresh}
							expanded={expanded}
							setExpanded={setExpanded}
							recentCollapsed={recentCollapsed}
							setRecentCollapsed={setRecentCollapsed}
							scrollTopRef={listScrollTopRef}
							onPick={(path, displayPath) => onOpenFile(path, undefined, undefined, displayPath)}
						/>
					</div>
				</div>
			</div>
		</aside>
	);
});

interface FilesListProps {
	goalId: string | null;
	items: DockArtifact[];
	recent: DockArtifact[];
	tree: TreeNodeData[];
	filter: string;
	filtered: DockArtifact[];
	setFilter: (v: string) => void;
	searchRef: React.RefObject<HTMLInputElement>;
	loading: boolean;
	truncated: boolean;
	onRefresh: () => void;
	expanded: Set<string>;
	setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
	recentCollapsed: boolean;
	setRecentCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
	scrollTopRef: React.MutableRefObject<number>;
	onPick: (path: string, displayPath?: string) => void;
}

function FilesList({
	goalId,
	items,
	recent,
	tree,
	filter,
	filtered,
	setFilter,
	searchRef,
	loading,
	truncated,
	onRefresh,
	expanded,
	setExpanded,
	recentCollapsed,
	setRecentCollapsed,
	scrollTopRef,
	onPick,
}: FilesListProps) {
	const toggleFolder = (path: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	const allFolderPaths = useMemo(() => collectFolderPaths(tree), [tree]);
	const expandAll = () => setExpanded(new Set(allFolderPaths));
	const collapseAll = () => setExpanded(new Set());

	const scrollerRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const node = scrollerRef.current;
		if (node) node.scrollTop = scrollTopRef.current;
		// On unmount (e.g. closing the compact dock), save the current scroll
		// position so the next mount can restore it. Using a cleanup is
		// more reliable than depending on onScroll firing.
		return () => {
			if (node) scrollTopRef.current = node.scrollTop;
		};
		// only run on mount/unmount
	}, []);
	const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
		scrollTopRef.current = e.currentTarget.scrollTop;
	};

	if (!goalId) return <EmptyState>{uiText("chat.rightdock.noGoalSelected")}</EmptyState>;

	return (
		<div className="grid h-full min-h-0" style={{ gridTemplateRows: "auto auto minmax(0,1fr) auto" }}>
			{/* Header */}
			<div className="grid grid-cols-[1fr_auto] items-center gap-2 px-4 py-2.5 border-b border-[var(--line-soft)] bg-[var(--paper-2)]">
				<div className="min-w-0">
					<h2 className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[var(--ink-mut)]">
						{uiText("search.groups.file")} <span className="text-[11px] text-[var(--ink-faint)] font-mono normal-case tracking-normal">· {items.length}</span>
					</h2>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={expandAll}
						title={uiText("chat.rightdock.expandAllFolders")}
						aria-label={uiText("chat.rightdock.expandAllFolders")}
						data-testid="chat-dock-files-expand-all"
						className="inline-flex items-center justify-center h-7 w-7 rounded-[6px] text-[var(--ink-mut)] hover:text-[var(--ink)] hover:bg-[var(--paper)] cursor-pointer"
					>
						<FolderOpen className="h-3.5 w-3.5" aria-hidden />
					</button>
					<button
						type="button"
						onClick={collapseAll}
						title={uiText("chat.rightdock.collapseAllFolders")}
						aria-label={uiText("chat.rightdock.collapseAllFolders")}
						data-testid="chat-dock-files-collapse-all"
						className="inline-flex items-center justify-center h-7 w-7 rounded-[6px] text-[var(--ink-mut)] hover:text-[var(--ink)] hover:bg-[var(--paper)] cursor-pointer"
					>
						<Folder className="h-3.5 w-3.5" aria-hidden />
					</button>
					<button
						type="button"
						onClick={onRefresh}
						title={uiText("common.refresh")}
						aria-label={uiText("common.refresh")}
						data-testid="chat-dock-files-refresh"
						className={cn(
							"inline-flex items-center justify-center h-7 w-7 rounded-[6px] text-[var(--ink-mut)] hover:text-[var(--ink)] hover:bg-[var(--paper)] cursor-pointer",
							loading && "opacity-60",
						)}
					>
						<RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden />
					</button>
				</div>
			</div>
			<div />
			{/* List */}
			<div ref={scrollerRef} onScroll={onScroll} className="min-h-0 overflow-y-auto py-1.5">
				{items.length === 0 ? (
					<EmptyState>{uiText("chat.rightdock.thisGoalHasNoArtifactsYet")}</EmptyState>
				) : (
					<>
						{truncated && (
							<div className="px-3 py-1 text-[10.5px] italic text-[var(--ink-faint)]">
								{uiText("chat.rightdock.listTruncatedToTheFirst4000Items")}
							</div>
						)}
						{filter.trim() ? (
							filtered.map((a) => (
								<FileRow key={`f-${a.path}`} a={a} onPick={onPick} showDir />
							))
						) : (
							<>
								{recent.length > 0 && (
									<>
										<GroupHead
											label={uiText("chat.rightdock.recent")}
											count={recent.length}
											lead="★"
											collapsed={recentCollapsed}
											onToggle={() => setRecentCollapsed((v) => !v)}
										/>
										{!recentCollapsed && recent.map((a) => (
											<FileRow key={`r-${a.path}`} a={a} onPick={onPick} highlight showDir />
										))}
									</>
								)}
								<GroupHead label={uiText("chat.rightdock.workspace")} collapsed={false} sectionLead onToggle={() => {}} />
								<TreeView
									nodes={tree}
									depth={0}
									expanded={expanded}
									onToggle={toggleFolder}
									onPick={onPick}
								/>
							</>
						)}
					</>
				)}
			</div>
			{/* Search */}
			<div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--line-soft)] bg-[var(--paper)]">
				<Search className="h-3.5 w-3.5 text-[var(--ink-faint)] shrink-0" aria-hidden />
				<input
					ref={searchRef}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setFilter("");
							(e.target as HTMLInputElement).blur();
						}
					}}
					placeholder={uiText("chat.rightdock.filterFiles")}
					className="flex-1 min-w-0 px-2 py-1 text-[12px] bg-[var(--paper-2)] border border-[var(--line-soft)] rounded-[4px] outline-none text-[var(--ink)] placeholder-[var(--ink-faint)] focus:border-[var(--ink-mut)]"
					data-testid="chat-dock-files-search"
				/>
				<span className="font-mono text-[10.5px] text-[var(--ink-faint)] border border-[var(--line-soft)] rounded px-1.5 py-px">⌘F</span>
			</div>
		</div>
	);
}

function GroupHead({
	label,
	count,
	collapsed,
	onToggle,
	lead,
	sub,
	sectionLead,
}: {
	label: string;
	count?: number;
	collapsed: boolean;
	onToggle: () => void;
	lead?: string;
	sub?: boolean;
	sectionLead?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className={cn(
				"w-full grid grid-cols-[16px_1fr_auto] items-center gap-1.5 text-left",
				"text-[10.5px] uppercase tracking-[0.06em] font-semibold text-[var(--ink-faint)]",
				sub ? "px-3 pt-1.5 pb-1" : "px-3 pt-2 pb-1",
				sectionLead && "mt-1.5",
				"hover:text-[var(--ink-mut)] cursor-pointer",
			)}
		>
			<span aria-hidden className={cn("inline-flex items-center justify-center transition-transform", collapsed && "-rotate-90")}>
				<ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
			</span>
			<span className="truncate">
				{lead && <span className="mr-1">{lead}</span>}
				{label}
			</span>
			{count != null ? (
				<span className="font-mono normal-case tracking-normal text-[10px] text-[var(--ink-faint)]">{count}</span>
			) : (
				<span />
			)}
		</button>
	);
}

function FileRow({
	a,
	onPick,
	highlight,
	depth,
	showDir,
}: {
	a: DockArtifact;
	onPick: (path: string, displayPath?: string) => void;
	highlight?: boolean;
	depth?: number;
	showDir?: boolean;
}) {
	const now = useNow();
	const type = getFileType(a.filename);
	const Icon = type === "audio" ? Volume2 : iconForArtifact(type);
	const dir = dirname(displayPathLabel(a.path, a.displayPath));
	const indent = depth != null ? 12 + depth * 14 : 14;
	return (
		<button
			type="button"
			onClick={() => onPick(a.path, a.displayPath)}
			title={a.path}
			style={{ paddingLeft: `${indent}px`, paddingRight: 12 }}
			className={cn(
				"w-full grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 text-left text-[12.5px]",
				"py-1.5 text-[var(--ink)] hover:bg-[var(--paper-2)] cursor-pointer",
			)}
			data-testid={`chat-dock-file-${a.path.replace(/\//g, "__")}`}
		>
			<span className="text-[var(--ink-faint)] inline-flex items-center justify-center">
				<Icon className="h-3.5 w-3.5" aria-hidden />
			</span>
			<span className="min-w-0 flex flex-col gap-0.5 leading-tight">
				<span className="truncate">{fileLabel(a.path, a.displayPath)}</span>
				{showDir && dir && (
					<span className="truncate text-[10.5px] text-[var(--ink-faint)] font-mono" title={dirname(a.path)}>
						{dir}
					</span>
				)}
			</span>
			{highlight ? (
				<span className="font-mono text-[10px] text-[var(--ink-faint)] whitespace-nowrap">{formatRelativeTime(a.updatedAt, undefined, now)}</span>
			) : (
				<span />
			)}
		</button>
	);
}

function TreeView({
	nodes,
	depth,
	expanded,
	onToggle,
	onPick,
}: {
	nodes: TreeNodeData[];
	depth: number;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	onPick: (path: string, displayPath?: string) => void;
}) {
	return (
		<>
			{nodes.map((node) => (
				<TreeNodeRow
					key={node.path}
					node={node}
					depth={depth}
					expanded={expanded}
					onToggle={onToggle}
					onPick={onPick}
				/>
			))}
		</>
	);
}

function TreeNodeRow({
	node,
	depth,
	expanded,
	onToggle,
	onPick,
}: {
	node: TreeNodeData;
	depth: number;
	expanded: Set<string>;
	onToggle: (path: string) => void;
	onPick: (path: string, displayPath?: string) => void;
}) {
	if (node.file) {
		return <FileRow a={node.file} onPick={onPick} depth={depth} />;
	}
	const isOpen = expanded.has(node.path);
	const indent = 12 + depth * 14;
	const total = countFiles(node);
	const Icon = isOpen ? FolderOpen : Folder;
	return (
		<>
			<button
				type="button"
				onClick={() => onToggle(node.path)}
				title={node.path}
				style={{ paddingLeft: `${indent}px`, paddingRight: 12 }}
				className={cn(
					"w-full grid grid-cols-[14px_18px_1fr_auto] items-center gap-1.5 text-left text-[12.5px]",
					"py-1.5 text-[var(--ink)] hover:bg-[var(--paper-2)] cursor-pointer",
				)}
				data-testid={`chat-dock-folder-${node.path.replace(/\//g, "__")}`}
			>
				<span aria-hidden className={cn("inline-flex items-center justify-center text-[var(--ink-faint)] transition-transform", !isOpen && "-rotate-90")}>
					<ChevronDown className="h-3 w-3" aria-hidden />
				</span>
				<span className="text-[var(--warm)] inline-flex items-center justify-center">
					<Icon className="h-3.5 w-3.5" aria-hidden />
				</span>
				<span className="min-w-0 truncate font-medium">{folderLabel(node.path, node.name)}</span>
				<span className="font-mono text-[10px] text-[var(--ink-faint)]">{total}</span>
			</button>
			{isOpen && node.children && (
				<TreeView
					nodes={node.children}
					depth={depth + 1}
					expanded={expanded}
					onToggle={onToggle}
					onPick={onPick}
				/>
			)}
		</>
	);
}

function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<div className="h-full flex items-center justify-center text-[12.5px] italic text-[var(--ink-faint)] px-6 text-center">
			<div className="flex flex-col items-center gap-2">
				<Sparkles className="h-5 w-5 opacity-50" aria-hidden />
				<div>{children}</div>
			</div>
		</div>
	);
}

// ── helpers ──────────────────────────────────────────────────────────────

interface TreeNodeData {
	name: string;
	path: string;
	children?: TreeNodeData[];
	file?: DockArtifact;
}

// Top-level directory ordering: pin known buckets in a sensible order, push
// anything else to the end alphabetically.
const TOP_ORDER = [
	"artifacts",
	"runs",
	"podcasts",
	"tmp",
	"attachments",
	".pi",
];

// Nodes are keyed by the guest path, so two folders sharing a display name stay apart.
export function buildTree(items: DockArtifact[]): TreeNodeData[] {
	const root: TreeNodeData = { name: "", path: "", children: [] };
	for (const item of items) {
		const parts = item.path.split("/").filter(Boolean);
		const names = item.displayPath.split("/").filter(Boolean);
		let cur = root;
		for (let i = 0; i < parts.length; i++) {
			const isLast = i === parts.length - 1;
			const fullPath = `${item.path.startsWith("/") ? "/" : ""}${parts.slice(0, i + 1).join("/")}`;
			cur.children = cur.children ?? [];
			let next = cur.children.find((c) => c.path === fullPath);
			if (!next) {
				const name = names[i] ?? parts[i];
				next = isLast
					? { name, path: fullPath, file: item }
					: { name, path: fullPath, children: [] };
				cur.children.push(next);
			}
			if (!isLast) cur = next;
		}
	}
	const sortChildren = (node: TreeNodeData, isTop: boolean) => {
		if (!node.children) return;
		node.children.sort((a, b) => {
			const aDir = !!a.children;
			const bDir = !!b.children;
			if (aDir !== bDir) return aDir ? -1 : 1;
			if (isTop) {
				const ai = TOP_ORDER.indexOf(a.name);
				const bi = TOP_ORDER.indexOf(b.name);
				if (ai >= 0 || bi >= 0) {
					if (ai < 0) return 1;
					if (bi < 0) return -1;
					return ai - bi;
				}
			}
			return a.name.localeCompare(b.name);
		});
		for (const c of node.children) sortChildren(c, false);
	};
	sortChildren(root, true);
	return root.children ?? [];
}

function countFiles(node: TreeNodeData): number {
	if (node.file) return 1;
	let n = 0;
	for (const c of node.children ?? []) n += countFiles(c);
	return n;
}

function collectFolderPaths(nodes: TreeNodeData[]): string[] {
	const out: string[] = [];
	const visit = (node: TreeNodeData) => {
		if (!node.children?.length) return;
		out.push(node.path);
		for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return out;
}
