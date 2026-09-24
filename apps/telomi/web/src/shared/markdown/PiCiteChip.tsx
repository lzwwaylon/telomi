import { ApiError, apiClient } from "@/shared/lib/api-client";
import * as React from "react";
import { Check, ChevronLeft, ChevronRight, ExternalLink, Unlink } from "lucide-react";
import { DocumentIcon as FileText, CopyIcon as Copy } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import {
	InlineCitation,
	InlineCitationCard,
	InlineCitationCardBody,
	InlineCitationCardTrigger,
	InlineCitationCarousel,
	InlineCitationCarouselContent,
	InlineCitationCarouselHeader,
	InlineCitationCarouselIndex,
	InlineCitationCarouselItem,
	InlineCitationCarouselNext,
	InlineCitationCarouselPrev,
} from "@/shared/markdown/InlineCitation";
import type { CiteData } from "@/shared/markdown/markdown-cite";
import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { MarkdownLineLocator } from "@/shared/markdown/MarkdownLineLocator";
import { sourceAssetHttpUrl } from "@/shared/markdown/source-asset";
import { EvidenceImageLightbox, type EvidenceImagePreview } from "@/shared/markdown/EvidenceImageLightbox";
import { uiText } from "@/app/ui-text";

function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown|mdx)$/i.test(path);
}

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const i = trimmed.lastIndexOf("/");
	return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function safeHostname(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url.length > 28 ? `${url.slice(0, 28)}…` : url;
	}
}

function lineRangeLabel(data: CiteData): string | null {
	if (data.kind !== "file") return null;
	if (data.lineStart == null) return null;
	if (data.lineEnd != null && data.lineEnd !== data.lineStart) {
		return `L${data.lineStart}–L${data.lineEnd}`;
	}
	return `L${data.lineStart}`;
}

function fullUrlOf(data: CiteData): string {
	if (data.kind === "file") return data.target;
	if (data.kind === "ref") return "";
	return data.fragment ? `${data.target}#${data.fragment}` : data.target;
}

/**
 * Compute the chip's textual label from the per-source dedupe indices that
 * MarkdownView assigned in document order.
 *
 * - 0 known indices  → `"?"` (chip is mounted out of context)
 * - 1 source         → `"3"`
 * - n consecutive    → `"3-5"` (range — most common case for grouped cites)
 * - n non-consecutive → `"3,5,7"` up to 4; longer collapsed to `"3,5,…,12"`
 */
function buildChipLabel(indices: (number | undefined)[]): string {
	const known = indices.filter((n): n is number => typeof n === "number");
	if (known.length === 0) return "?";
	if (known.length === 1) return String(known[0]);
	const sorted = Array.from(new Set(known)).sort((a, b) => a - b);
	if (sorted.length === 1) return String(sorted[0]);
	const isConsec = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
	if (isConsec) return `${sorted[0]}-${sorted[sorted.length - 1]}`;
	if (sorted.length <= 4) return sorted.join(",");
	return `${sorted[0]},${sorted[1]},…,${sorted[sorted.length - 1]}`;
}

export interface PiCiteChipProps {
	/**
	 * 一组同位连续引用。单源时 length=1;Markdown 写出连续的
	 * `[[1]](url)[[2]](url)` 时会合并到同一个 chip。
	 * popover 内通过 InlineCitationCarousel 翻页查看每个 source。
	 */
	dataList: CiteData[];
	/**
	 * 每个 dataList 元素对应的同源去重序号(在同一 MarkdownView 内自 1 起)。
	 * 缺省时回落到 `?`,这种情况只发生在 chip 被独立挂载、没有外层序号 context 的场景。
	 */
	indices: (number | undefined)[];
	/** 当前 goal id —— file 预览端点 `/api/goals/:goalId/workspace/file-slice` 必需。 */
	goalId?: string | null;
	/** Artifact path used to resolve report URL citations back to Research Evidence. */
	artifactName?: string;
	onUrlClick?: (url: string) => void;
	onFileClick?: (path: string, line?: number) => void;
	/** 引用所在 message id —— chat 内 Source 预览据此定位消息;独立挂载场景可缺省。 */
	messageId?: string | null;
}

interface FileSlice {
	lang: string;
	sliceStart: number;
	sliceEnd: number;
	totalLines: number;
	truncated: boolean;
	lines: { n: number; text: string }[];
}

interface CitationSourcePreviewData {
	title: string;
	url: string;
	sourceId: string;
	clues: Array<{
		page?: { ref: string; path: string; title: string; type: string; content: string };
		cue: string;
		note: string;
		excerpts: Array<{ path: string; startLine: number; endLine: number; text: string }>;
		assets: Array<{ sourceId: string; path: string; alt: string }>;
	}>;
}

type SourcePreviewState =
	| { status: "idle" | "loading" | "missing" }
	| { status: "ok"; data: CitationSourcePreviewData }
	| { status: "error" };

const SOURCE_PREVIEW_CACHE = new Map<string, CitationSourcePreviewData | null>();

function sourcePreviewKey(goalId: string, scope: string, url: string, number?: number): string {
	return `${goalId}\u0001${scope}\u0001${url}\u0001${number ?? ""}`;
}

function CitationSourcePreview({
	goalId,
	artifactName,
	messageId,
	data,
	visible,
	onOpenImage,
}: {
	goalId: string | null;
	artifactName?: string;
	messageId?: string | null;
	data: CiteData;
	visible: boolean;
	onOpenImage: (image: EvidenceImagePreview) => void;
}) {
	const [state, setState] = React.useState<SourcePreviewState>({ status: "idle" });
	const [clueIndex, setClueIndex] = React.useState(0);
	const clueScrollRef = React.useRef<HTMLDivElement>(null);
	const url = data.kind === "url" ? fullUrlOf(data) : "";
	const citationNumber = data.index;
	React.useEffect(() => setClueIndex(0), [url]);
	React.useLayoutEffect(() => {
		clueScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
	}, [clueIndex]);

	React.useEffect(() => {
		const scope = artifactName ? `artifact:${artifactName}` : messageId ? `message:${messageId}` : "";
		if (!visible || !goalId || !scope || !url) return;
		const key = sourcePreviewKey(goalId, scope, url, citationNumber);
		if (SOURCE_PREVIEW_CACHE.has(key)) {
			const cached = SOURCE_PREVIEW_CACHE.get(key);
			setState(cached ? { status: "ok", data: cached } : { status: "missing" });
			return;
		}
		setState({ status: "loading" });
		const controller = new AbortController();
		const params = new URLSearchParams({ url });
		if (artifactName) params.set("name", artifactName);
		else if (messageId) params.set("messageId", messageId);
		if (citationNumber !== undefined) params.set("number", String(citationNumber));
		void apiClient.get<CitationSourcePreviewData>(`/api/goals/${encodeURIComponent(goalId)}/artifacts/citations/preview?${params}`, {
			signal: controller.signal,
		})
			.catch((error: unknown) => {
				if (error instanceof ApiError && error.status === 404) return null;
				throw error;
			})
			.then((preview) => {
				SOURCE_PREVIEW_CACHE.set(key, preview);
				setState(preview ? { status: "ok", data: preview } : { status: "missing" });
			})
			.catch(() => {
				if (!controller.signal.aborted) setState({ status: "error" });
			});
		return () => controller.abort();
	}, [artifactName, citationNumber, goalId, messageId, url, visible]);

	if (!goalId || (!artifactName && !messageId) || data.kind !== "url") return null;
	if (state.status === "loading") {
		return <div className="rounded-[6px] border border-[var(--line-soft)] px-2.5 py-2 text-[11px] text-[var(--ink-faint)]">{uiText("markdown.picitechip.loadingSourceContent")}</div>;
	}
	if (state.status === "error") {
		return <div className="text-[11px] text-[var(--ink-faint)]">{uiText("markdown.picitechip.sourceContentIsTemporarilyUnavailable")}</div>;
	}
	if (state.status !== "ok") return null;

	const preview = state.data;
	const clue = preview.clues[clueIndex] ?? preview.clues[0];
	if (!clue) return null;
	return (
		<div className="overflow-hidden rounded-[7px] border border-[var(--line-soft)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)]">
			<div className="flex items-center gap-2 border-b border-[var(--line-soft)] px-2.5 py-2">
				<div className="min-w-0 flex-1">
					<div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--ink-faint)]">
						{uiText("markdown.picitechip.clueCurrentTotal", { current: clueIndex + 1, total: preview.clues.length })}
					</div>
					<div className="break-words text-[12.5px] font-medium text-[var(--ink)]">{clue.cue}</div>
				</div>
				{preview.clues.length > 1 ? (
					<div className="flex shrink-0 items-center gap-0.5">
						<button type="button" aria-label={uiText("markdown.picitechip.previousClue")} onClick={() => setClueIndex((index) => (index - 1 + preview.clues.length) % preview.clues.length)} className="rounded-[5px] p-1 text-[var(--ink-faint)] hover:bg-[var(--paper)] hover:text-[var(--ink)]">
							<ChevronLeft className="size-3.5" aria-hidden />
						</button>
						<button type="button" aria-label={uiText("markdown.picitechip.nextClue")} onClick={() => setClueIndex((index) => (index + 1) % preview.clues.length)} className="rounded-[5px] p-1 text-[var(--ink-faint)] hover:bg-[var(--paper)] hover:text-[var(--ink)]">
							<ChevronRight className="size-3.5" aria-hidden />
						</button>
					</div>
				) : null}
			</div>
			<div
				ref={clueScrollRef}
				data-testid="citation-clue-scroll"
				className="space-y-4 overflow-y-auto p-3"
				style={{ maxHeight: "min(360px, calc(var(--radix-popover-content-available-height) - 160px))" }}
			>
				{clue.page ? (
					<div data-testid="wiki-citation-page" className="space-y-2 border-b border-[var(--line-soft)] pb-3">
						<div>
							<div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--ink-faint)]">
								Wiki {clue.page.type} · {clue.page.ref}
							</div>
							<div className="break-words text-[13px] font-semibold text-[var(--ink)]">{clue.page.title}</div>
							<div className="break-all font-mono text-[10px] text-[var(--ink-faint)]">{clue.page.path}</div>
						</div>
						<MarkdownView
							text={clue.page.content}
							goalId={goalId}
							className="[&_p]:text-[12px] [&_p]:leading-relaxed [&_li]:text-[12px] [&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[13px]"
						/>
					</div>
				) : null}
				{clue.note ? (
					<div className="text-[12.5px] leading-relaxed text-[var(--ink-mut)]">
						<MarkdownView text={clue.note} goalId={goalId} className="[&_p]:my-0 [&_p]:text-[12.5px] [&_p]:leading-relaxed" />
					</div>
				) : null}
				{clue.assets.length > 0 ? (
					<div className="space-y-3">
					{clue.assets.map((asset) => {
						const src = sourceAssetHttpUrl(`source-asset:${asset.sourceId}/${asset.path}`, goalId);
						return src ? (
							<button
								type="button"
								key={`${asset.sourceId}:${asset.path}`}
								data-testid="citation-image-open"
								aria-label={uiText("markdown.picitechip.enlargeImageAlt", { alt: asset.alt })}
								onClick={(event) => {
									event.preventDefault();
									event.stopPropagation();
									onOpenImage({ src, alt: asset.alt });
								}}
								className="block w-full cursor-zoom-in overflow-hidden rounded-[6px] border border-[var(--line-soft)] bg-[var(--paper)]"
							>
								<img src={src} alt={asset.alt} loading="lazy" className="h-auto w-full object-contain" />
							</button>
						) : null;
					})}
						</div>
				) : null}
				{clue.excerpts.map((excerpt) => (
					<div key={`${excerpt.path}:${excerpt.startLine}:${excerpt.endLine}`} className="border-t border-[var(--line-soft)] pt-3">
					<div className="mb-2 flex items-center justify-between gap-2 text-[10px] text-[var(--ink-faint)]">
						<span className="min-w-0 break-all font-mono">{excerpt.path}</span>
						<span className="shrink-0 font-mono">L{excerpt.startLine}-{excerpt.endLine}</span>
					</div>
					{isMarkdownPath(excerpt.path) ? (
						<MarkdownView text={excerpt.text} goalId={goalId} className="[&_p]:text-[12px] [&_p]:leading-relaxed [&_li]:text-[12px] [&_li]:leading-relaxed [&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[13px]" />
					) : (
						<pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--ink)]">{excerpt.text}</pre>
					)}
					</div>
				))}
			</div>
		</div>
	);
}

type FileSliceState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ok"; data: FileSlice }
	| { status: "error"; error: string };

// 模块级缓存,跨 chip 共享,避免每次 hover 都重新拉取。key = `${goalId}${path}${start}${end}`。
const SLICE_CACHE = new Map<string, FileSlice>();

function sliceCacheKey(goalId: string, data: CiteData): string {
	return `${goalId}${data.target}${data.lineStart ?? ""}${data.lineEnd ?? ""}`;
}

async function fetchFileSlice(
	goalId: string,
	data: CiteData,
	signal: AbortSignal,
): Promise<FileSlice> {
	const key = sliceCacheKey(goalId, data);
	const cached = SLICE_CACHE.get(key);
	if (cached) return cached;
	const params = new URLSearchParams();
	params.set("path", data.target);
	if (data.lineStart != null) params.set("start", String(data.lineStart));
	if (data.lineEnd != null) params.set("end", String(data.lineEnd));
	const body = await apiClient.get<FileSlice>(
		`/api/goals/${encodeURIComponent(goalId)}/workspace/file-slice?${params.toString()}`,
		{ signal, errorMessage: (status, body) => body || `HTTP ${status}` },
	);
	SLICE_CACHE.set(key, body);
	return body;
}

/** Linkify URLs inside a plain string — autolinks become anchors that respect onUrlClick. */
function renderInlineLinks(
	text: string,
	onUrlClick: ((url: string) => void) | undefined,
): React.ReactNode {
	if (!text) return null;
	// 简单 URL 匹配:http/https + 非空白。够用,不上 markdown-it。
	const re = /(https?:\/\/[^\s)>\]'"]+)/g;
	const parts: React.ReactNode[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = re.exec(text)) !== null) {
		const start = m.index;
		const url = m[0];
		if (start > last) parts.push(text.slice(last, start));
		parts.push(
			<a
				key={`l-${i++}`}
				href={url}
				target="_blank"
				rel="noreferrer"
				onClick={(e) => {
					if (onUrlClick) {
						e.preventDefault();
						e.stopPropagation();
						onUrlClick(url);
					}
				}}
				className="text-[var(--accent)] hover:underline break-all"
			>
				{url}
			</a>,
		);
		last = start + url.length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return parts;
}

/**
 * 文件行内容预览 —— hover 打开 popover 后 lazy-fetch,缓存复用。
 * 行内文本里的 https?://… URL 会被 `renderInlineLinks` 转成可点 anchor。
 */
function FileSlicePreview({
	goalId,
	data,
	visible,
	onUrlClick,
}: {
	goalId: string | null;
	data: CiteData;
	visible: boolean;
	onUrlClick?: (url: string) => void;
}) {
	const [state, setState] = React.useState<FileSliceState>({ status: "idle" });

	React.useEffect(() => {
		if (!visible) return;
		if (!goalId) return;
		if (data.kind !== "file") return;
		if (data.lineStart == null) return;
		// Already in cache → render synchronously without flashing 加载中.
		const cached = SLICE_CACHE.get(sliceCacheKey(goalId, data));
		if (cached) {
			setState({ status: "ok", data: cached });
			return;
		}
		setState({ status: "loading" });
		const ctrl = new AbortController();
		fetchFileSlice(goalId, data, ctrl.signal)
			.then((body) => setState({ status: "ok", data: body }))
			.catch((err: unknown) => {
				if (ctrl.signal.aborted) return;
				const message = err instanceof Error ? err.message : String(err);
				setState({ status: "error", error: message });
			});
		return () => ctrl.abort();
	}, [goalId, visible, data]);

	if (!goalId) return null;
	if (data.kind !== "file") return null;
	if (data.lineStart == null) return null;

	if (state.status === "idle" || state.status === "loading") {
		return (
			<div className="mt-2 rounded-[6px] border border-[var(--line-soft)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2 py-1.5 text-[11px] text-[var(--ink-faint)]">
				{uiText("common.loading")}
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="mt-2 rounded-[6px] border border-[color-mix(in_oklch,var(--destructive)_30%,var(--line-soft))] bg-[color-mix(in_oklch,var(--destructive)_4%,transparent)] px-2 py-1.5 text-[11px] text-[var(--destructive)] break-all">
				{uiText("markdown.picitechip.previewFailed")} {state.error}
			</div>
		);
	}

	const { lines, sliceStart, sliceEnd, totalLines, truncated } = state.data;
	const startLine = data.lineStart;
	const endLine = data.lineEnd ?? data.lineStart;
	const widestLine = sliceEnd;
	const gutterWidth = String(widestLine).length;

	const header = (
		<div className="text-[10px] text-[var(--ink-faint)] px-2 py-1 border-b border-[var(--line-soft)] flex items-center justify-between gap-2">
			<span className="font-mono truncate">
				L{sliceStart}–L{sliceEnd} / {totalLines}
			</span>
			{truncated && <span className="shrink-0">{uiText("markdown.picitechip.truncated")}</span>}
		</div>
	);

	// .md / .mdx → 直接渲染成 markdown,而不是源码 gutter 视图。
	// MarkdownView 给每个块挂了 `data-md-block-path="line:N-M"`,但 N/M 是「这次喂进去的字符串」
	// 的相对行号 —— 所以要把 highlightLine 从绝对行号换算成「slice 内相对行号」。
	if (isMarkdownPath(data.target)) {
		const text = lines.map((l) => l.text).join("\n");
		const relativeHighlight = startLine - sliceStart + 1;
		return (
			<div className="mt-2 rounded-[6px] border border-[var(--line-soft)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] overflow-hidden">
				{header}
				<div className="px-3 py-2 max-h-[240px] overflow-y-auto text-[12.5px] text-[var(--ink)]">
					<MarkdownLineLocator highlightLine={relativeHighlight} scroll={false}>
						<MarkdownView text={text} />
					</MarkdownLineLocator>
				</div>
			</div>
		);
	}

	return (
		<div className="mt-2 rounded-[6px] border border-[var(--line-soft)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] overflow-hidden">
			{header}
			<pre className="font-mono text-[11.5px] leading-[1.5] m-0 px-2 py-1.5 overflow-x-auto max-h-[180px]">
				<code>
					{lines.map(({ n, text }) => {
						const isHit = n >= startLine && n <= endLine;
						return (
							<div
								key={n}
								className={cn(
									"flex gap-2",
									isHit
										? "bg-[color-mix(in_oklch,var(--accent)_14%,transparent)]"
										: undefined,
								)}
							>
								<span
									className={cn(
										"select-none text-right tabular-nums shrink-0",
										isHit ? "text-[var(--accent)]" : "text-[var(--ink-faint)]",
									)}
									style={{ width: `${gutterWidth}ch` }}
								>
									{n}
								</span>
								<span className="text-[var(--ink)] whitespace-pre-wrap break-all">
									{text ? renderInlineLinks(text, onUrlClick) : " "}
								</span>
							</div>
						);
					})}
				</code>
			</pre>
		</div>
	);
}

/**
 * Single-source 复制条 —— popover 内每个 carousel page 下方一条,
 * 提供「复制路径 / URL」。
 */
function CiteCopyBar({ data }: { data: CiteData }) {
	const [copied, setCopied] = React.useState(false);

	const copyTarget = React.useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const text = data.kind === "file"
				? (() => {
						const range = lineRangeLabel(data);
						return range ? `${data.target}:${range}` : data.target;
					})()
				: fullUrlOf(data);
			if (typeof navigator !== "undefined" && navigator.clipboard) {
				navigator.clipboard.writeText(text).catch(() => undefined);
			}
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		},
		[data],
	);

	return (
		<div className="mt-3 border-t border-[var(--line-soft)] pt-2.5 flex items-center justify-end">
			<button
				type="button"
				onClick={copyTarget}
				className={cn(
					"inline-flex items-center gap-1 h-6 px-2 rounded-[6px] text-[11px] leading-none",
					"transition-colors select-none cursor-pointer text-[var(--ink-mut)] hover:text-[var(--ink)] hover:bg-[var(--paper-2)]",
				)}
				title={uiText("markdown.picitechip.copyPathOrUrl")}
			>
				{copied ? (
					<>
						<Check className="size-3" aria-hidden />
						<span>{uiText("common.copied")}</span>
					</>
				) : (
					<>
						<Copy className="size-3" aria-hidden />
						<span>{uiText("common.copy")}</span>
					</>
				)}
			</button>
		</div>
	);
}

/**
 * Render one indexed Markdown citation (or a consecutive group) as a
 * Perplexity-style numeric badge. Hover 弹出 popover,内部用 carousel 翻页;
 * 单源时 carousel 自然只有 1 页(Prev/Next 自动 disabled);多源时 chip 显示
 * 「序号区间或列表」,popover 内通过翻页查看每个 source。
 *
 * Chip 自身**不**接收点击 —— 跳转动作只发生在 popover 内的标题/链接上,这样
 * 用户 hover 看完上下文再决定是否打开,避免误点跳走当前消息。
 */
export function PiCiteChip({
	dataList,
	indices,
	goalId,
	artifactName,
	onUrlClick,
	onFileClick,
	messageId,
}: PiCiteChipProps) {
	const isMulti = dataList.length > 1;
	const [hovered, setHovered] = React.useState(false); // popover trigger hover 触发 lazy-fetch
	const [imagePreview, setImagePreview] = React.useState<EvidenceImagePreview | null>(null);

	// 拦截 chip click —— 不再触发跳转,纯靠 hover 显示 popover。
	const handleChipClick = React.useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
	}, []);

	// trigger hover/focus 进入 → 标记一次,让 FileSlicePreview lazy-fetch。一旦 true 不再回 false:
	// popover 关闭后再次打开命中模块缓存,无重复请求。
	const handleChipPointerEnter = React.useCallback(() => {
		setHovered(true);
	}, []);

	const label = buildChipLabel(indices);

	const handleOpenPath = React.useCallback(
		(data: CiteData) => {
			if (data.kind === "ref") return;
			if (data.kind === "file") {
				onFileClick?.(data.target, data.lineStart);
				return;
			}
			const url = fullUrlOf(data);
			if (onUrlClick) {
				onUrlClick(url);
			} else if (typeof window !== "undefined") {
				window.open(url, "_blank", "noopener,noreferrer");
			}
		},
		[onFileClick, onUrlClick],
	);

	return (
		<>
		<InlineCitation>
			<InlineCitationCard>
				<InlineCitationCardTrigger
					sources={dataList.map((d) => fullUrlOf(d))}
					onClick={handleChipClick}
					onPointerEnter={handleChipPointerEnter}
					onFocus={handleChipPointerEnter}
					className={cn(
						// 上标式数字徽章。单源圆形,多源胶囊形(label 可能是 "2-4" / "2,4")
						// 横向更宽,所以放宽 min-w 并把圆角改成 rounded-md。
						"h-[16px] px-1 ml-0.5",
						isMulti ? "min-w-[20px] rounded-md" : "min-w-[16px] rounded-full",
						"text-[10.5px] font-semibold tabular-nums leading-none",
						"align-super",
					)}
				>
					{label}
				</InlineCitationCardTrigger>
				<InlineCitationCardBody
					side="bottom"
					align="end"
					onEscapeKeyDown={(event) => event.stopPropagation()}
				>
					<InlineCitationCarousel>
						<InlineCitationCarouselHeader>
							<InlineCitationCarouselPrev />
							<InlineCitationCarouselIndex />
							<InlineCitationCarouselNext />
						</InlineCitationCarouselHeader>
						<InlineCitationCarouselContent>
							{dataList.map((data, i) => {
								const isFile = data.kind === "file";
								// Reference without a reachable Source URL: title only, nothing to open.
								const isRef = data.kind === "ref";
								const lineLabel = lineRangeLabel(data);
								const citeLabel = data.label?.trim();
								const sourceTitle = isFile
									? citeLabel || basename(data.target)
									: isRef
										? citeLabel || `#${data.index ?? ""}`
										: citeLabel || safeHostname(data.target);
								const url = fullUrlOf(data);
								const displayPath = isFile
									? lineLabel
										? `${data.target}:${lineLabel}`
										: data.target
									: url;
								const Icon = isFile ? FileText : isRef ? Unlink : ExternalLink;
									return (
									<InlineCitationCarouselItem key={i}>
											<div className="space-y-2.5">
												{/* 标题 / 主入口 —— click 即跳转(file → 右栏,url → 新标签页)。 */}
												<button
													type="button"
													onClick={(e) => {
														e.preventDefault();
														e.stopPropagation();
														handleOpenPath(data);
													}}
													disabled={isRef}
													className={cn(
														"group/cite-title flex w-full items-start gap-2 rounded-[6px] text-left",
														"text-[13px] font-medium leading-snug text-[var(--ink)]",
														isRef ? "cursor-default" : "hover:text-[var(--accent)] cursor-pointer",
													)}
													title={isRef ? undefined : isFile ? uiText("markdown.picitechip.openInSidePanel") : uiText("markdown.picitechip.openInNewTab")}
												>
													<Icon className="mt-0.5 size-3.5 shrink-0 opacity-70 group-hover/cite-title:opacity-100" aria-hidden />
													<span className="min-w-0 flex-1 break-words">{sourceTitle}</span>
												</button>
												{/* 路径或 URL —— url chip 渲染成可点击 anchor;file chip 也走 onFileClick。 */}
												{isRef ? (
													<p className="text-[11px] leading-relaxed text-[var(--ink-faint)]">
														{uiText("markdown.picitechip.sourceLinkUnavailable")}
													</p>
												) : isFile ? (
													<button
														type="button"
														onClick={(e) => {
															e.preventDefault();
															e.stopPropagation();
															handleOpenPath(data);
														}}
														className="block w-full rounded-[5px] text-left break-all text-[var(--ink-faint)] text-[11px] leading-relaxed font-mono hover:text-[var(--accent)] hover:underline cursor-pointer"
														title={displayPath}
													>
														{displayPath}
													</button>
												) : (
												<a
													href={url}
													target="_blank"
													rel="noreferrer"
													onClick={(e) => {
														if (onUrlClick) {
															e.preventDefault();
															e.stopPropagation();
															onUrlClick(url);
														}
													}}
													className="block rounded-[5px] break-all text-[var(--ink-faint)] text-[11px] leading-relaxed font-mono hover:text-[var(--accent)] hover:underline"
													title={url}
												>
													{url}
												</a>
											)}
											{/* fragment 单独渲染成可读文本(url 类型才有);file 类型用行号预览替代。 */}
											{!isFile && data.fragment && (
												<p className="line-clamp-4 break-words text-[var(--ink-mut)] text-[12.5px] leading-relaxed">
													{renderInlineLinks(`#${data.fragment}`, onUrlClick)}
												</p>
											)}
											{/* file 行内容预览 —— hover 打开后 lazy-fetch。 */}
											{isFile && (
												<FileSlicePreview
													goalId={goalId ?? null}
													data={data}
													visible={hovered}
													onUrlClick={onUrlClick}
												/>
											)}
											{!isFile && (
											<CitationSourcePreview
												goalId={goalId ?? null}
												artifactName={artifactName}
												messageId={messageId}
												data={data}
												visible={hovered}
												onOpenImage={setImagePreview}
											/>
											)}
											{data.kind !== "ref" && <CiteCopyBar data={data} />}
										</div>
									</InlineCitationCarouselItem>
								);
							})}
						</InlineCitationCarouselContent>
					</InlineCitationCarousel>
				</InlineCitationCardBody>
			</InlineCitationCard>
		</InlineCitation>
		<EvidenceImageLightbox image={imagePreview} onClose={() => setImagePreview(null)} testId="citation-image-dialog" />
		</>
	);
}
