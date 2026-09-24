import { apiClient } from "@/shared/lib/api-client";
import { formatDate } from "@/shared/lib/format";
import {
	CircleAlert,
	ChevronLeft,
	ChevronRight,
	CornerUpLeft,
	Database,
	Link2,
	Menu,
	Network,
	PanelLeftClose,
	RefreshCw,
} from "lucide-react";
import { BookIcon as BookOpenText, SearchIcon as Search, CloseIcon as X } from "@/shared/ui/icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ActivityProjection } from "@shared/events/activity-projection";
import { subscribeWikiEvents } from "@/shared/lib/goalsEventsStream";
import { currentUiLocale } from "@/app/i18n";
import { uiText } from "@/app/ui-text";
import { refreshOnReconnect } from "@/shared/lib/sharedEventSource";
import { isCurrentPaperThemeDark, PAPER_THEME_CHANGE_EVENT } from "@/shared/lib/theme";
import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { WikiGraphWorkbench } from "@/features/wiki/WikiGraphWorkbench";
import { WikiSearchView } from "@/features/wiki/WikiSearchView";
import { WikiSourcePreview } from "@/features/wiki/WikiSourcePreview";
import { WikiEvidenceDossier } from "@/features/wiki/WikiEvidenceDossier";
import {
	colorsForWikiTypes,
	defaultWikiPage,
	filterWikiPages,
	graphIdForPath,
	groupWikiPagesByType,
	listedWikiPages,
	normalizeWikiFrontmatter,
	normalizeWikiEvidence,
	normalizeWikiPath,
	resolveWikiLink,
	stripDuplicateLeadingHeading,
	stripWikiFrontmatter,
	wikiPageBelongsToTopic,
	wikiStatusFromActivities,
	type WikiFrontmatterEntry,
	type WikiGraph,
	type WikiPage,
	type WikiPageSummary,
} from "@/features/wiki/wiki-model";
import "@/features/wiki/wiki.css";

interface WikiIndexResponse {
	pages?: unknown[];
	topics?: unknown[];
}

interface WikiTopicOption { id: string; title: string; intent: string }

export interface WikiExplorerProps {
	goalId: string;
	topics: WikiTopicOption[];
	activeTopicId: string | null;
	onActiveTopicChange: (topicId: string) => void;
	revision: string | null;
	initialPath: string | null;
	onSelectedPathChange: (path: string | null) => void;
	onBack: () => void;
}

function asStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function summaryFromUnknown(value: unknown): WikiPageSummary | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	const path = normalizeWikiPath(typeof row.path === "string" ? row.path : typeof row.id === "string" ? row.id : "");
	if (!path) return null;
	return {
		path,
		title: typeof row.title === "string" && row.title.trim() ? row.title : path.split("/").pop()?.replace(/\.md$/iu, "") ?? path,
		type: typeof row.type === "string" && row.type.trim() ? row.type : /(^|\/)index\.md$/iu.test(path) ? "Section" : "Reference",
		description: typeof row.description === "string" ? row.description : "",
		primaryTopicRef: typeof row.primaryTopicRef === "string" ? row.primaryTopicRef : "",
		topicRefs: asStrings(row.topicRefs),
	};
}

function normalizeGraph(value: unknown): WikiGraph | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	const nodes = Array.isArray(row.nodes)
		? row.nodes.flatMap((node) => {
			const summary = summaryFromUnknown(node);
			if (!summary || !node || typeof node !== "object") return [];
			const raw = node as Record<string, unknown>;
			return [{
				id: graphIdForPath(summary.path),
				...summary,
				size: typeof raw.size === "number" ? raw.size : 0,
				links: asStrings(raw.links),
				backlinks: asStrings(raw.backlinks),
				missingLinks: asStrings(raw.missingLinks),
				sources: asStrings(raw.sources),
				linkCount: typeof raw.linkCount === "number" ? raw.linkCount : new Set([...asStrings(raw.links), ...asStrings(raw.backlinks)]).size,
				community: typeof raw.community === "number" ? raw.community : 0,
				primaryTopicRef: typeof raw.primaryTopicRef === "string" ? raw.primaryTopicRef : "",
				topicRefs: asStrings(raw.topicRefs),
			}];
		})
		: [];
	return {
		generatedAt: typeof row.generatedAt === "string" ? row.generatedAt : "",
		types: asStrings(row.types),
		nodes,
		edges: Array.isArray(row.edges)
			? row.edges.flatMap((edge) => {
				if (!edge || typeof edge !== "object") return [];
				const raw = edge as Record<string, unknown>;
				const signalRow = raw.signals && typeof raw.signals === "object" ? raw.signals as Record<string, unknown> : null;
				const signals = signalRow && ["direct", "sourceOverlap", "adamicAdar", "typeAffinity"].every((key) => typeof signalRow[key] === "number")
					? { direct: signalRow.direct as number, sourceOverlap: signalRow.sourceOverlap as number, adamicAdar: signalRow.adamicAdar as number, typeAffinity: signalRow.typeAffinity as number }
					: undefined;
				return typeof raw.source === "string" && typeof raw.target === "string"
					? [{ source: raw.source, target: raw.target, weight: typeof raw.weight === "number" ? raw.weight : 1, signals }]
					: [];
			})
			: [],
		communities: Array.isArray(row.communities) ? row.communities.flatMap((community) => {
			if (!community || typeof community !== "object") return [];
			const raw = community as Record<string, unknown>;
			return typeof raw.id === "number" ? [{
				id: raw.id,
				nodeCount: typeof raw.nodeCount === "number" ? raw.nodeCount : 0,
				cohesion: typeof raw.cohesion === "number" ? raw.cohesion : 0,
				topNodes: asStrings(raw.topNodes),
			}] : [];
		}) : [],
	};
}

function normalizePage(value: unknown, fallback: WikiPageSummary): WikiPage {
	const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const summary = summaryFromUnknown(row) ?? fallback;
	const content = stripWikiFrontmatter(typeof row.content === "string" ? row.content : typeof row.body === "string" ? row.body : "");
	const frontmatter = row.frontmatter && typeof row.frontmatter === "object" && !Array.isArray(row.frontmatter)
		? row.frontmatter as Record<string, unknown>
		: {};
	return {
		...summary,
		content: stripDuplicateLeadingHeading(content, summary.title),
		frontmatter: normalizeWikiFrontmatter(frontmatter),
		sources: asStrings(frontmatter.sources),
		evidence: normalizeWikiEvidence(row.evidence),
		links: asStrings(row.links),
		backlinks: asStrings(row.backlinks),
		missingLinks: asStrings(row.missingLinks),
	};
}

function formatTimestamp(value: string): string {
	if (!value) return "";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : formatDate(date, { dateStyle: "medium", timeStyle: "short" }, currentUiLocale());
}

function WikiMetadata({ entries }: { entries: WikiFrontmatterEntry[] }) {
	if (entries.length === 0) return null;
	return (
		<details className="wiki-metadata">
			<summary><strong>{uiText("wiki.explorer.wikiMetadata")}</strong><small>{uiText("wiki.explorer.countFields", { count: entries.length })}</small></summary>
			<dl>{entries.map((entry) => (
				<div key={entry.key}><dt>{entry.key}</dt><dd>{entry.value}</dd></div>
			))}</dl>
		</details>
	);
}

function PageLinks({ title, icon: Icon, pages, onSelect }: { title: string; icon: typeof Link2; pages: WikiPageSummary[]; onSelect: (path: string) => void }) {
	if (pages.length === 0) return null;
	return <details className="wiki-page-links">
		<summary><Icon aria-hidden /><strong>{title}</strong><small>{pages.length}</small><ChevronRight aria-hidden /></summary>
		<div>{pages.map((linked) => <button type="button" key={linked.path} onClick={() => onSelect(linked.path)} aria-label={linked.title}>
			<strong>{linked.title}</strong><i>{linked.type}</i>
		</button>)}</div>
	</details>;
}

function MissingLinks({ targets }: { targets: string[] }) {
	if (targets.length === 0) return null;
	return <section className="wiki-missing-links" aria-label={uiText("wiki.explorer.countMissingLinks", { count: targets.length })}>
		<header><CircleAlert aria-hidden /><h2>{uiText("wiki.explorer.missingLinks")}</h2><span>{targets.length}</span></header>
		<ul>{targets.map((target) => <li key={target}><code>{target}</code><small>{uiText("wiki.explorer.pageNotFound")}</small></li>)}</ul>
	</section>;
}

function WikiPageGroups({ groups, colors, selectedPath, onSelect }: {
	groups: ReturnType<typeof groupWikiPagesByType>;
	colors: Record<string, string>;
	selectedPath: string | null;
	onSelect: (path: string) => void;
}) {
	return groups.map((group) => (
		<div className="wiki-index-kind" key={group.type}>
			<div><span style={{ background: colors[group.type] }} />{group.type === "concept" ? uiText("wiki.explorer.concepts") : uiText("wiki.explorer.entities")}<small>{group.pages.length}</small></div>
			{group.pages.map((item) => (
				<button type="button" key={item.path} className="wiki-index-page" data-active={item.path === selectedPath ? "true" : undefined} onClick={() => onSelect(item.path)} aria-current={item.path === selectedPath ? "page" : undefined} aria-label={item.title} title={item.path}>
					<span style={{ background: colors[group.type] }} /><strong>{item.title}</strong>
				</button>
			))}
		</div>
	));
}

function WikiNavigation({
	pages,
	topics,
	activeTopicId,
	selectedPath,
	query,
	onSelect,
	onTopicSelect,
}: {
	pages: WikiPageSummary[];
	topics: WikiTopicOption[];
	activeTopicId: string | null;
	selectedPath: string | null;
	query: string;
	onSelect: (path: string) => void;
	onTopicSelect: (topicId: string) => void;
}) {
	const topicColors = useMemo(() => colorsForWikiTypes(topics.map((topic) => topic.id)), [topics]);
	const typeColors = useMemo(() => colorsForWikiTypes(["concept", "entity"]), []);
	const activeTopic = topics.find((topic) => topic.id === activeTopicId) ?? topics[0];
	const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set(activeTopic ? [activeTopic.id] : []));
	const activeTopicKey = activeTopic?.id ?? null;
	useEffect(() => {
		if (activeTopicKey) setExpandedIds((current) => current.has(activeTopicKey) ? current : new Set(current).add(activeTopicKey));
	}, [activeTopicKey]);
	const groupsByTopic = useMemo(() => new Map(topics.map((topic) => [
		topic.id,
		groupWikiPagesByType(filterWikiPages(pages.filter((page) => wikiPageBelongsToTopic(page, topic)), query)),
	])), [pages, query, topics]);
	const filtered = useMemo(() => filterWikiPages(pages, query), [pages, query]);
	const groups = useMemo(() => groupWikiPagesByType(filtered), [filtered]);
	return (
		<nav className="wiki-page-index" aria-label={uiText("wiki.explorer.wikiPageIndex")}>
			<div className="wiki-index-head"><span>{topics.length ? uiText("wiki.explorer.topics") : uiText("wiki.explorer.pages")}</span><span>{topics.length || filtered.length}</span></div>
			{topics.map((topic) => {
				const expanded = expandedIds.has(topic.id);
				const active = topic.id === activeTopic?.id;
				const topicGroups = groupsByTopic.get(topic.id) ?? [];
				const pageCount = pages.filter((page) => wikiPageBelongsToTopic(page, topic)).length;
				return <section className="wiki-index-group wiki-index-topic" key={topic.id}>
					<h2>
						<button
							type="button"
							aria-expanded={expanded}
							data-active={active ? "true" : undefined}
							onClick={() => {
								setExpandedIds((current) => {
									const next = new Set(current);
									if (active && expanded) next.delete(topic.id);
									else next.add(topic.id);
									return next;
								});
								if (!active) onTopicSelect(topic.id);
							}}
						>
							<ChevronRight aria-hidden="true" />
							<span style={{ background: topicColors[topic.id] }} />
							<strong>{topic.title}</strong>
							<small>{pageCount}</small>
						</button>
					</h2>
					{expanded && (topicGroups.length
						? <WikiPageGroups groups={topicGroups} colors={typeColors} selectedPath={selectedPath} onSelect={onSelect} />
						: <p className="wiki-index-empty">{uiText("wiki.explorer.noMatchingPages")}</p>)}
				</section>;
			})}
			{topics.length === 0 && <WikiPageGroups groups={groups} colors={typeColors} selectedPath={selectedPath} onSelect={onSelect} />}
			{topics.length === 0 && groups.length === 0 && <p className="wiki-index-empty">{uiText("wiki.explorer.noMatchingPages")}</p>}
		</nav>
	);
}

export function WikiExplorer({ goalId, topics, activeTopicId, onActiveTopicChange, revision, initialPath, onSelectedPathChange, onBack }: WikiExplorerProps) {
	const baseUrl = `/api/goals/${encodeURIComponent(goalId)}/wiki`;
	const [pages, setPages] = useState<WikiPageSummary[]>([]);
	const [wikiTopics, setWikiTopics] = useState<WikiTopicOption[]>([]);
	const [graph, setGraph] = useState<WikiGraph | null>(null);
	const [generatedAt, setGeneratedAt] = useState("");
	const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
	const [sourcePath, setSourcePath] = useState<string | null>(null);
	const [page, setPage] = useState<WikiPage | null>(null);
	const [loadingIndex, setLoadingIndex] = useState(true);
	const [loadingPage, setLoadingPage] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [searchInput, setSearchInput] = useState("");
	const [searchRequest, setSearchRequest] = useState({ query: "", id: 0 });
	const [view, setView] = useState<"explore" | "search">("explore");
	const [navOpen, setNavOpen] = useState(false);
	const [paperTheme, setPaperTheme] = useState<"dark" | "light">(() => isCurrentPaperThemeDark() ? "dark" : "light");
	const [wikiStatus, setWikiStatus] = useState<ReturnType<typeof wikiStatusFromActivities>>(null);
	const [updatedToast, setUpdatedToast] = useState(false);
	const searchRef = useRef<HTMLInputElement>(null);
	const readerRef = useRef<HTMLElement>(null);
	const connectedOnceRef = useRef(false);

	useEffect(() => onSelectedPathChange(selectedPath), [onSelectedPathChange, selectedPath]);

	const loadIndex = useCallback(async (background = false) => {
		if (!background) setLoadingIndex(true);
		setError(null);
		try {
			const revisionQuery = revision ? `?revision=${encodeURIComponent(revision)}` : "";
			const [indexResult, graphResult] = await Promise.allSettled([
				apiClient.get(`${baseUrl}${revisionQuery}`, { headers: { Accept: "application/json" } }),
				apiClient.get(`${baseUrl}/graph${revisionQuery}`, { headers: { Accept: "application/json" } }),
			]);
			if (indexResult.status === "rejected") throw indexResult.reason;
			const index = indexResult.value as WikiIndexResponse;
			const normalizedGraph = graphResult.status === "fulfilled" ? normalizeGraph(graphResult.value) : null;
			const indexPages = Array.isArray(index.pages) ? index.pages.flatMap((item) => summaryFromUnknown(item) ?? []) : [];
			const nextPages = indexPages.length > 0 ? indexPages : normalizedGraph?.nodes.flatMap((node) => {
				const path = normalizeWikiPath(node.id);
					return path ? [{ path, title: node.title, type: node.type, description: node.description,
						primaryTopicRef: node.primaryTopicRef, topicRefs: node.topicRefs }] : [];
				}) ?? [];
				setPages(nextPages);
			setWikiTopics(Array.isArray(index.topics) ? index.topics.flatMap((item) => {
				if (!item || typeof item !== "object") return [];
				const topic = item as Record<string, unknown>;
				return typeof topic.id === "string" && typeof topic.title === "string"
					? [{ id: topic.id, title: topic.title, intent: typeof topic.description === "string" ? topic.description : "" }]
					: [];
			}) : []);
			setGraph(normalizedGraph);
			setGeneratedAt(normalizedGraph?.generatedAt ?? "");
			setSelectedPath((current) => current && nextPages.some((item) => item.path === current) ? current : defaultWikiPage(nextPages));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : uiText("wiki.explorer.wikiIsTemporarilyUnavailable"));
			if (!background) {
					setPages([]);
					setWikiTopics([]);
				setGraph(null);
				setPage(null);
			}
		} finally {
			if (!background) setLoadingIndex(false);
		}
	}, [baseUrl, revision]);

	useEffect(() => {
		void loadIndex();
	}, [loadIndex]);

	const loadWikiStatus = useCallback(async () => {
		try {
			const projection = await apiClient.get<ActivityProjection>(`/api/goals/${encodeURIComponent(goalId)}/events/activity-projection`);
			setWikiStatus(wikiStatusFromActivities(projection.liveActivities ?? []));
		} catch {
			setWikiStatus(null);
		}
	}, [goalId]);

	useEffect(() => {
		void loadWikiStatus();
	}, [loadWikiStatus]);

	useEffect(() => subscribeWikiEvents(goalId, (event) => {
			if (event.type === "wiki-update:changed") {
				if (event.status === "queued" || event.status === "running") {
					setWikiStatus("updating");
					return;
				}
				setWikiStatus(null);
				void loadIndex(true).then(() => setUpdatedToast(true));
				return;
			}
			if (event.type === "topic-plan:changed") {
				if (event.status === "activated") setWikiStatus("rebuilding");
				else if (event.status === "reframed") {
					setWikiStatus(null);
					void loadIndex(true).then(() => setUpdatedToast(true));
				} else if (event.status === "failed") setWikiStatus(null);
			}
		}, refreshOnReconnect(() => {
			if (connectedOnceRef.current) {
				void loadIndex(true);
				void loadWikiStatus();
			}
			connectedOnceRef.current = true;
		})), [goalId, loadIndex, loadWikiStatus]);

	useEffect(() => {
		if (!updatedToast) return;
		const timer = window.setTimeout(() => setUpdatedToast(false), 1_800);
		return () => window.clearTimeout(timer);
	}, [updatedToast]);

	useEffect(() => {
		const syncTheme = () => setPaperTheme(isCurrentPaperThemeDark() ? "dark" : "light");
		window.addEventListener(PAPER_THEME_CHANGE_EVENT, syncTheme);
		return () => window.removeEventListener(PAPER_THEME_CHANGE_EVENT, syncTheme);
	}, []);

	useEffect(() => {
		if (!selectedPath) {
			setPage(null);
			return;
		}
		// Fetch right away instead of waiting for the index; loadIndex resets selectedPath if the path turns out not to exist.
		const fallback: WikiPageSummary = {
			path: selectedPath,
			title: selectedPath.split("/").pop()?.replace(/\.md$/iu, "") ?? selectedPath,
			type: "Reference",
			description: "",
			primaryTopicRef: "",
			topicRefs: [],
		};
		const controller = new AbortController();
		setLoadingPage(true);
		setError(null);
		const params = new URLSearchParams({ path: selectedPath });
		if (revision) params.set("revision", revision);
		void apiClient.get(`${baseUrl}/page?${params}`, { signal: controller.signal, headers: { Accept: "application/json" } })
			.then((value) => setPage(normalizePage(value, fallback)))
			.catch((reason) => {
				if (controller.signal.aborted) return;
				setError(reason instanceof Error ? reason.message : uiText("wiki.explorer.theKnowledgePageIsTemporarilyUnavailable"));
				setPage(null);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoadingPage(false);
			});
		return () => controller.abort();
	}, [baseUrl, revision, selectedPath]);

	useEffect(() => {
		if (!selectedPath) return;
		if (readerRef.current) readerRef.current.scrollTop = 0;
	}, [selectedPath]);

	// The source preview replaces the article inside the same scroller; remember where the reader was and put it back.
	const readerScrollRef = useRef(0);
	const openSource = useCallback((path: string) => {
		readerScrollRef.current = readerRef.current?.scrollTop ?? 0;
		setSourcePath(path);
	}, []);
	useLayoutEffect(() => {
		if (!sourcePath && readerRef.current) readerRef.current.scrollTop = readerScrollRef.current;
	}, [sourcePath]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const editing = target?.closest("input, textarea, [contenteditable='true']");
			if (event.key === "Escape" && (!editing || target === searchRef.current)) {
				setNavOpen(false);
				searchRef.current?.blur();
				return;
			}
			if (editing) return;
			if (event.key === "/") {
				event.preventDefault();
				searchRef.current?.focus();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const [pendingEvidence, setPendingEvidence] = useState<{ path: string; index: number } | null>(null);
	useEffect(() => {
		if (!pendingEvidence || view !== "explore" || loadingPage || page?.path !== pendingEvidence.path) return;
		const target = readerRef.current?.querySelector<HTMLElement>(`#evidence-${pendingEvidence.index}`);
		if (target) {
			target.scrollIntoView({ block: "start", behavior: "auto" });
			target.focus({ preventScroll: true });
		}
		setPendingEvidence(null);
	}, [pendingEvidence, view, loadingPage, page]);

	const selectPage = useCallback((path: string, evidenceIndex?: number) => {
		setPendingEvidence(evidenceIndex ? { path, index: evidenceIndex } : null);
		setView("explore");
		setSourcePath(null);
		setNavOpen(false);
		if (path === selectedPath) return;
		setLoadingPage(true);
		setPage(null);
		setSelectedPath(path);
	}, [selectedPath]);

	const availableTopics = topics.length > 0 ? topics : wikiTopics;
	const activeTopic = availableTopics.find((topic) => topic.id === activeTopicId) ?? availableTopics[0];
	const topicPages = useMemo(() => activeTopic
		? pages.filter((item) => wikiPageBelongsToTopic(item, activeTopic))
		: pages, [activeTopic, pages]);
	const topicGraph = useMemo(() => {
		if (!graph || !activeTopic) return graph;
		const nodes = graph.nodes.filter((node) => wikiPageBelongsToTopic(node, activeTopic));
		const ids = new Set(nodes.map((node) => node.id));
		return {
			...graph,
			nodes,
			edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
			communities: graph.communities.flatMap((community) => {
				const members = nodes.filter((node) => node.community === community.id);
				return members.length ? [{ ...community, nodeCount: members.length, topNodes: community.topNodes.filter((id) => ids.has(id)) }] : [];
			}),
		};
	}, [activeTopic, graph]);

	useEffect(() => {
		if (activeTopic && activeTopic.id !== activeTopicId) onActiveTopicChange(activeTopic.id);
	}, [activeTopic, activeTopicId, onActiveTopicChange]);

	useEffect(() => {
		if (topicPages.length === 0) return;
		setSelectedPath((current) => current && topicPages.some((item) => item.path === current)
			? current
			: defaultWikiPage(topicPages));
	}, [topicPages]);

	const openUrl = useCallback((target: string) => {
		if (target.startsWith("#")) {
			const evidence = readerRef.current?.querySelector<HTMLElement>(target);
			if (evidence) {
				evidence.scrollIntoView({ block: "start", behavior: "auto" });
				evidence.focus({ preventScroll: true });
			}
			return;
		}
		const internalPath = selectedPath ? resolveWikiLink(selectedPath, target) : null;
		if (internalPath && topicPages.some((item) => item.path === internalPath)) {
			selectPage(internalPath);
			return;
		}
		if (/^https?:/iu.test(target)) window.open(target, "_blank", "noopener,noreferrer");
	}, [selectPage, selectedPath, topicPages]);

	const openFile = useCallback((target: string) => {
		if (!selectedPath) return;
		const path = resolveWikiLink(selectedPath, target);
		if (path && topicPages.some((item) => item.path === path)) selectPage(path);
	}, [selectPage, selectedPath, topicPages]);

	const pagesById = useMemo(() => new Map(topicPages.map((item) => [graphIdForPath(item.path), item])), [topicPages]);
	const pageLinks = page ? [...new Set(page.links)].flatMap((id) => pagesById.get(id.replace(/\.md$/iu, "")) ?? []).filter((item) => item.type.toLocaleLowerCase() !== "source") : [];
	const pageBacklinks = page ? [...new Set(page.backlinks)].flatMap((id) => pagesById.get(id.replace(/\.md$/iu, "")) ?? []).filter((item) => item.type.toLocaleLowerCase() !== "source") : [];
	const renderedContent = page?.content ?? "";
	const selectedId = selectedPath ? graphIdForPath(selectedPath) : null;
	const detailPages = useMemo(() => listedWikiPages(topicPages), [topicPages]);
	const selectedPageIndex = selectedPath ? detailPages.findIndex((item) => item.path === selectedPath) : -1;
	const selectGraphNode = useCallback((id: string) => {
		const next = pagesById.get(id);
		if (next) selectPage(next.path);
	}, [pagesById, selectPage]);
	return (
			<section className="wiki-explorer" aria-label="Goal Wiki" data-testid="wiki-explorer">
			<header className="wiki-topbar">
				<div className="wiki-brand">
					<BookOpenText aria-hidden />
					<span className="wiki-brand-divider" />
						{/* The Edition's own facts belong together here. Floating the timestamp over the
							reading pane made it cover a line of whatever was being read, at every scroll
							position, because it was anchored to the explorer rather than to the document. */}
						<div><strong>{uiText("topbar.wiki")}</strong><small>
							{uiText("wiki.explorer.countPages", { count: topicPages.length })}
							{generatedAt && <> · <time className="wiki-generated-time" dateTime={generatedAt}>{uiText("wiki.explorer.updatedTime", { time: formatTimestamp(generatedAt) })}</time></>}
						</small></div>
				</div>
					<nav className="wiki-view-tabs" aria-label={uiText("wiki.explorer.wikiWorkspace")}>
						<button type="button" aria-label={uiText("wiki.explorer.wikiExplorer")} data-active={view === "explore" ? "true" : undefined} aria-current={view === "explore" ? "page" : undefined} onClick={() => setView("explore")}><Network aria-hidden /><span>{uiText("wiki.explorer.explore")}</span></button>
						<button type="button" aria-label={uiText("wiki.explorer.wikiSearch")} data-active={view === "search" ? "true" : undefined} aria-current={view === "search" ? "page" : undefined} onClick={() => { setView("search"); searchRef.current?.focus(); }}><Search aria-hidden /><span>{uiText("common.search")}</span></button>
				</nav>
				<form className="wiki-search" role="search" onSubmit={(event) => {
					event.preventDefault();
					if (!searchInput.trim()) return;
					setSearchRequest((current) => ({ query: searchInput.trim(), id: current.id + 1 }));
					setView("search");
				}}>
					<Search aria-hidden />
					<input ref={searchRef} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={uiText("common.searchWiki")} aria-label={uiText("common.searchWiki")} />
					{searchInput ? <button type="button" onClick={() => { setSearchInput(""); setSearchRequest((current) => ({ query: "", id: current.id + 1 })); searchRef.current?.focus(); }} aria-label={uiText("common.clearSearch")}><X aria-hidden /></button> : <kbd>/</kbd>}
					<button type="submit" disabled={!searchInput.trim()} aria-label={uiText("common.search")}><Search aria-hidden /></button>
				</form>
				{wikiStatus ? <div className="wiki-status-pill" role="status">
					<RefreshCw aria-hidden />
					<span>{wikiStatus === "updating" ? uiText("wiki.explorer.updating") : uiText("wiki.explorer.rebuilding")}</span>
				</div> : null}
				<div className="wiki-topbar-actions">
						<button type="button" className="wiki-mobile-nav-button" onClick={() => setNavOpen(true)} aria-label={uiText("wiki.explorer.openPageIndex")}><Menu aria-hidden /></button>
						<button type="button" onClick={onBack} aria-label={uiText("topbar.backToGoal")} title={uiText("topbar.backToGoal")}><PanelLeftClose aria-hidden /></button>
				</div>
			</header>

			{view === "search" ? <WikiSearchView key={searchRequest.id} query={searchRequest.query} goalId={goalId} topicId={activeTopic?.id} revision={revision} onOpenPage={selectPage} titleFor={(path) => pages.find((item) => item.path === path)?.title} /> : <div className="wiki-main">
					{navOpen && <button type="button" className="wiki-nav-scrim" onClick={() => setNavOpen(false)} aria-label={uiText("wiki.explorer.closePageIndex")} />}
				<aside className="wiki-sidebar" data-open={navOpen ? "true" : undefined}>
						<div className="wiki-mobile-index-head"><span>{availableTopics.length ? uiText("wiki.explorer.topics") : uiText("wiki.explorer.pages")}</span><button type="button" onClick={() => setNavOpen(false)} aria-label={uiText("wiki.explorer.closePageIndex")}><X aria-hidden /></button></div>
						<label className="wiki-page-filter">
							<span className="sr-only">{uiText("wiki.explorer.filterPages")}</span>
							<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={uiText("wiki.explorer.filterPages")} />
						</label>
						<WikiNavigation pages={pages} topics={availableTopics} activeTopicId={activeTopic?.id ?? null} selectedPath={selectedPath} query={query} onSelect={selectPage} onTopicSelect={onActiveTopicChange} />
				</aside>

					<section className="wiki-graph-stage" aria-label={uiText("wiki.explorer.wikiGraph")}>
					{topicGraph && topicGraph.nodes.length > 0 ? (
						<WikiGraphWorkbench cacheKey={`${goalId}:${activeTopic?.id ?? "all"}`} graph={topicGraph} query={query} selectedId={selectedId} theme={paperTheme} onSelect={selectGraphNode} onClear={() => setSelectedPath(null)} />
					) : (
							<div className="wiki-graph-empty">{loadingIndex ? uiText("wiki.explorer.buildingGraph") : uiText("wiki.explorer.noLinkedPages")}</div>
					)}
				</section>

				<main ref={readerRef} className="wiki-detail" data-source-preview={sourcePath ? "true" : undefined} tabIndex={-1}>
					{sourcePath ? <WikiSourcePreview goalId={goalId} path={sourcePath} revision={revision} onBack={() => setSourcePath(null)} /> : <>
					{loadingIndex ? (
							<div className="wiki-state" role="status"><BookOpenText aria-hidden /><p>{uiText("wiki.explorer.loadingWiki")}</p></div>
					) : error && !page ? (
							<div className="wiki-state" role="alert"><h2>{uiText("wiki.explorer.wikiIsTemporarilyUnavailable")}</h2><p>{error}</p><button type="button" onClick={() => void loadIndex()}>{uiText("wiki.explorer.retry")}</button></div>
					) : topicPages.length === 0 ? (
							<div className="wiki-state"><BookOpenText aria-hidden /><h2>{uiText("wiki.explorer.noKnowledgePagesYet")}</h2><p>{uiText("wiki.explorer.pagesAndRelationshipsWillAppearHereAfterResearchOrganizes")}</p></div>
					) : loadingPage ? (
							<div className="wiki-state" role="status"><p>{uiText("wiki.explorer.openingPage")}</p></div>
					) : !page ? (
							<div className="wiki-state"><BookOpenText aria-hidden /><p>{uiText("wiki.explorer.selectAPageToReadOrExploreTheGraph")}</p></div>
					) : (
						<article className="wiki-detail-document">
							<div className="wiki-page-kicker"><span className="wiki-page-type">{page.type}</span><span>{String(selectedPageIndex + 1).padStart(2, "0")} / {String(detailPages.length).padStart(2, "0")}</span></div>
							<h1>{page.title}</h1>
							{page.description && <p className="wiki-page-description">{page.description}</p>}
							<hr />
								{page.sources.length > 0 && page.evidence.length === 0 && <section className="wiki-source-evidence" aria-label={uiText("wiki.explorer.sourceEvidenceCount", { count: page.sources.length })}>
									<header><Database aria-hidden /><h2>{uiText("common.sourceEvidence")}</h2><span>{page.sources.length}</span></header>
									<div>{page.sources.map((source) => <button type="button" key={source} onClick={() => openSource(source)}><code>{source}</code><small>{uiText("wiki.explorer.openOriginal")}</small></button>)}</div>
							</section>}
							{pageLinks.length > 0 || pageBacklinks.length > 0 ? <section className="wiki-page-connections" aria-labelledby="wiki-page-connections-title">
									<header><Network aria-hidden /><h2 id="wiki-page-connections-title">{uiText("wiki.explorer.connections")}</h2></header>
									<PageLinks key={`${page.path}:related`} title={uiText("common.relatedPages")} icon={Link2} pages={pageLinks} onSelect={selectPage} />
									<PageLinks key={`${page.path}:backlinks`} title={uiText("common.referencedBy")} icon={CornerUpLeft} pages={pageBacklinks} onSelect={selectPage} />
							</section> : null}
							<MissingLinks targets={page.missingLinks} />
							<WikiMetadata entries={page.frontmatter} />
							<MarkdownView text={renderedContent} mode="document" linkify={false} goalId={goalId} onFileClick={openFile} onUrlClick={openUrl} className="wiki-markdown" />
							<WikiEvidenceDossier goalId={goalId} evidence={page.evidence} revision={revision} onOpenSource={openSource} />
								<nav className="wiki-detail-pager" aria-label={uiText("wiki.explorer.adjacentKnowledgePages")}>
									{selectedPageIndex > 0 ? <button type="button" onClick={() => selectPage(detailPages[selectedPageIndex - 1]!.path)}><ChevronLeft aria-hidden /><span><small>{uiText("wiki.explorer.previous")}</small>{detailPages[selectedPageIndex - 1]!.title}</span></button> : <span />}
									{selectedPageIndex >= 0 && selectedPageIndex < detailPages.length - 1 ? <button type="button" onClick={() => selectPage(detailPages[selectedPageIndex + 1]!.path)}><span><small>{uiText("wiki.explorer.next")}</small>{detailPages[selectedPageIndex + 1]!.title}</span><ChevronRight aria-hidden /></button> : <span />}
							</nav>
						</article>
					)}
					</>}
				</main>
			</div>}
				<div className="wiki-toast" data-show={updatedToast ? "true" : undefined}>{uiText("wiki.explorer.wikiUpdated")}</div>
		</section>
	);
}
