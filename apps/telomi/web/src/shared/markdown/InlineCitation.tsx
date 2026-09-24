import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { RemoveScroll } from "react-remove-scroll";
import { ArrowLeftIcon, ArrowRightIcon } from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/badge";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";

// 移植自 vercel/ai-elements packages/elements/src/inline-citation.tsx
// 改动:
//   1. HoverCard 用 Radix Popover + 自管 hover delay 实现(没引 hover-card 依赖)
//   2. Carousel 用 React state + Context 实现(没引 embla-carousel-react)
//   3. 颜色全走 telomi 的 CSS 变量(--paper / --ink / --line-soft 等)
//   4. CardTrigger 接受可选 children — 自定义胶囊里展示什么(file 用 basename / url 用 hostname)

// ---------------------------------------------------------------------------
// HoverCard wrapper around @radix-ui/react-popover
// ---------------------------------------------------------------------------

interface HoverCardCtxValue {
	requestOpen: () => void;
	requestClose: () => void;
	dismiss: () => void;
	open: boolean;
	/** The chip element; the card keeps itself inside the chip's content column. */
	triggerRef: React.MutableRefObject<HTMLElement | null>;
}

const HoverCardCtx = React.createContext<HoverCardCtxValue>({
	requestOpen: () => {},
	requestClose: () => {},
	dismiss: () => {},
	open: false,
	triggerRef: { current: null },
});

// 卡片 portal 到 body 后 Radix 只按视口避让,会伸出 Dialog 边界、压住目录。
// 碰撞边界取两者交集:chip 最近的纵向滚动容器(Dialog 正文区、聊天列表)限制
// 上下,标了 data-citation-boundary 的正文列限制左右,目录列不再被压住;
// 可用高度/宽度变量也随之按该交集计算。
function collisionBoundariesOf(element: HTMLElement | null): Element[] {
	const boundaries: Element[] = [];
	const column = element?.closest("[data-citation-boundary]");
	if (column) boundaries.push(column);
	for (let node = element?.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
			boundaries.push(node);
			break;
		}
	}
	return boundaries;
}

export type InlineCitationCardProps = {
	openDelay?: number;
	closeDelay?: number;
	children?: React.ReactNode;
};

// 模块级单例:同一时刻只允许一个 InlineCitationCard 处于打开状态。鼠标在
// 相邻 chip 间快速来回时,旧 card 立即关闭、新 card 立即打开,跳过 80/120ms
// 延迟,避免「两个 popover 同时叠加」与「全关再全开」闪烁。第一次进入
// (没有任何 card 打开)仍走 80ms enterDelay。
let activeCardId: symbol | null = null;
const cardClosers = new Map<symbol, () => void>();

// 滚动会把 chip 送到静止的光标底下,浏览器随即补发一次用户并未做出的 hover。
// 不拦截的话 card 会自行打开,并随后续滚动漂在无关正文上。任何滚动都立即关闭
// 当前 card,并在短暂窗口内忽略 hover;光标真正移动后才允许再次打开。
const SCROLL_HOVER_GRACE_MS = 300;
let lastScrollAt = -Infinity;
let mountedCards = 0;
function onDocumentScroll(event: Event) {
	if (event.target instanceof Element && event.target.closest(".inline-citation-popover")) return;
	lastScrollAt = performance.now();
	if (activeCardId !== null) cardClosers.get(activeCardId)?.();
}
function hoverFollowsScroll(): boolean {
	return performance.now() - lastScrollAt < SCROLL_HOVER_GRACE_MS;
}

export const InlineCitationCard = ({
	openDelay = 80,
	closeDelay = 120,
	children,
}: InlineCitationCardProps) => {
	const id = React.useMemo(() => Symbol("inline-citation-card"), []);
	const [open, setOpen] = React.useState(false);
	const enterTimer = React.useRef<number | null>(null);
	const leaveTimer = React.useRef<number | null>(null);
	const dismissedUntil = React.useRef(0);

	const closeImmediately = React.useCallback(() => {
		if (enterTimer.current != null) {
			window.clearTimeout(enterTimer.current);
			enterTimer.current = null;
		}
		if (leaveTimer.current != null) {
			window.clearTimeout(leaveTimer.current);
			leaveTimer.current = null;
		}
		setOpen(false);
		if (activeCardId === id) activeCardId = null;
	}, [id]);

	// 注册自身的「立即关闭」入口,让别的 card 在接力时能强关本 card。
	React.useEffect(() => {
		cardClosers.set(id, closeImmediately);
		if (mountedCards++ === 0) document.addEventListener("scroll", onDocumentScroll, { capture: true, passive: true });
		return () => {
			cardClosers.delete(id);
			if (activeCardId === id) activeCardId = null;
			if (--mountedCards === 0) document.removeEventListener("scroll", onDocumentScroll, { capture: true });
		};
	}, [id, closeImmediately]);

	// pointerenter 和 pointermove 都会调用;已在等待或已打开时保持不变。
	const requestOpen = React.useCallback(() => {
		if (performance.now() < dismissedUntil.current || hoverFollowsScroll()) return;
		if (leaveTimer.current != null) {
			window.clearTimeout(leaveTimer.current);
			leaveTimer.current = null;
		}
		if (enterTimer.current != null) return;
		// 已有别的 card 打开 → 立即关旧 + 立即开新(无 enterDelay)。
		if (activeCardId !== null && activeCardId !== id) {
			cardClosers.get(activeCardId)?.();
			setOpen(true);
			activeCardId = id;
			return;
		}
		if (activeCardId === id) return; // 已是当前 active,继续保持
		// 全关状态下首次打开 → 走 enterDelay。
		enterTimer.current = window.setTimeout(() => {
			enterTimer.current = null;
			if (hoverFollowsScroll()) return;
			setOpen(true);
			activeCardId = id;
		}, openDelay);
	}, [id, openDelay]);

	const dismiss = React.useCallback(() => {
		dismissedUntil.current = performance.now() + 400;
		closeImmediately();
	}, [closeImmediately]);

	const requestClose = React.useCallback(() => {
		if (enterTimer.current != null) {
			window.clearTimeout(enterTimer.current);
			enterTimer.current = null;
		}
		if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
		leaveTimer.current = window.setTimeout(() => {
			setOpen(false);
			if (activeCardId === id) activeCardId = null;
			leaveTimer.current = null;
		}, closeDelay);
	}, [id, closeDelay]);

	React.useEffect(() => () => {
		if (enterTimer.current != null) window.clearTimeout(enterTimer.current);
		if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
	}, []);

	const triggerRef = React.useRef<HTMLElement | null>(null);
	const ctx = React.useMemo<HoverCardCtxValue>(
		() => ({ requestOpen, requestClose, dismiss, open, triggerRef }),
		[requestOpen, requestClose, dismiss, open],
	);

	// Radix 内部触发 onOpenChange(用户 Esc / 点外部)时也要同步 activeCardId,
	// 否则下一个 hover 会以为「还有 card 打开」走立即接力路径,跳过 enterDelay。
	const handleOpenChange = React.useCallback(
		(next: boolean) => {
			setOpen(next);
			if (next) activeCardId = id;
			else if (activeCardId === id) activeCardId = null;
		},
		[id],
	);

	return (
		<HoverCardCtx.Provider value={ctx}>
			<PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
				{children}
			</PopoverPrimitive.Root>
		</HoverCardCtx.Provider>
	);
};

// ---------------------------------------------------------------------------
// Outer wrapper
// ---------------------------------------------------------------------------

export type InlineCitationProps = React.ComponentProps<"span">;

export const InlineCitation = ({ className, ...props }: InlineCitationProps) => (
	<span className={cn("group inline items-center gap-1", className)} {...props} />
);

// ---------------------------------------------------------------------------
// HoverCard trigger (badge / chip)
// ---------------------------------------------------------------------------

export type InlineCitationCardTriggerProps = React.ComponentProps<typeof Badge> & {
	sources: string[];
	/** Optional custom label rendered inside the badge.  Falls back to sources[0]'s hostname. */
	children?: React.ReactNode;
};

function defaultTriggerLabel(sources: string[]): React.ReactNode {
	const src = sources[0];
	if (!src) return "unknown";
	try {
		return (
			<>
				{new URL(src).hostname}
				{sources.length > 1 ? ` +${sources.length - 1}` : ""}
			</>
		);
	} catch {
		return src;
	}
}

export const InlineCitationCardTrigger = React.forwardRef<
	HTMLButtonElement,
	InlineCitationCardTriggerProps
>(({ sources, className, children, onPointerEnter, onPointerMove, onPointerLeave, onFocus, onBlur, ...props }, ref) => {
	const ctx = React.useContext(HoverCardCtx);
	const { triggerRef } = ctx;
	const setTrigger = React.useCallback(
		(element: HTMLButtonElement | null) => {
			triggerRef.current = element;
			if (typeof ref === "function") ref(element);
			else if (ref) ref.current = element;
		},
		[triggerRef, ref],
	);
	return (
		<PopoverPrimitive.Trigger asChild>
			<button
				ref={setTrigger}
				type="button"
				onPointerEnter={(e) => {
					ctx.requestOpen();
					onPointerEnter?.(e);
				}}
				onPointerMove={(e) => {
					ctx.requestOpen();
					onPointerMove?.(e);
				}}
				onPointerLeave={(e) => {
					ctx.requestClose();
					onPointerLeave?.(e);
				}}
				onFocus={(e) => {
					if (e.currentTarget.matches(":focus-visible")) ctx.requestOpen();
					onFocus?.(e);
				}}
				onBlur={(event) => {
					const popover = event.currentTarget.ownerDocument.querySelector(".inline-citation-popover");
					const next = event.relatedTarget;
					if (!(popover?.matches(":hover")
						|| next instanceof Element && popover?.contains(next))) {
						ctx.requestClose();
					}
					onBlur?.(event);
				}}
				className={cn(
					"inline-flex items-center justify-center rounded-full border-transparent",
					"px-2 py-0.5 ml-1 text-[11px] font-medium leading-none",
					"bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]",
					"text-[var(--ink-mut)] hover:text-[var(--ink)]",
					"hover:bg-[color-mix(in_oklch,var(--foreground)_14%,transparent)]",
					"transition-colors cursor-pointer outline-none",
					"focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40",
					"align-baseline",
					className,
				)}
				{...props}
			>
				{children ?? defaultTriggerLabel(sources)}
			</button>
		</PopoverPrimitive.Trigger>
	);
});
InlineCitationCardTrigger.displayName = "InlineCitationCardTrigger";

// ---------------------------------------------------------------------------
// HoverCard content
// ---------------------------------------------------------------------------

export type InlineCitationCardBodyProps = React.ComponentProps<typeof PopoverPrimitive.Content>;

export const InlineCitationCardBody = ({
	className,
	sideOffset = 6,
	align = "start",
	children,
	onEscapeKeyDown,
	...props
}: InlineCitationCardBodyProps) => {
	const ctx = React.useContext(HoverCardCtx);
	// 打开时按 chip 当前位置取边界;关闭态不渲染内容,边界无意义。
	const collisionBoundary = ctx.open ? collisionBoundariesOf(ctx.triggerRef.current) : [];
	return (
		<PopoverPrimitive.Portal>
			{/* 卡片 portal 到 body,落在 Dialog 滚动锁之外,滚轮会被 Dialog 拦截。
			    嵌套一层 noIsolation 锁成为栈顶:卡片内可滚动且不串到下层,卡片外不受影响。 */}
			<RemoveScroll forwardProps noIsolation removeScrollBar={false}>
				<PopoverPrimitive.Content
					sideOffset={sideOffset}
					align={align}
					collisionPadding={16}
					collisionBoundary={collisionBoundary}
					onOpenAutoFocus={(e) => e.preventDefault()}
					onPointerEnter={ctx.requestOpen}
					onPointerLeave={ctx.requestClose}
					onEscapeKeyDown={(event) => {
						ctx.dismiss();
						onEscapeKeyDown?.(event);
					}}
					className={cn(
						"inline-citation-popover relative z-50 w-[min(520px,calc(100vw-32px))] p-0 outline-none",
						"rounded-[8px] border border-[var(--line-soft)] bg-[var(--paper)] text-[var(--ink)] shadow-md",
						className,
					)}
					{...props}
				>
					{children}
				</PopoverPrimitive.Content>
			</RemoveScroll>
		</PopoverPrimitive.Portal>
	);
};

// ---------------------------------------------------------------------------
// Carousel — pure-React replacement for shadcn embla wrapper
// ---------------------------------------------------------------------------

interface CarouselCtxValue {
	current: number;
	count: number;
	registerCount: (n: number) => void;
	scrollPrev: () => void;
	scrollNext: () => void;
}

const CarouselCtx = React.createContext<CarouselCtxValue>({
	current: 0,
	count: 0,
	registerCount: () => {},
	scrollPrev: () => {},
	scrollNext: () => {},
});

export type InlineCitationCarouselProps = React.ComponentProps<"div">;

export const InlineCitationCarousel = ({
	className,
	children,
	...props
}: InlineCitationCarouselProps) => {
	const [current, setCurrent] = React.useState(0);
	const [count, setCount] = React.useState(0);

	const registerCount = React.useCallback((n: number) => {
		setCount(n);
		setCurrent((c) => (c >= n ? Math.max(0, n - 1) : c));
	}, []);

	const scrollPrev = React.useCallback(() => {
		setCurrent((c) => (count <= 0 ? 0 : (c - 1 + count) % count));
	}, [count]);

	const scrollNext = React.useCallback(() => {
		setCurrent((c) => (count <= 0 ? 0 : (c + 1) % count));
	}, [count]);

	const ctx = React.useMemo<CarouselCtxValue>(
		() => ({ current, count, registerCount, scrollPrev, scrollNext }),
		[current, count, registerCount, scrollPrev, scrollNext],
	);

	return (
		<CarouselCtx.Provider value={ctx}>
			<div className={cn("w-full", className)} {...props}>
				{children}
			</div>
		</CarouselCtx.Provider>
	);
};

export type InlineCitationCarouselContentProps = React.ComponentProps<"div">;

export const InlineCitationCarouselContent = ({
	className,
	children,
	...props
}: InlineCitationCarouselContentProps) => {
	const { current, registerCount } = React.useContext(CarouselCtx);
	const items = React.Children.toArray(children).filter(React.isValidElement);

	React.useEffect(() => {
		registerCount(items.length);
	}, [items.length, registerCount]);

	return (
		<div className={cn("relative overflow-hidden", className)} {...props}>
			{items.map((child, idx) => (
				<div
					key={idx}
					className={cn(
						"transition-opacity duration-150",
						idx === current ? "block" : "hidden",
					)}
				>
					{child}
				</div>
			))}
		</div>
	);
};

export type InlineCitationCarouselItemProps = React.ComponentProps<"div">;

export const InlineCitationCarouselItem = ({
	className,
	style,
	...props
}: InlineCitationCarouselItemProps) => (
	<div
		className={cn("w-full space-y-3 overflow-y-auto p-4", className)}
		style={{
			maxHeight: "min(62vh, 560px, calc(var(--radix-popover-content-available-height) - 40px))",
			...style,
		}}
		{...props}
	/>
);

export type InlineCitationCarouselHeaderProps = React.ComponentProps<"div">;

export const InlineCitationCarouselHeader = ({
	className,
	...props
}: InlineCitationCarouselHeaderProps) => (
	<div
		className={cn(
			"flex h-10 items-center justify-between gap-2 rounded-t-[8px] border-b border-[var(--line-soft)]",
			"bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-2 py-1.5",
			className,
		)}
		{...props}
	/>
);

export type InlineCitationCarouselIndexProps = React.ComponentProps<"div">;

export const InlineCitationCarouselIndex = ({
	children,
	className,
	...props
}: InlineCitationCarouselIndexProps) => {
	const ctx = React.useContext(CarouselCtx);
	const display = ctx.count > 1 ? uiText("markdown.inlinecitation.sourceCurrentCount", { current: ctx.current + 1, count: ctx.count }) : uiText("markdown.inlinecitation.source");
	return (
		<div
			className={cn(
				"flex flex-1 items-center justify-center px-3 py-1",
				"text-[var(--ink-faint)] text-[11px] font-mono uppercase tracking-[0.08em]",
				className,
			)}
			{...props}
		>
			{children ?? display}
		</div>
	);
};

export type InlineCitationCarouselPrevProps = React.ComponentProps<"button">;

export const InlineCitationCarouselPrev = ({
	className,
	onClick,
	onMouseDown,
	onPointerDown,
	...props
}: InlineCitationCarouselPrevProps) => {
	const { count, scrollPrev } = React.useContext(CarouselCtx);
	return (
		<button
			aria-label={uiText("markdown.inlinecitation.previous")}
			className={cn(
				"shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-[6px]",
				"text-[var(--ink-mut)] hover:text-[var(--ink)] hover:bg-[var(--paper-2)] cursor-pointer",
				"disabled:opacity-30 disabled:cursor-not-allowed",
				className,
			)}
			onPointerDown={(event) => {
				event.stopPropagation();
				onPointerDown?.(event);
			}}
			onMouseDown={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onMouseDown?.(event);
			}}
			onClick={(event) => {
				event.stopPropagation();
				onClick?.(event);
				if (!event.defaultPrevented) scrollPrev();
			}}
			disabled={count <= 1}
			type="button"
			{...props}
		>
			<ArrowLeftIcon className="size-3.5" aria-hidden />
		</button>
	);
};

export type InlineCitationCarouselNextProps = React.ComponentProps<"button">;

export const InlineCitationCarouselNext = ({
	className,
	onClick,
	onMouseDown,
	onPointerDown,
	...props
}: InlineCitationCarouselNextProps) => {
	const { count, scrollNext } = React.useContext(CarouselCtx);
	return (
		<button
			aria-label={uiText("markdown.inlinecitation.next")}
			className={cn(
				"shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-[6px]",
				"text-[var(--ink-mut)] hover:text-[var(--ink)] hover:bg-[var(--paper-2)] cursor-pointer",
				"disabled:opacity-30 disabled:cursor-not-allowed",
				className,
			)}
			onPointerDown={(event) => {
				event.stopPropagation();
				onPointerDown?.(event);
			}}
			onMouseDown={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onMouseDown?.(event);
			}}
			onClick={(event) => {
				event.stopPropagation();
				onClick?.(event);
				if (!event.defaultPrevented) scrollNext();
			}}
			disabled={count <= 1}
			type="button"
			{...props}
		>
			<ArrowRightIcon className="size-3.5" aria-hidden />
		</button>
	);
};
