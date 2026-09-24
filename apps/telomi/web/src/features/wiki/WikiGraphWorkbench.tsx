import {
	GitBranch,
	Lightbulb,
	Maximize,
	Network,
	Palette,
	SlidersHorizontal,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { CloseIcon as X } from "@/shared/ui/icons";
import { useMemo, useRef, useState } from "react";

import { WikiGraphView, type WikiGraphViewHandle } from "@/features/wiki/WikiGraphView";
import {
	DEFAULT_WIKI_GRAPH_FILTERS,
	filterWikiGraph,
	graphInsights,
	searchWikiGraph,
	type WikiGraphColorMode,
	type WikiGraphFilters,
	type WikiGraphInsight,
} from "@/features/wiki/wiki-graph-workbench";
import { colorsForWikiTypes, WIKI_GRAPH_PALETTE, type WikiGraph } from "@/features/wiki/wiki-model";
import { uiText } from "@/app/ui-text";

export function WikiGraphWorkbench({
	cacheKey,
	graph,
	query,
	selectedId,
	theme,
	onSelect,
	onClear,
}: {
	cacheKey: string;
	graph: WikiGraph;
	query: string;
	selectedId: string | null;
	theme: "dark" | "light";
	onSelect: (id: string) => void;
	onClear: () => void;
}) {
	const graphRef = useRef<WikiGraphViewHandle>(null);
	const [colorMode, setColorMode] = useState<WikiGraphColorMode>("type");
	const [filters, setFilters] = useState<WikiGraphFilters>(DEFAULT_WIKI_GRAPH_FILTERS);
	const [filterOpen, setFilterOpen] = useState(false);
	const [insightsOpen, setInsightsOpen] = useState(false);
	const [nodeScale, setNodeScale] = useState(1);
	const [spacing, setSpacing] = useState(1);
	const [focusIds, setFocusIds] = useState<ReadonlySet<string>>(() => new Set());
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
	const [hintSeen, setHintSeen] = useState(false);
	const filtered = useMemo(() => searchWikiGraph(filterWikiGraph(graph, filters), query), [filters, graph, query]);
	const insights = useMemo(() => graphInsights(graph).filter((item) => !dismissed.has(item.key)), [dismissed, graph]);
	const activeFilterCount = countFilterChanges(filters);

	const toggleType = (type: string) => setFilters((current) => {
		const hiddenTypes = new Set(current.hiddenTypes);
		if (hiddenTypes.has(type)) hiddenTypes.delete(type); else hiddenTypes.add(type);
		return { ...current, hiddenTypes };
	});
	const focusInsight = (insight: WikiGraphInsight) => {
		setFocusIds(new Set(insight.nodeIds));
		if (insight.nodeIds[0]) onSelect(insight.nodeIds[0]);
	};

	return (
		<section className="wiki-graph-workbench" data-testid="wiki-graph-workbench" aria-label={uiText("wiki.graphworkbench.fullWikiGraphWorkspace")} onPointerDownCapture={() => setHintSeen(true)} onWheelCapture={() => setHintSeen(true)}>
			<header className="wiki-graph-toolbar">
				<div className="wiki-graph-stats" aria-label={uiText("wiki.graphworkbench.graphStatistics")}>
					<strong>{uiText("wiki.graphworkbench.knowledgeGraph")}</strong>
					<span>{uiText("wiki.graphworkbench.visibleTotalPages", { visible: filtered.nodes.length, total: graph.nodes.length })}</span>
					<span>{uiText("wiki.graphworkbench.visibleTotalLinks", { visible: filtered.edges.length, total: graph.edges.length })}</span>
					<span>{uiText("wiki.graphworkbench.countCommunities", { count: new Set(filtered.nodes.map((node) => node.community)).size })}</span>
				</div>
				<div className="wiki-graph-actions">
					<button type="button" data-active={filterOpen || activeFilterCount > 0 ? "true" : undefined} onClick={() => setFilterOpen((value) => !value)} aria-expanded={filterOpen}><SlidersHorizontal />{uiText("wiki.graphworkbench.filter")}{activeFilterCount > 0 ? <i>{activeFilterCount}</i> : null}</button>
					<div className="wiki-graph-segment" aria-label={uiText("wiki.graphworkbench.nodeColorMode")}>
						<button type="button" data-active={colorMode === "type" ? "true" : undefined} onClick={() => setColorMode("type")}><Palette />{uiText("common.type")}</button>
						<button type="button" data-active={colorMode === "community" ? "true" : undefined} onClick={() => setColorMode("community")}><Network />{uiText("wiki.graphworkbench.community")}</button>
					</div>
					<button type="button" data-active={insightsOpen ? "true" : undefined} onClick={() => setInsightsOpen((value) => !value)} aria-expanded={insightsOpen}><Lightbulb />{uiText("wiki.graphworkbench.insights")}{insights.length > 0 ? <i>{insights.length}</i> : null}</button>
				</div>
			</header>

			<WikiGraphView
				ref={graphRef}
				cacheKey={cacheKey}
				graph={filtered}
				selectedId={selectedId}
				theme={theme}
				onSelect={(id) => { setFocusIds(new Set()); onSelect(id); }}
				onClear={() => { setFocusIds(new Set()); onClear(); }}
				colorMode={colorMode}
				nodeScale={nodeScale}
				spacing={spacing}
				focusIds={focusIds}
			/>

			<div className="wiki-graph-zoom" aria-label={uiText("wiki.graphworkbench.graphZoom")}>
				<button type="button" onClick={() => graphRef.current?.zoomIn()} aria-label={uiText("wiki.graphworkbench.zoomIn")}><ZoomIn /></button>
				<button type="button" onClick={() => graphRef.current?.zoomOut()} aria-label={uiText("wiki.graphworkbench.zoomOut")}><ZoomOut /></button>
				<button type="button" onClick={() => graphRef.current?.fit()} aria-label={uiText("wiki.graphworkbench.fitAllNodes")}><Maximize /></button>
			</div>

			{filterOpen ? (
				<GraphFiltersPanel
					graph={graph}
					filters={filters}
					nodeScale={nodeScale}
					spacing={spacing}
					onFilters={setFilters}
					onNodeScale={setNodeScale}
					onSpacing={setSpacing}
					onToggleType={toggleType}
					onClose={() => setFilterOpen(false)}
				/>
			) : null}

			{insightsOpen ? (
				<GraphInsightsPanel
					insights={insights}
					onFocus={focusInsight}
					onDismiss={(key) => setDismissed((current) => new Set([...current, key]))}
					onClose={() => setInsightsOpen(false)}
				/>
			) : null}

			<GraphLegend graph={graph} mode={colorMode} hiddenTypes={filters.hiddenTypes} onToggleType={toggleType} />
			{hintSeen ? null : <div className="wiki-graph-hint">{uiText("wiki.graphworkbench.dragToPanScrollToZoomClickToRead")}</div>}
		</section>
	);
}

export function countFilterChanges(filters: WikiGraphFilters, defaults = DEFAULT_WIKI_GRAPH_FILTERS): number {
	const typeChanges = [...new Set([...filters.hiddenTypes, ...defaults.hiddenTypes])]
		.filter((type) => filters.hiddenTypes.has(type) !== defaults.hiddenTypes.has(type)).length;
	return typeChanges
		+ Number(filters.hideStructural !== defaults.hideStructural)
		+ Number(filters.hideIsolated !== defaults.hideIsolated)
		+ Number(filters.minLinks !== defaults.minLinks)
		+ Number(filters.maxLinks !== defaults.maxLinks);
}

function GraphFiltersPanel({ graph, filters, nodeScale, spacing, onFilters, onNodeScale, onSpacing, onToggleType, onClose }: {
	graph: WikiGraph;
	filters: WikiGraphFilters;
	nodeScale: number;
	spacing: number;
	onFilters: (filters: WikiGraphFilters | ((current: WikiGraphFilters) => WikiGraphFilters)) => void;
	onNodeScale: (value: number) => void;
	onSpacing: (value: number) => void;
	onToggleType: (type: string) => void;
	onClose: () => void;
}) {
	return (
		<aside className="wiki-graph-panel wiki-filter-panel" data-testid="wiki-graph-filters" aria-label={uiText("wiki.graphworkbench.graphFilters")}>
			<header><div><SlidersHorizontal /><strong>{uiText("wiki.graphworkbench.graphFilters")}</strong></div><button type="button" onClick={onClose} aria-label={uiText("wiki.graphworkbench.closeFilters")}><X /></button></header>
			<div className="wiki-graph-panel-body">
				<section><h3>{uiText("wiki.graphworkbench.quickFilters")}</h3>
					<label><input type="checkbox" checked={filters.hideStructural} onChange={(event) => onFilters({ ...filters, hideStructural: event.target.checked })} />{uiText("wiki.graphworkbench.hideStructuralPages")}</label>
					<label><input type="checkbox" checked={filters.hideIsolated} onChange={(event) => onFilters({ ...filters, hideIsolated: event.target.checked })} />{uiText("wiki.graphworkbench.hideIsolatedPages")}</label>
				</section>
				<section><h3>{uiText("wiki.graphworkbench.linkCount")}</h3><div className="wiki-filter-number-row">
					<label>{uiText("wiki.graphworkbench.minimum")}<input type="number" min="0" value={filters.minLinks ?? ""} placeholder={uiText("wiki.graphworkbench.any")} onChange={(event) => onFilters({ ...filters, minLinks: event.target.value ? Number(event.target.value) : undefined })} /></label>
					<label>{uiText("wiki.graphworkbench.maximum")}<input type="number" min="0" value={filters.maxLinks ?? ""} placeholder={uiText("wiki.graphworkbench.any")} onChange={(event) => onFilters({ ...filters, maxLinks: event.target.value ? Number(event.target.value) : undefined })} /></label>
				</div></section>
				<section><h3>{uiText("wiki.graphworkbench.displayControls")}</h3>
					<label className="wiki-filter-range"><span>{uiText("wiki.graphworkbench.nodeSize")} <b>{Math.round(nodeScale * 100)}%</b></span><input type="range" min="0.6" max="1.8" step="0.1" value={nodeScale} onChange={(event) => onNodeScale(Number(event.target.value))} /></label>
					<label className="wiki-filter-range"><span>{uiText("wiki.graphworkbench.nodeSpacing")} <b>{Math.round(spacing * 100)}%</b></span><input type="range" min="0.6" max="2" step="0.1" value={spacing} onChange={(event) => onSpacing(Number(event.target.value))} /></label>
				</section>
				<section><h3>{uiText("wiki.graphworkbench.pageTypes")}</h3><div className="wiki-filter-types">{graph.types.map((type) => <label key={type}><input type="checkbox" checked={!filters.hiddenTypes.has(type)} onChange={() => onToggleType(type)} /><span>{type}</span></label>)}</div></section>
			</div>
		</aside>
	);
}

function GraphInsightsPanel({ insights, onFocus, onDismiss, onClose }: { insights: WikiGraphInsight[]; onFocus: (insight: WikiGraphInsight) => void; onDismiss: (key: string) => void; onClose: () => void }) {
	return (
		<aside className="wiki-graph-panel wiki-insights-panel" data-testid="wiki-graph-insights" aria-label={uiText("wiki.graphworkbench.graphInsights")}>
			<header><div><Lightbulb /><strong>{uiText("wiki.graphworkbench.structuralInsights")}</strong><span>{insights.length}</span></div><button type="button" onClick={onClose} aria-label={uiText("wiki.graphworkbench.closeInsights")}><X /></button></header>
			<div className="wiki-graph-panel-body">
				{insights.length === 0 ? <p className="wiki-insights-empty">{uiText("wiki.graphworkbench.noUnresolvedStructuralInsights")}</p> : insights.map((insight) => (
					<article key={insight.key} className="wiki-insight" data-kind={insight.kind}>
						<div><GitBranch /><button type="button" onClick={() => onFocus(insight)}><strong>{insight.title}</strong><span>{insight.description}</span></button><button type="button" onClick={() => onDismiss(insight.key)} aria-label={uiText("wiki.graphworkbench.dismissTitle", { title: insight.title })}><X /></button></div>
						<footer><span>{kindLabel(insight.kind)}</span>{insight.score ? <b>{uiText("wiki.graphworkbench.scoreValue", { score: insight.score })}</b> : null}<button type="button" onClick={() => onFocus(insight)}>{uiText("wiki.graphworkbench.locateInGraph")}</button></footer>
					</article>
				))}
			</div>
		</aside>
	);
}

function kindLabel(kind: WikiGraphInsight["kind"]): string {
	const ids = { connection: "common.crossCommunityConnection", "isolated-node": "common.isolatedPage", "sparse-community": "common.sparseCommunity", "bridge-node": "common.bridgeNode" } as const;
	return uiText(ids[kind]);
}

function GraphLegend({ graph, mode, hiddenTypes, onToggleType }: { graph: WikiGraph; mode: WikiGraphColorMode; hiddenTypes: ReadonlySet<string>; onToggleType: (type: string) => void }) {
	const typeColors = colorsForWikiTypes(graph.types);
	return (
		<div className="wiki-legend" aria-label={mode === "type" ? uiText("wiki.graphworkbench.pageTypeLegend") : uiText("wiki.graphworkbench.knowledgeCommunityLegend")}>
			{mode === "type" ? graph.types.map((type) => <button type="button" key={type} data-hidden={hiddenTypes.has(type) ? "true" : undefined} onClick={() => onToggleType(type)}><i style={{ background: typeColors[type] }} />{type}</button>)
				: graph.communities.map((community) => <span key={community.id} title={uiText("wiki.graphworkbench.countPagesCohesionCohesion", { count: community.nodeCount, cohesion: community.cohesion.toFixed(2) })}><i style={{ background: WIKI_GRAPH_PALETTE[community.id % WIKI_GRAPH_PALETTE.length] }} />{community.topNodes[0] ?? uiText("wiki.graphworkbench.communityNumber", { number: community.id + 1 })} <b>{community.nodeCount}</b></span>)}
		</div>
	);
}
