import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";

export interface Heading {
	level: 1 | 2 | 3;
	text: string;
	id: string;
}

const TOC_FOLLOW_PADDING = 24;
const SCROLLSPY_OFFSET = 96;

function findScrollContainer(root: HTMLElement): HTMLElement | null {
	let scroller: HTMLElement | null = root.parentElement;
	while (scroller && scroller !== document.body) {
		const style = getComputedStyle(scroller);
		if (/(auto|scroll|overlay)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight) {
			return scroller;
		}
		scroller = scroller.parentElement;
	}
	return null;
}

function slugify(s: string): string {
	return (
		s
			.trim()
			.toLowerCase()
			.replace(/[\s　]+/g, "-")
			.replace(/[!-/:-@[-`{-~]/g, "")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "h"
	);
}

export function extractHeadings(md: string): Heading[] {
	const out: Heading[] = [];
	const seen = new Map<string, number>();
	const lines = md.split(/\r?\n/);
	let inFence = false;
	for (const raw of lines) {
		const line = raw.trimEnd();
		if (/^```/.test(line.trim())) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!m) continue;
		const level = m[1].length as 1 | 2 | 3;
		const text = m[2]
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/_([^_]+)_/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.trim();
		const base = slugify(text);
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		const id = n > 1 ? `${base}-${n}` : base;
		out.push({ level, text, id });
	}
	return out;
}

interface MarkdownPaneProps {
	content: string;
	goalId?: string;
	artifactName?: string;
	variant?: "default" | "reader";
	/**
	 * 引用反馈链路归一键左半 —— 透传给 MarkdownView,让 PiCiteChip 的 👍/👎
	 * 反馈条能正确归属。MediaCard 这种非聊天场景把 artifact id 当作 messageId,
	 * jsonl 里就能区分到底是哪个 artifact 上的引用被吐槽。
	 */
	messageId?: string;
}

/**
 * Markdown reading pane — typography upgrade + floating TOC sidebar.
 *
 * Layout: [TOC (sticky, 220px) | content (max 76ch)] in an inner grid.
 * TOC collapses when fewer than 2 headings are extracted.
 *
 * `goalId` is forwarded to MarkdownView so citation chips retain Goal context.
 *
 * Wrapped in `memo` so state changes in parent overlays do not cascade into this
 * pane. Scrollspy state intentionally remains local because it drives the TOC;
 * MarkdownView is memoized separately so active-heading changes do not rebuild
 * the document body.
 */
export const MarkdownPane = memo(function MarkdownPane({
	content,
	goalId,
	artifactName,
	messageId,
	variant = "default",
}: MarkdownPaneProps) {
	const headings = useMemo(() => extractHeadings(content), [content]);
	const showToc = headings.length >= 2;
	const [wide, setWide] = useState(() => typeof window === "undefined" || window.innerWidth >= 1024);
	useEffect(() => {
		const query = window.matchMedia("(min-width: 1024px)");
		const update = () => setWide(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	const useTocColumn = showToc && wide;
	const hasReaderToc = variant === "reader" && useTocColumn;
	const hasDefaultToc = variant === "default" && useTocColumn;
	const contentRef = useRef<HTMLDivElement | null>(null);
	const tocRef = useRef<HTMLDivElement | null>(null);
	const [activeId, setActiveId] = useState<string | null>(null);

	useEffect(() => {
		const root = contentRef.current;
		if (!root || headings.length === 0) return;
		const nodes = root.querySelectorAll<HTMLElement>("h1, h2, h3");
		const len = Math.min(nodes.length, headings.length);
		for (let i = 0; i < len; i++) {
			nodes[i].id = headings[i].id;
		}
	}, [content, headings]);

	useEffect(() => {
		const root = contentRef.current;
		if (!root || headings.length === 0) return;
		const scroller = findScrollContainer(root);
		if (!scroller) {
			setActiveId(headings[0]?.id ?? null);
			return;
		}

		const nodes = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3"));
		let frame: number | null = null;
		const updateActiveHeading = () => {
			frame = null;
			const activationTop = scroller.getBoundingClientRect().top + SCROLLSPY_OFFSET;
			let nextId = nodes[0]?.id ?? headings[0]?.id ?? null;
			for (const node of nodes) {
				if (node.getBoundingClientRect().top > activationTop) break;
				if (node.id) nextId = node.id;
			}
			setActiveId((current) => (current === nextId ? current : nextId));
		};
		const onScroll = () => {
			if (frame === null) frame = requestAnimationFrame(updateActiveHeading);
		};

		updateActiveHeading();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [content, headings]);

	useEffect(() => {
		const toc = tocRef.current;
		if (!toc || !activeId) return;
		const active = toc.querySelector<HTMLElement>('[aria-current="true"]');
		if (!active) return;

		const tocRect = toc.getBoundingClientRect();
		const activeRect = active.getBoundingClientRect();
		const visibleTop = tocRect.top + TOC_FOLLOW_PADDING;
		const visibleBottom = tocRect.bottom - TOC_FOLLOW_PADDING;
		let nextScrollTop = toc.scrollTop;

		if (activeRect.top < visibleTop) {
			nextScrollTop += activeRect.top - visibleTop;
		} else if (activeRect.bottom > visibleBottom) {
			nextScrollTop += activeRect.bottom - visibleBottom;
		}

		if (Math.abs(nextScrollTop - toc.scrollTop) > 0.5) {
			toc.scrollTo({ top: Math.max(0, nextScrollTop), behavior: "auto" });
		}
	}, [activeId]);

	const onJump = useCallback((id: string) => {
		const root = contentRef.current;
		if (!root) return;
		const target = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
		if (!target) return;
		const scroller = findScrollContainer(root);
		if (!scroller) return;
		const targetTop = target.getBoundingClientRect().top;
		const scrollerTop = scroller.getBoundingClientRect().top;
		const next = scroller.scrollTop + (targetTop - scrollerTop) - 16;
		scroller.scrollTo({ top: Math.max(0, next), behavior: "auto" });
		setActiveId(id);
	}, []);

	return (
		<div
			className={cn("mx-auto px-6 py-6 grid gap-8", variant === "reader" && "markdown-pane-reader")}
			style={{
				maxWidth: variant === "reader" ? (useTocColumn ? 1180 : 920) : (useTocColumn ? 1080 : 880),
				gridTemplateColumns: useTocColumn
					? variant === "reader"
						? "180px minmax(0,1fr)"
						: "170px minmax(0,1fr)"
					: "minmax(0,1fr)",
				columnGap: useTocColumn ? (variant === "reader" ? 56 : 52) : undefined,
			}}
		>
			{useTocColumn && (
				/* The grid item must span the full content row. A shrink-wrapped aside
				   leaves its sticky child with no containing-block travel range. */
				<aside className="hidden self-stretch lg:block">
					<div
						ref={tocRef}
						className="sticky overflow-y-auto pb-6 pr-2"
						style={{
							top: "24px",
							marginLeft: hasDefaultToc ? "-42px" : undefined,
							width: hasDefaultToc ? "calc(100% + 42px)" : undefined,
							maxHeight: hasReaderToc ? "calc(100dvh - 240px)" : "calc(100dvh - 320px)",
						}}
						data-testid="markdown-pane-toc"
					>
						<div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-[var(--ink-faint)] mb-2 pl-2">
							{uiText("markdown.markdownpane.contents")}
						</div>
						<ul className="text-[12.5px] space-y-1 border-l border-[var(--line-soft)]">
							{headings.map((h, i) => {
								const isActive = activeId === h.id;
								return (
									<li key={`${h.id}-${i}`}>
										<button
											type="button"
											onClick={() => onJump(h.id)}
											className={cn(
												"w-full text-left pr-1 cursor-pointer block transition-colors",
												hasReaderToc ? "py-1 leading-snug break-words" : "py-0.5 truncate",
												isActive
													? "text-[var(--ink)] font-semibold"
													: "text-[var(--ink-mut)] hover:text-[var(--ink)]",
											)}
											style={{
												paddingLeft: `${(h.level - 1) * 12 + 12}px`,
												borderLeft: `2px solid ${isActive ? "var(--ink)" : "transparent"}`,
												marginLeft: "-1px",
											}}
											title={h.text}
											data-testid={`markdown-pane-toc-item-${h.id}`}
											aria-current={isActive ? "true" : undefined}
										>
											{h.text}
										</button>
									</li>
								);
							})}
						</ul>
					</div>
				</aside>
			)}
			<div
				ref={contentRef}
				className={cn(
					"text-[var(--ink)] artifact-md min-w-0",
					"[&_p]:text-[15px] [&_p]:leading-[1.85] [&_li]:text-[15px] [&_li]:leading-[1.85]",
					"[&_h1]:font-sans [&_h1]:text-[22px] [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-5",
					"[&_h2]:font-sans [&_h2]:text-[18px] [&_h2]:font-semibold [&_h2]:mt-7 [&_h2]:mb-3",
					"[&_h3]:font-sans [&_h3]:text-[16px] [&_h3]:font-semibold [&_h3]:mt-5 [&_h3]:mb-2",
					"[&_blockquote]:my-4 [&_blockquote]:text-[15px]",
					"[&_pre]:text-[13px] [&_pre]:leading-[1.6]",
					"[&_table]:text-[14px]",
				)}
				style={{
					textWrap: "pretty",
					overflowWrap: "anywhere",
					hyphens: "auto",
					fontKerning: "normal",
				}}
				data-testid="markdown-pane-content"
				data-citation-boundary=""
			>
				<MarkdownView
					text={content}
					goalId={goalId}
					artifactName={artifactName}
					messageId={messageId}
				/>
			</div>
		</div>
	);
});
