import { useEffect, useRef, type ReactNode } from "react";

/**
 * 把 highlightLine 定位到 MarkdownView 渲染出来的某个块并临时高亮。
 *
 * MarkdownView 的 wrapBlock 已经给每个顶层块加了 `data-md-block-path="line:N-M"`
 * 属性(对应 mdast 节点在源码里的 [start, end] 行号区间)。我们扫一遍这些块,
 * 找包含 highlightLine 的那个;若 highlightLine 落在块之间(空行 / 容器开头),
 * 退化到 start ≥ highlightLine 的最近块。
 *
 * 高亮通过 `md-line-flash` class 实现(全局 CSS 里短暂背景脉冲)。`scroll`
 * 控制是否滚动到目标块 —— 右栏面板需要,popover 内层不需要(否则会顶动 popover 容器)。
 */
export function MarkdownLineLocator({
	highlightLine,
	scroll = true,
	children,
}: {
	highlightLine?: number;
	scroll?: boolean;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!highlightLine || !ref.current) return;
		// useEffect 已经在 commit 之后跑,DOM 上 wrapBlock 的输出就位 —— 直接同步扫。
		// (之前包了一层 requestAnimationFrame,但在 headless / 后台标签里 rAF 会被
		// 节流甚至不触发,导致定位永远不命中。)
		const blocks = ref.current.querySelectorAll<HTMLElement>('[data-md-block-path^="line:"]');
		let target: HTMLElement | null = null;
		// 嵌套块(ul > li,table > tr)会让 querySelectorAll 先返回父再返回子,
		// 父行号区间一定包含子。要让 highlight 落到最具体那一块,记录"最小包含
		// 区间"(end-start 最小)。range 相同时保留先遇到的(DOM 顺序优先)。
		let smallestRange = Number.POSITIVE_INFINITY;
		let nearestAfter: { el: HTMLElement; start: number } | null = null;
		for (const el of Array.from(blocks)) {
			const m = /^line:(\d+)-(\d+)$/.exec(el.dataset.mdBlockPath || "");
			if (!m) continue;
			const start = Number(m[1]);
			const end = Number(m[2]);
			if (highlightLine >= start && highlightLine <= end) {
				const range = end - start;
				if (range < smallestRange) {
					smallestRange = range;
					target = el;
				}
				continue;
			}
			if (start >= highlightLine && (!nearestAfter || start < nearestAfter.start)) {
				nearestAfter = { el, start };
			}
		}
		if (!target && nearestAfter) target = nearestAfter.el;
		if (!target) return;
		if (scroll) {
			target.scrollIntoView({ block: "center", behavior: "smooth" });
		}
		target.classList.add("md-line-flash");
		const t = window.setTimeout(() => {
			target?.classList.remove("md-line-flash");
		}, 1800);
		return () => window.clearTimeout(t);
	}, [highlightLine, scroll]);
	return <div ref={ref}>{children}</div>;
}
