import type ForceGraph from "force-graph";
import type { LinkObject, NodeObject } from "force-graph";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { colorsForWikiTypes, edgeRelevanceLabel, WIKI_GRAPH_PALETTE, type WikiGraph, type WikiGraphEdgeSignals, type WikiGraphNode } from "@/features/wiki/wiki-model";
import type { WikiGraphColorMode } from "@/features/wiki/wiki-graph-workbench";
import { placeGraphLabels } from "@/features/wiki/wiki-graph-labels";
import { uiText } from "@/app/ui-text";

interface RenderNode extends NodeObject {
	id: string;
	title: string;
	type: string;
	description: string;
	color: string;
	anchor: boolean;
	r: number;
	community: number;
	linkCount: number;
}

interface RenderLink extends LinkObject<RenderNode> { weight?: number; signals?: WikiGraphEdgeSignals }

type GraphInstance = ForceGraph<RenderNode, RenderLink>;

export interface WikiGraphViewProps {
	cacheKey?: string;
	graph: WikiGraph;
	selectedId: string | null;
	theme: "dark" | "light";
	onSelect: (id: string) => void;
	onClear: () => void;
	fitToView?: boolean;
	colorMode?: WikiGraphColorMode;
	nodeScale?: number;
	spacing?: number;
	focusIds?: ReadonlySet<string>;
}

const positionCache = new Map<string, { x: number; y: number }>();

export interface WikiGraphViewHandle {
	fit(): void;
	zoomIn(): void;
	zoomOut(): void;
}

function hexAlpha(hex: string, alpha: number): string {
	const value = hex.replace("#", "");
	if (!/^[\da-f]{6}$/iu.test(value)) return hex;
	const channel = (offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
	return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`;
}

function endpoint(value: RenderLink["source"]): RenderNode | null {
	return value && typeof value === "object" ? value : null;
}

function graphLabel(title: string): string {
	const characters = [...title];
	return characters.length > 38 ? `${characters.slice(0, 37).join("")}…` : title;
}

function entryId(graph: WikiGraph): string | null {
	return graph.nodes.find((node) => /quickstart/iu.test(node.id))?.id
		?? graph.nodes.find((node) => /(^|\/)(index|overview|home)$/iu.test(node.id))?.id
		?? graph.nodes[0]?.id
		?? null;
}

function fitCompactGraph(instance: GraphInstance, container: HTMLElement): void {
	const nodes = instance.graphData().nodes;
	const maxX = Math.max(1, ...nodes.map((node) => Math.abs(node.fx ?? node.x ?? 0)));
	const maxY = Math.max(1, ...nodes.map((node) => Math.abs(node.fy ?? node.y ?? 0)));
	const scale = Math.max(0.45, Math.min(1.5,
		(container.clientWidth - 320) / (maxX * 2),
		(container.clientHeight - 42) / (maxY * 2),
	));
	instance.centerAt(0, 0, 0).zoom(scale, 0);
}

function fitGraph(instance: GraphInstance, maxZoom = Number.POSITIVE_INFINITY): void {
	instance.zoomToFit(280, 48);
	if (Number.isFinite(maxZoom)) window.setTimeout(() => instance.zoom(Math.min(instance.zoom(), maxZoom), 180), 420);
}

export const WikiGraphView = forwardRef<WikiGraphViewHandle, WikiGraphViewProps>(function WikiGraphView({
	cacheKey = "wiki",
	graph,
	selectedId,
	theme,
	onSelect,
	onClear,
	fitToView = false,
	colorMode = "type",
	nodeScale = 1,
	spacing = 1,
	focusIds = new Set(),
}, ref) {
	const containerRef = useRef<HTMLDivElement>(null);
	const instanceRef = useRef<GraphInstance | null>(null);
	const nodesRef = useRef(new Map<string, RenderNode>());
	const selectedRef = useRef(selectedId);
	const hoveredRef = useRef<string | null>(null);
	const selectRef = useRef(onSelect);
	const clearRef = useRef(onClear);
	const highlightedNodesRef = useRef(new Set<RenderNode>());
	const highlightedLinksRef = useRef(new Set<RenderLink>());
	const topologyRef = useRef("");
	const pendingInitialFitRef = useRef(false);
	const [ready, setReady] = useState(false);

	selectedRef.current = selectedId;
	selectRef.current = onSelect;
	clearRef.current = onClear;

	useImperativeHandle(ref, () => ({
		fit: () => { if (instanceRef.current) fitGraph(instanceRef.current); },
		zoomIn: () => {
			const instance = instanceRef.current;
			if (instance) instance.zoom(instance.zoom() * 1.35, 180);
		},
		zoomOut: () => {
			const instance = instanceRef.current;
			if (instance) instance.zoom(instance.zoom() / 1.35, 180);
		},
	}), []);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let disposed = false;
		let observer: ResizeObserver | null = null;

		void import("force-graph").then(({ default: ForceGraphConstructor }) => {
			if (disposed) return;
			const style = () => getComputedStyle(container);
			const css = (name: string, fallback: string) => style().getPropertyValue(name).trim() || fallback;
			const highlightedNodes = highlightedNodesRef.current;
			const highlightedLinks = highlightedLinksRef.current;
			const neighborsOf = (node: RenderNode | null) => {
				highlightedNodes.clear();
				highlightedLinks.clear();
				if (!node || !instanceRef.current) return;
				highlightedNodes.add(node);
				for (const link of instanceRef.current.graphData().links) {
					const source = endpoint(link.source);
					const target = endpoint(link.target);
					if (source !== node && target !== node) continue;
					highlightedLinks.add(link);
					if (source) highlightedNodes.add(source);
					if (target) highlightedNodes.add(target);
				}
			};

			const instance = new ForceGraphConstructor<RenderNode, RenderLink>(container)
				.backgroundColor(css("--wiki-graph-bg", "#050a16"))
				.nodeRelSize(4)
				.nodeCanvasObjectMode(() => "replace")
				.nodeCanvasObject((node, context, scale) => {
					if (node.x === undefined || node.y === undefined) return;
					const selected = node.id === selectedRef.current;
					const highlighted = highlightedNodes.has(node);
					const glowRadius = node.r * (selected ? 3.4 : highlighted ? 2.8 : 2.2);
					const glow = context.createRadialGradient(node.x, node.y, node.r * 0.5, node.x, node.y, glowRadius);
					glow.addColorStop(0, hexAlpha(node.color, selected ? 0.5 : highlighted ? 0.38 : 0.22));
					glow.addColorStop(1, hexAlpha(node.color, 0));
					context.fillStyle = glow;
					context.beginPath();
					context.arc(node.x, node.y, glowRadius, 0, 2 * Math.PI);
					context.fill();
					context.beginPath();
					context.arc(node.x, node.y, node.r, 0, 2 * Math.PI);
					context.fillStyle = selected ? css("--wiki-selected-node", "#FFFFFF") : node.color;
					context.fill();
					if (selected || highlighted) {
						context.lineWidth = 1.6 / scale;
						context.strokeStyle = hexAlpha(css("--wiki-selected-stroke", "#FFFFFF"), 0.92);
						context.stroke();
					}

				})
				.onRenderFramePost((context, scale) => {
					const fontSize = Math.max(10 / scale, 3.2);
					const padding = 6 / scale;
					const topLeft = instance.screen2GraphCoords(6, 6);
					const bottomRight = instance.screen2GraphCoords(container.clientWidth - 6, container.clientHeight - 6);
					const canvasBounds = container.getBoundingClientRect();
					const obstacles = Array.from(container.parentElement?.children ?? [])
						.filter((element) => element !== container)
						.map((element) => element.getBoundingClientRect())
						.filter((rect) => rect.width > 0 && rect.height > 0)
						.map((rect) => {
							const start = instance.screen2GraphCoords(rect.left - canvasBounds.left, rect.top - canvasBounds.top);
							const end = instance.screen2GraphCoords(rect.right - canvasBounds.left, rect.bottom - canvasBounds.top);
							return { left: start.x, top: start.y, right: end.x, bottom: end.y };
						});
					const maxWidth = Math.min(280 / scale, bottomRight.x - topLeft.x);
					if (maxWidth <= 0) return;
					context.font = `600 ${fontSize}px ${style().fontFamily || "sans-serif"}`;
					const labels = instance.graphData().nodes.flatMap((node) => {
						if (node.x === undefined || node.y === undefined) return [];
						const selected = node.id === selectedRef.current;
						const hovered = node.id === hoveredRef.current;
						const highlighted = highlightedNodes.has(node);
						if (!(scale > 1.35 || selected || hovered || highlighted || node.anchor || (scale > 0.72 && node.linkCount >= 12))) return [];
						const lines = [""];
						for (const character of selected || hovered ? node.title : graphLabel(node.title)) {
							const last = lines.length - 1;
							if (lines[last] && context.measureText(lines[last] + character).width > maxWidth) lines.push(character);
							else lines[last] += character;
						}
						return [{
							id: node.id, x: node.x, y: node.y, radius: node.r,
							width: Math.max(...lines.map((line) => context.measureText(line).width)),
							height: lines.length * fontSize * 1.3, lines, selected,
							priority: hovered ? 5 : selected ? 4 : node.anchor ? 3 : highlighted ? 2 : 1,
							importance: node.linkCount,
						}];
					});
					context.textAlign = "left";
					context.textBaseline = "top";
					context.lineWidth = 3.5 / scale;
					context.strokeStyle = hexAlpha(css("--wiki-graph-bg", "#050a16"), 0.95);
					for (const label of placeGraphLabels(labels, { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y }, padding, obstacles)) {
						context.fillStyle = label.selected ? css("--wiki-selected-label", "#FFFFFF") : css("--wiki-node-label", "#8CA3BD");
						label.lines.forEach((line, index) => {
							const y = label.y + index * fontSize * 1.3;
							context.strokeText(line, label.x, y);
							context.fillText(line, label.x, y);
						});
					}
				})
				.nodePointerAreaPaint((node, color, context) => {
					context.fillStyle = color;
					context.beginPath();
					context.arc(node.x ?? 0, node.y ?? 0, node.r + 3, 0, 2 * Math.PI);
					context.fill();
				})
				.linkColor((link) => highlightedLinks.has(link) ? css("--wiki-blue", "#7FC8FF") : hexAlpha(css("--wiki-edge", "#1A2740"), 0.7))
				.linkWidth((link) => highlightedLinks.has(link) ? 2 : Math.min(2.4, 0.45 + Number(link.weight ?? 1) / 12))
				.linkCurvature(0.12)
				.linkLabel((link) => edgeRelevanceLabel({ weight: Number(link.weight ?? 1), signals: link.signals }))
				.linkDirectionalParticles((link) => highlightedLinks.has(link) ? 4 : 2)
				.linkDirectionalParticleWidth((link) => highlightedLinks.has(link) ? 2.6 : 1.7)
				.linkDirectionalParticleSpeed(0.006)
				.linkDirectionalParticleColor(() => css("--wiki-blue", "#7FC8FF"))
				.onEngineStop(() => {
					for (const node of instance.graphData().nodes) {
						if (Number.isFinite(node.x) && Number.isFinite(node.y)) positionCache.set(`${cacheKey}\0${node.id}`, { x: node.x!, y: node.y! });
					}
					if (fitToView && instanceRef.current && containerRef.current) fitCompactGraph(instanceRef.current, containerRef.current);
					else if (pendingInitialFitRef.current && instanceRef.current) {
						pendingInitialFitRef.current = false;
						fitGraph(instanceRef.current, instanceRef.current.graphData().nodes.length <= 4 ? 1.5 : Number.POSITIVE_INFINITY);
					}
				})
				.onNodeClick((node) => selectRef.current(node.id))
				.onNodeHover((node) => {
					hoveredRef.current = node?.id ?? null;
					container.style.cursor = node ? "pointer" : "";
					if (!selectedRef.current) neighborsOf(node);
				})
				.onBackgroundClick(() => clearRef.current());

			instanceRef.current = instance;
			const charge = instance.d3Force("charge") as { strength?: (value: number) => void } | undefined;
			charge?.strength?.(-140 * spacing);
			const fit = () => {
				instance.width(container.clientWidth).height(container.clientHeight);
				if (instance.graphData().nodes.length === 0) return;
				if (fitToView) fitCompactGraph(instance, container);
				else fitGraph(instance);
			};
			observer = new ResizeObserver(fit);
			observer.observe(container);
			fit();
			setReady(true);
		});

		return () => {
			disposed = true;
			observer?.disconnect();
			for (const node of instanceRef.current?.graphData().nodes ?? []) {
				if (Number.isFinite(node.x) && Number.isFinite(node.y)) positionCache.set(`${cacheKey}\0${node.id}`, { x: node.x!, y: node.y! });
			}
			instanceRef.current?._destructor();
			instanceRef.current = null;
			nodesRef.current.clear();
			topologyRef.current = "";
			setReady(false);
		};
	}, [cacheKey, fitToView]);

	useEffect(() => {
		const instance = instanceRef.current;
		if (!ready || !instance) return;
		const anchorId = entryId(graph);
		const colors = colorsForWikiTypes(graph.types);
		const maxLinks = Math.max(1, ...graph.nodes.map((node) => node.linkCount));
		const activeIds = new Set(graph.nodes.map((node) => node.id));
		for (const id of nodesRef.current.keys()) {
			if (!activeIds.has(id)) nodesRef.current.delete(id);
		}
		const nodes = graph.nodes.map((node: WikiGraphNode, index) => {
			const cached = positionCache.get(`${cacheKey}\0${node.id}`);
			const existing = nodesRef.current.get(node.id) ?? {
				id: node.id,
				title: node.title,
				type: node.type,
				description: node.description,
				color: colors[node.type] ?? "#7FC8FF",
				anchor: false,
				r: 4,
				community: 0,
				linkCount: 0,
				x: cached?.x,
				y: cached?.y,
			};
			existing.title = node.title;
			existing.type = node.type;
			existing.description = node.description;
			existing.color = colorMode === "community"
				? WIKI_GRAPH_PALETTE[node.community % WIKI_GRAPH_PALETTE.length]
				: colors[node.type] ?? "#7FC8FF";
			existing.anchor = node.id === anchorId;
			existing.community = node.community;
			existing.linkCount = node.linkCount;
			existing.r = (4 + Math.sqrt(node.linkCount / maxLinks) * 8 + (existing.anchor ? 2 : 0)) * nodeScale;
			if (fitToView) {
				const angle = (index / Math.max(graph.nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
				const width = containerRef.current?.clientWidth ?? 720;
				const height = containerRef.current?.clientHeight ?? 176;
				const radiusX = Math.min(width * 0.4, Math.max(140, graph.nodes.length * 28));
				const radiusY = Math.min(height * 0.3, Math.max(44, graph.nodes.length * 4));
				existing.fx = Math.cos(angle) * radiusX;
				existing.fy = Math.sin(angle) * radiusY;
			} else {
				existing.fx = undefined;
				existing.fy = undefined;
			}
			nodesRef.current.set(node.id, existing);
			return existing;
		});
		const links = graph.edges.map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight, signals: edge.signals })) as RenderLink[];
		const topology = `${nodes.map((node) => node.id).sort().join("|")}::${graph.edges.map((edge) => `${edge.source}>${edge.target}`).sort().join("|")}`;
		if (topology !== topologyRef.current) {
			const firstLoad = !topologyRef.current;
			pendingInitialFitRef.current = firstLoad && !fitToView;
			instance.graphData({ nodes, links });
			if (fitToView && containerRef.current) fitCompactGraph(instance, containerRef.current);
			else if (firstLoad) {
				instance.zoom((4 / Math.cbrt(nodes.length || 1)) * 1.35);
				window.setTimeout(() => {
					if (instanceRef.current === instance) fitGraph(instance, nodes.length <= 4 ? 1.5 : Number.POSITIVE_INFINITY);
				}, 900);
			}
			topologyRef.current = topology;
		} else {
			instance.d3ReheatSimulation();
		}
	}, [cacheKey, colorMode, fitToView, graph, nodeScale, ready]);

	useEffect(() => {
		const instance = instanceRef.current;
		if (!instance) return;
		const charge = instance.d3Force("charge") as { strength?: (value: number) => void; distanceMax?: (value: number) => void } | undefined;
		const link = instance.d3Force("link") as { distance?: (value: number) => void } | undefined;
		charge?.strength?.(-140 * spacing);
		// Cap repulsion range so isolated nodes stay near the connected core instead of flying off and shrinking the fit.
		charge?.distanceMax?.(220 * spacing);
		link?.distance?.(48 * spacing);
		instance.d3ReheatSimulation();
	}, [ready, spacing]);

	useEffect(() => {
		const instance = instanceRef.current;
		const container = containerRef.current;
		if (!instance || !container) return;
		const background = getComputedStyle(container).getPropertyValue("--wiki-graph-bg").trim() || "#050a16";
		instance.backgroundColor(background).d3ReheatSimulation();
	}, [ready, theme]);

	useEffect(() => {
		const instance = instanceRef.current;
		if (!instance) return;
		const highlightedNodes = highlightedNodesRef.current;
		const highlightedLinks = highlightedLinksRef.current;
		highlightedNodes.clear();
		highlightedLinks.clear();
		const selected = selectedId ? nodesRef.current.get(selectedId) : undefined;
		if (selected) {
			highlightedNodes.add(selected);
			for (const link of instance.graphData().links) {
				const source = endpoint(link.source);
				const target = endpoint(link.target);
				if (source !== selected && target !== selected) continue;
				highlightedLinks.add(link);
				if (source) highlightedNodes.add(source);
				if (target) highlightedNodes.add(target);
			}
		}
		for (const id of focusIds) {
			const node = nodesRef.current.get(id);
			if (node) highlightedNodes.add(node);
		}
		if (focusIds.size > 1) {
			for (const link of instance.graphData().links) {
				const source = endpoint(link.source);
				const target = endpoint(link.target);
				if (source && target && focusIds.has(source.id) && focusIds.has(target.id)) highlightedLinks.add(link);
			}
		}
		instance.d3ReheatSimulation();
	}, [focusIds, graph, selectedId]);

	return <div ref={containerRef} className="wiki-graph-canvas" data-testid="wiki-graph" role="img" aria-label={uiText("wiki.graphview.wikiPageRelationshipGraph")} />;
});
