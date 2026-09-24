import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import { uiText } from "@/app/ui-text";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { Globe } from "lucide-react";
import remarkGfm from "remark-gfm";
// CommonMark refuses to close `**` when CJK punctuation sits inside and a CJK letter follows
// (`**标题。**正文`). This extension relaxes the flanking rule for CJK text.
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "katex/dist/katex.min.css";
import { MermaidBlock } from "@/shared/markdown/MermaidBlock";
import { DiffBlock } from "@/shared/markdown/DiffBlock";
import { CodeBlock, InlineCode } from "@/shared/markdown/CodeBlock";
import { MarkdownJsonBlock } from "@/shared/markdown/MarkdownJsonBlock";
import { MarkdownLatexBlock } from "@/shared/markdown/MarkdownLatexBlock";
import { MARKDOWN_MATH_OPTIONS } from "@/shared/markdown/markdown-math-options";
import { isSourceAssetUri, sourceAssetHttpUrl } from "@/shared/markdown/source-asset";
import { resolveMarkdownLinkTarget } from "@/shared/markdown/markdown-link-target";
import { preprocessLinks } from "@/shared/markdown/markdown-linkify";
import { simpleHash, splitIntoBlocks } from "@/shared/markdown/markdown-split";
import {
	remarkIndexedCitations,
	decodeCiteData,
	decodeCiteDataList,
	citeKey,
} from "@/shared/markdown/markdown-cite";
import { SOURCE_BRAND_PATHS } from "@/shared/markdown/source-kind";
import { PiCiteChip } from "@/shared/markdown/PiCiteChip";
import { cn } from "@/shared/lib/utils";

// rehypeRaw turns raw <script>/<iframe>/onerror= from markdown into hast
// nodes — sanitize it before any downstream rehype plugin runs. The schema
// extends defaultSchema to keep code-block language hints (Shiki reads
// className like "language-ts") and a few read-only HTML niceties LLMs
// commonly emit. Order matters: rehypeRaw → rehypeSanitize → rehypeKatex,
// so KaTeX's own injected nodes are not stripped.
const sanitizeSchema: typeof defaultSchema = {
	...defaultSchema,
	tagNames: [
		...(defaultSchema.tagNames ?? []),
		"details",
		"summary",
		"sub",
		"sup",
		"kbd",
		"mark",
	],
	attributes: {
		...(defaultSchema.attributes ?? {}),
		code: [["className", /^language-./]],
		span: [
			...((defaultSchema.attributes?.span as never[]) ?? []),
			["className", /^hljs-./, /^token$/, /^token-./],
			// Indexed citation chip placeholder emitted by remarkIndexedCitations.
			// raw `<span data-pi-cite="…">` (single source) or
			// `<span data-pi-cites="…">` (consecutive group, payload is an
			// encoded JSON array). hast-util-sanitize matches schema names
			// against hast property names, which are camelCase for data attrs
			// — `data-pi-cite{,s}` become `dataPiCite{,s}`. The kebab form was
			// silently dropped before this fix.
			["dataPiCite", /.*/],
			["dataPiCites", /.*/],
			// Site icon placeholder that markSourceListItems puts before a Source list link.
			["dataPiSource", /^[a-z]+$/],
		],
		details: [["open", true]],
	},
	protocols: {
		...(defaultSchema.protocols ?? {}),
		src: [...(defaultSchema.protocols?.src ?? []), "source-asset"],
	},
};

export type MarkdownMode = "document" | "chat" | "terminal";

interface LinkClickContextValue {
	onUrlClick?: (url: string) => void;
	/**
	 * file 点击回调。普通 file 链接的 line 为 undefined。
	 * 顶层文件阅读器负责打开文件并定位到行号。
	 */
	onFileClick?: (path: string, line?: number) => void;
	/** Resolve relative images against the file currently open in a Workspace reader. */
	resolveFileUrl?: (path: string) => string;
	/**
	 * 当前 goal id。file citation popover 在 hover 时通过
	 * `/api/goals/:goalId/workspace/file-slice` 拉取行内容预览,需要这个 id。
	 * 没有 goalId 时(独立挂载、邮件页面等)file 预览功能 silently fallback 到不显示行内容。
	 */
	goalId?: string | null;
	/** Artifact path for resolving report URL citations back to Research Evidence. */
	artifactName?: string;
	/**
	 * 当前 markdown 块归属的 message_id —— chat 内引用 Source 预览据此定位消息。
	 * 由 props 注入(不复用 outer context),保证消息切换时不串台。
	 */
	messageId?: string;
}

// Context lets the memoized per-block renderer pick up the latest handler
// without invalidating MemoBlock — callers can update click closures freely.
// Exported so a parent (e.g. ChatPage) can provide ambient handlers without
// threading props through MessageList → TurnCard → MarkdownView.
export const LinkClickContext = createContext<LinkClickContextValue | null>(null);
const InsideMarkdownAnchor = createContext(false);

const MD_CLASSES_DOCUMENT = [
	"text-[var(--foreground)]",
	"[&_p]:my-3 [&_p]:leading-relaxed [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
	"[&_ul]:list-disc [&_ul]:ps-[16px] [&_ul]:pe-2 [&_ul]:my-3 [&_ul]:space-y-1.5 [&_ul]:marker:text-[var(--md-bullets)]",
	"[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3 [&_ol]:space-y-1.5 [&_ol]:marker:text-[var(--md-counters)]",
	"[&_li]:leading-relaxed",
	"[&_li.task-list-item]:list-none",
	"[&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:ps-0 [&_ul.contains-task-list]:marker:content-none",
	"[&_h1]:font-sans [&_h1]:text-[16px] [&_h1]:font-bold [&_h1]:mt-7 [&_h1]:mb-4",
	"[&_h2]:font-sans [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:mb-3",
	"[&_h3]:font-sans [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:mt-5 [&_h3]:mb-3",
	"[&_h4]:text-[14px] [&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1",
	"[&_blockquote]:border-l-4 [&_blockquote]:border-l-[color-mix(in_oklch,var(--foreground)_30%,transparent)] [&_blockquote]:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] [&_blockquote]:pl-4 [&_blockquote]:pr-3 [&_blockquote]:py-2 [&_blockquote]:my-3 [&_blockquote]:rounded-r-[6px]",
	"[&_hr]:my-6 [&_hr]:border-[var(--border)]",
	"[&_strong]:font-semibold",
	"[&_em]:italic",
	"[&_del]:line-through [&_del]:text-[var(--muted-foreground)]",
	"[&_pre]:bg-[color-mix(in_oklch,var(--muted)_30%,var(--background))] [&_pre]:border [&_pre]:border-[var(--border)] [&_pre]:px-[0.8rem] [&_pre]:py-[0.6rem] [&_pre]:rounded-[8px] [&_pre]:overflow-auto [&_pre]:text-[0.82em] [&_pre]:my-[0.4rem]",
	"[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[inherit] [&_pre_code]:text-[var(--foreground)]",
].join(" ");

const MD_CLASSES_CHAT = [
	"text-[var(--foreground)]",
	"[&_p]:my-2 [&_p]:leading-relaxed [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
	"[&_ul]:list-disc [&_ul]:ps-[16px] [&_ul]:pe-2 [&_ul]:my-2 [&_ul]:space-y-1 [&_ul]:marker:text-[var(--md-bullets)]",
	"[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-2 [&_ol]:space-y-1",
	"[&_li.task-list-item]:list-none",
	"[&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:ps-0 [&_ul.contains-task-list]:marker:content-none",
	"[&_h1]:font-sans [&_h1]:text-[16px] [&_h1]:font-bold [&_h1]:mt-5 [&_h1]:mb-3",
	"[&_h2]:font-sans [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-3",
	"[&_h3]:font-sans [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2",
	"[&_blockquote]:border-l-2 [&_blockquote]:border-[color-mix(in_oklch,var(--foreground)_30%,transparent)] [&_blockquote]:pl-3 [&_blockquote]:my-2 [&_blockquote]:text-[var(--muted-foreground)] [&_blockquote]:italic",
	"[&_hr]:my-4 [&_hr]:border-[var(--border)]",
	"[&_strong]:font-semibold",
	"[&_em]:italic",
	"[&_del]:line-through [&_del]:text-[var(--muted-foreground)]",
].join(" ");

const MD_CLASSES_TERMINAL =
	"font-mono text-[var(--foreground)] [&_p]:my-1 [&_pre]:my-2 [&_pre]:whitespace-pre-wrap";

function classesForMode(mode: MarkdownMode): string {
	if (mode === "chat") return MD_CLASSES_CHAT;
	if (mode === "terminal") return MD_CLASSES_TERMINAL;
	return MD_CLASSES_DOCUMENT;
}

const LINK_CLASSES = "text-[var(--accent)] hover:underline cursor-pointer";

function markdownUrlTransform(url: string): string {
	return isSourceAssetUri(url) ? url : defaultUrlTransform(url);
}

function MarkdownImage({ src, alt, node: _node, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
	const ctx = useContext(LinkClickContext);
	const custom = typeof src === "string" && src.startsWith("source-asset:");
	const resolved = typeof src === "string" ? sourceAssetHttpUrl(src, ctx?.goalId) : null;
	if (custom && !resolved) return <span>{alt || uiText("markdown.markdownview.sourceImage")}</span>;
	const fileUrl = typeof src === "string" && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/iu.test(src)
		? ctx?.resolveFileUrl?.(src) : undefined;
	return <img src={resolved ?? fileUrl ?? src} alt={alt ?? ""} loading="lazy" className="my-4 h-auto max-w-full rounded-[6px]" {...rest} />;
}

function MarkdownInlineCode({ children }: { children?: ReactNode }) {
	const ctx = useContext(LinkClickContext);
	const insideAnchor = useContext(InsideMarkdownAnchor);
	const path = typeof children === "string" ? children : "";
	const code = <InlineCode>{children}</InlineCode>;
	return !insideAnchor && ctx?.onFileClick && !path.includes("\n") && resolveMarkdownLinkTarget(path).kind === "file"
		? <MarkdownAnchor href={path}>{code}</MarkdownAnchor> : code;
}

function MarkdownAnchor({
	href,
	children,
	...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
	const ctx = useContext(LinkClickContext);

	const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		// Route file and URL targets through dedicated callbacks.
		// Only intercept (preventDefault) when we actually have a handler for
		// the resolved kind, otherwise use the browser's default navigation.
		// This avoids silently swallowing a
		// click when a caller passes only one of onUrlClick / onFileClick.
		// Some AI outputs include raw HTML anchors with empty href but path text.
		const fallbackText = (Array.isArray(children) ? children : [children])
			.map((c) => (typeof c === "string" ? c : ""))
			.join("")
			.trim();
		const target = (href ?? "").trim() || fallbackText;
		if (!target) return;
		if (target.startsWith("#")) {
			let id = target.slice(1);
			try { id = decodeURIComponent(id); } catch { /* Literal fragment is still a valid id. */ }
			const root = e.currentTarget.closest('[data-testid="markdown-pane-content"]');
			const heading = Array.from(root?.querySelectorAll<HTMLElement>("[id]") ?? []).find((node) => node.id === id);
			if (heading) { e.preventDefault(); heading.scrollIntoView({ block: "start" }); }
			return;
		}
		const resolved = resolveMarkdownLinkTarget(target);
		if (resolved.kind === "file" && ctx?.onFileClick) {
			e.preventDefault();
			ctx.onFileClick(target);
			return;
		}
		if (resolved.kind === "url" && ctx?.onUrlClick) {
			e.preventDefault();
			ctx.onUrlClick(resolved.url);
			return;
		}
		// Fall through to default browser navigation if the new API cannot handle this link.
	};

	return (
		<a
			href={href}
			target={href?.startsWith("#") ? undefined : "_blank"}
			rel="noreferrer"
			className={LINK_CLASSES}
			onClick={onClick}
			{...rest}
		>
			<InsideMarkdownAnchor.Provider value={true}>{children}</InsideMarkdownAnchor.Provider>
		</a>
	);
}

function PiCiteChipBridge({ encoded, plural }: { encoded: string; plural: boolean }) {
	const ctx = useContext(LinkClickContext);
	const dataList = useMemo(() => {
		const raw = plural
			? decodeCiteDataList(encoded) ?? []
			: (() => {
					const single = decodeCiteData(encoded);
					return single ? [single] : [];
				})();
		// 同 chip 内按 citeKey 去重 —— LLM 偶尔把同一引用连写两次
		// (`[A][A]`),合并组里展示一次足够,carousel 也不会出现 1/2 但两页相同。
		const seen = new Set<string>();
		const out: typeof raw = [];
		for (const d of raw) {
			const k = citeKey(d);
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(d);
		}
		return out;
	}, [encoded, plural]);
	if (dataList.length === 0) return null;
	const indices = dataList.map((d) => d.index);
	return (
		<PiCiteChip
			goalId={ctx?.goalId ?? null}
			artifactName={ctx?.artifactName}
			dataList={dataList}
			indices={indices}
			onUrlClick={ctx?.onUrlClick}
			onFileClick={ctx?.onFileClick}
			messageId={ctx?.messageId ?? null}
		/>
	);
}

function stableHashStr(input: string): string {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

type HastPosition = { start?: { line?: number }; end?: { line?: number } };
type NodeWithPosition = { position?: HastPosition };

// MarkdownLineLocator 在 DOM 上扫 `[data-md-block-path^="line:"]` 来找命中行;
// wrapBlock 只在代码块路径上调用,所以非代码块(段落/表格/标题/列表)需要这个
// 辅助函数把 mdast 的行号 position 直接落到顶层元素上,locator 才能精确滚动 + 高亮。
function mdBlockAttrs(node?: NodeWithPosition): { "data-md-block-path"?: string } {
	const startLine = node?.position?.start?.line;
	const endLine = node?.position?.end?.line;
	if (typeof startLine === "number" && typeof endLine === "number") {
		return { "data-md-block-path": `line:${startLine}-${endLine}` };
	}
	return {};
}

function wrapBlock(
	blockType: string,
	content: string,
	child: ReactNode,
	position?: { start?: { line?: number }; end?: { line?: number } },
): ReactNode {
	const startLine = position?.start?.line;
	const endLine = position?.end?.line;
	const path =
		startLine && endLine
			? `line:${startLine}-${endLine}`
			: `idx:${stableHashStr(content)}`;
	const blockId = `blk-${stableHashStr(`${blockType}|${path}|${content.slice(0, 240)}`)}`;
	return (
		<div data-md-block-type={blockType} data-md-block-path={path} data-md-block-id={blockId}>
			{child}
		</div>
	);
}

function dispatchBlockCode(
	lang: string | undefined,
	source: string,
	position: { start?: { line?: number }; end?: { line?: number } } | undefined,
	codeBlockMode: "full" | "minimal" | "terminal",
): ReactNode {
	if (lang === "mermaid") {
		return wrapBlock("code", source, <MermaidBlock source={source} />, position);
	}
	if (lang === "diff") {
		return wrapBlock("code", source, <DiffBlock source={source} />, position);
	}
	if (lang === "json") {
		return wrapBlock("code", source, <MarkdownJsonBlock code={source} className="my-2" />, position);
	}
	if (lang === "latex" || lang === "math") {
		return wrapBlock("latex", source, <MarkdownLatexBlock code={source} className="my-2" />, position);
	}
	return wrapBlock(
		"code",
		source,
		<CodeBlock code={source} language={lang || "text"} mode={codeBlockMode} className="my-2" />,
		position,
	);
}

const REMARK_PLUGINS_BASE = [remarkGfm, remarkCjkFriendly, [remarkMath, MARKDOWN_MATH_OPTIONS]] as const;
const REMARK_PLUGINS_WITH_CITE = [...REMARK_PLUGINS_BASE, remarkIndexedCitations] as const;
const REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex] as const;

function remarkPluginsForMode(mode: MarkdownMode) {
	// terminal 模式保持纯文本观感,不把索引引用转换成 chip。
	return mode === "terminal" ? REMARK_PLUGINS_BASE : REMARK_PLUGINS_WITH_CITE;
}

const COMMON_HANDLERS = {
	img: MarkdownImage,
	a({ children, href, ...props }: { children?: ReactNode; href?: string }) {
		return (
			<MarkdownAnchor href={href} {...props}>
				{children}
			</MarkdownAnchor>
		);
	},
	input({ type, checked }: { type?: string; checked?: boolean }) {
		if (type === "checkbox") {
			return (
				<input
					type="checkbox"
					checked={!!checked}
					readOnly
					className="mr-2 rounded-[3px] border-[var(--muted-foreground)] align-middle"
				/>
			);
		}
		return <input type={type} />;
	},
	// 给所有顶层块标注 mdast 行号区间,供 MarkdownLineLocator 滚动 + 高亮命中。
	// wrapBlock 已经覆盖代码块(dispatchBlockCode 调用),这里负责剩下的常规块:
	// 段落 / 标题 / 列表 / 列表项 / 引用 / 分割线。
	p({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <p {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</p>;
	},
	h1({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <h1 {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</h1>;
	},
	h2({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <h2 {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</h2>;
	},
	h3({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <h3 {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</h3>;
	},
	h4({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <h4 {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</h4>;
	},
	h5({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <h5 {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</h5>;
	},
	h6({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <h6 {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</h6>;
	},
	blockquote({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <blockquote {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</blockquote>;
	},
	ul({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <ul {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</ul>;
	},
	ol({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <ol {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</ol>;
	},
	li({ children, node, ...rest }: { children?: ReactNode; node?: NodeWithPosition; [k: string]: unknown }) {
		return <li {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)}>{children}</li>;
	},
	hr({ node, ...rest }: { node?: NodeWithPosition; [k: string]: unknown }) {
		return <hr {...(rest as Record<string, unknown>)} {...mdBlockAttrs(node)} />;
	},
	// 索引引用 chip - `[[1]](url)` 被 remarkIndexedCitations 转成
	// <span data-pi-cite="..."> (单源) 或 <span data-pi-cites="..."> (连续多源,
	// payload 是 encoded JSON 数组)。复数优先 —— 避免 `data-pi-cites` 被错误
	// 地按单数 fallback 解出失败值。其他普通 <span> 透传 children。
	span({
		children,
		"data-pi-cite": dataPiCite,
		"data-pi-cites": dataPiCites,
		"data-pi-source": dataPiSource,
		...props
	}: {
		children?: ReactNode;
		"data-pi-cite"?: string;
		"data-pi-cites"?: string;
		"data-pi-source"?: string;
		[k: string]: unknown;
	}) {
		const propsAny = props as Record<string, string | undefined>;
		const source = dataPiSource ?? propsAny.dataPiSource;
		if (source) return <SourceSiteIcon kind={source} />;
		const plural = (dataPiCites ?? propsAny.dataPiCites) as string | undefined;
		if (typeof plural === "string" && plural.length > 0) {
			return <PiCiteChipBridge encoded={plural} plural={true} />;
		}
		const single = (dataPiCite ?? propsAny.dataPiCite) as string | undefined;
		if (typeof single === "string" && single.length > 0) {
			return <PiCiteChipBridge encoded={single} plural={false} />;
		}
		return <span {...(props as Record<string, unknown>)}>{children}</span>;
	},
};

function SourceSiteIcon({ kind }: { kind: string }) {
	const path = SOURCE_BRAND_PATHS[kind as keyof typeof SOURCE_BRAND_PATHS];
	const className = "mr-1.5 inline-block size-[0.95em] align-[-0.12em] text-[var(--ink-faint)]";
	return path
		? <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}><path d={path} /></svg>
		: <Globe aria-hidden strokeWidth={1.75} className={className} />;
}

const COMPONENTS_DOCUMENT = {
	...COMMON_HANDLERS,
	code({ className, children, ...props }: { className?: string; children?: ReactNode; node?: { position?: { start?: { line?: number }; end?: { line?: number } } } }) {
		const inline = !className;
		const lang = /language-(\w+)/.exec(className || "")?.[1];
		const source = String(children).replace(/\n$/, "");
		if (inline) return <MarkdownInlineCode>{children}</MarkdownInlineCode>;
		return dispatchBlockCode(lang, source, props.node?.position, "full");
	},
	// Unwrap react-markdown's default <pre> wrapper. CodeBlock / DiffBlock /
	// MermaidBlock / MarkdownJsonBlock / MarkdownLatexBlock all bring their own
	// chrome (border, rounded, padding); without this the AST `pre > code` ends
	// up as `<pre><div data-md-block-type=code>...</div></pre>`, which is
	// invalid HTML and double-styles in document mode (the [&_pre]: bg/border
	// rules in MD_CLASSES_DOCUMENT stack on top of the inner block's chrome).
	pre({ children }: { children?: ReactNode }) {
		return <>{children}</>;
	},
	table({ children }: { children?: ReactNode }) {
		return (
			<div className="md-table-wrap my-4 overflow-x-auto rounded-[6px] border border-[var(--border)]">
				<table className="md-table min-w-full text-sm">{children}</table>
			</div>
		);
	},
	thead({ children }: { children?: ReactNode }) {
		return (
			<thead className="bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] border-b border-[var(--border)]">
				{children}
			</thead>
		);
	},
	tbody({ children }: { children?: ReactNode }) {
		return <tbody>{children}</tbody>;
	},
	th({ children }: { children?: ReactNode }) {
		return <th className="text-left py-3 px-4 font-semibold">{children}</th>;
	},
	td({ children }: { children?: ReactNode }) {
		return (
			<td className="py-3 px-4 border-t border-[color-mix(in_oklch,var(--border)_60%,transparent)]">
				{children}
			</td>
		);
	},
	tr({ children, node }: { children?: ReactNode; node?: NodeWithPosition }) {
		return (
			<tr
				className="hover:bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] transition-colors"
				{...mdBlockAttrs(node)}
			>
				{children}
			</tr>
		);
	},
};

const COMPONENTS_CHAT = {
	...COMMON_HANDLERS,
	code({ className, children, ...props }: { className?: string; children?: ReactNode; node?: { position?: { start?: { line?: number }; end?: { line?: number } } } }) {
		const inline = !className;
		const lang = /language-(\w+)/.exec(className || "")?.[1];
		const source = String(children).replace(/\n$/, "");
		if (inline) return <MarkdownInlineCode>{children}</MarkdownInlineCode>;
		return dispatchBlockCode(lang, source, props.node?.position, "full");
	},
	// Same unwrap as document mode — see comment there.
	pre({ children }: { children?: ReactNode }) {
		return <>{children}</>;
	},
	table({ children }: { children?: ReactNode }) {
		return (
			<div className="my-3 overflow-x-auto">
				<table className="min-w-full text-sm">{children}</table>
			</div>
		);
	},
	thead({ children }: { children?: ReactNode }) {
		return <thead className="border-b border-[var(--border)]">{children}</thead>;
	},
	th({ children }: { children?: ReactNode }) {
		return <th className="text-left py-2 px-3 font-semibold text-[var(--muted-foreground)]">{children}</th>;
	},
	td({ children }: { children?: ReactNode }) {
		return (
			<td className="py-2 px-3 border-b border-[color-mix(in_oklch,var(--border)_50%,transparent)]">
				{children}
			</td>
		);
	},
	tr({ children, node }: { children?: ReactNode; node?: NodeWithPosition }) {
		return (
			<tr
				className="hover:bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] transition-colors"
				{...mdBlockAttrs(node)}
			>
				{children}
			</tr>
		);
	},
};

const COMPONENTS_TERMINAL = {
	...COMMON_HANDLERS,
	code({ className, children, ...props }: { className?: string; children?: ReactNode; node?: { position?: { start?: { line?: number }; end?: { line?: number } } } }) {
		const inline = !className;
		if (inline) {
			return <code className="font-mono">{children}</code>;
		}
		const lang = /language-(\w+)/.exec(className || "")?.[1];
		const source = String(children).replace(/\n$/, "");
		// Terminal mode: skip shiki, render raw monospace via CodeBlock terminal.
		return dispatchBlockCode(lang, source, props.node?.position, "terminal");
	},
	pre({ children }: { children?: ReactNode }) {
		return <>{children}</>;
	},
};

function getComponents(mode: MarkdownMode) {
	if (mode === "chat") return COMPONENTS_CHAT;
	if (mode === "terminal") return COMPONENTS_TERMINAL;
	return COMPONENTS_DOCUMENT;
}

/**
 * Render a single markdown fragment via react-markdown with the project's
 * custom code/link plugins. Pulled out of MarkdownView so we can wrap it
 * in React.memo and re-use the exact same renderer for both:
 *   - the whole-document path (non-streaming), and
 *   - per-block path (streaming, where each completed block is memoized
 *     by content hash).
 */
function renderMarkdown(text: string, mode: MarkdownMode): ReactNode {
	return (
		<ReactMarkdown
			remarkPlugins={remarkPluginsForMode(mode) as never}
			rehypePlugins={REHYPE_PLUGINS as never}
			components={getComponents(mode) as never}
			urlTransform={markdownUrlTransform}
		>
			{text}
		</ReactMarkdown>
	);
}

/**
 * Memoized per-block renderer. Identity is the `content` string + `mode` —
 * completed blocks get a content-hash key in the parent so React reuses the
 * same memoized instance across renders. Click handlers flow through
 * `LinkClickContext`, so updating callbacks does not invalidate MemoBlock.
 */
const MemoBlock = memo(
	function MemoBlock({ content, mode }: { content: string; mode: MarkdownMode }) {
		return <>{renderMarkdown(content, mode)}</>;
	},
	(prev, next) => prev.content === next.content && prev.mode === next.mode,
);
MemoBlock.displayName = "MemoBlock";

/**
 * Keep document parsing behind its own memo boundary. MarkdownView consumes
 * LinkClickContext, so context updates may legitimately re-render that wrapper;
 * they must not re-run react-markdown for an unchanged document.
 */
const MemoMarkdownBody = memo(
	function MemoMarkdownBody({
		content,
		mode,
		className,
	}: {
		content: string;
		mode: MarkdownMode;
		className: string;
	}) {
		return <div className={className}>{renderMarkdown(content, mode)}</div>;
	},
	(prev, next) =>
		prev.content === next.content && prev.mode === next.mode && prev.className === next.className,
);
MemoMarkdownBody.displayName = "MemoMarkdownBody";

export interface MarkdownViewProps {
	text: string;
	/**
	 * Render mode controlling formatting density.
	 *
	 * - `document` (default): rich typography for skills / memory / overlays
	 * - `chat`: compact spacing + linkify-by-default for streamed agent replies
	 * - `terminal`: raw monospace, no shiki, control chars visible
	 */
	mode?: MarkdownMode;
	/**
	 * Stream-aware fast path. When true, splits content into paragraph + code
	 * blocks and memoizes completed blocks by content hash so only the tail
	 * block re-renders as new tokens arrive.
	 */
	isStreaming?: boolean;
	/** Extra className appended to the markdown container. */
	className?: string;
	/** Called with a URL string when a non-file link is clicked. */
	onUrlClick?: (url: string) => void;
	/**
	 * Called with a filesystem path when a file-shaped link is clicked.
	 * File citation chips pass the line number; plain markdown links pass `undefined`.
	 */
	onFileClick?: (path: string, line?: number) => void;
	/**
	 * Convert raw URLs and file paths in plain text to markdown links before
	 * rendering. Defaults to `true` for `chat` mode, `false` otherwise.
	 */
	linkify?: boolean;
	/**
	 * 显式覆盖 LinkClickContext 中的 goalId —— 在独立挂载场景(没有外层 chat
	 * context 提供 goalId)下,把当前 goal 透给 PiCiteChip,启用 file-slice 预览。
	 */
	goalId?: string | null;
	/** Current artifact path. Research report citations use it for Source previews. */
	artifactName?: string;
	/**
	 * 当前 markdown 块归属的 message id —— chat 内引用 Source 预览据此定位消息。
	 * 不通过 outer context 透传,因为 ChatPage 这一层不知道具体 message,
	 * 所以由 ResponseCard / TurnCard 这种"知道 message 的容器"直接传给本组件。
	 */
	messageId?: string;
}

export const MarkdownView = memo(function MarkdownView({
	text,
	mode = "document",
	isStreaming = false,
	className,
	onUrlClick,
	onFileClick,
	linkify,
	goalId,
	artifactName,
	messageId,
}: MarkdownViewProps) {
	const shouldLinkify = linkify ?? mode === "chat";

	const processedText = useMemo(() => {
		if (mode === "terminal") return text;
		return shouldLinkify ? preprocessLinks(text) : text;
	}, [text, shouldLinkify, mode]);

	// Chat-mode 永远走块级 memo — 完成的 turn 仍然能复用 fiber,即使外层
	// TurnCard memo 因 activities 数组每帧新引用而失效,内部 markdown 块按
	// content-hash key 命中 React 复用,不重新过 remark/rehype/shiki。
	// 块级 memo 在 chat mode 始终启用。
	const splitBlocks = isStreaming || mode === "chat";

	// Hooks must run unconditionally → compute blocks (or empty array) every render.
	const blocks = useMemo(
		() => (splitBlocks ? splitIntoBlocks(processedText) : []),
		[processedText, splitBlocks],
	);

	// Read any ambient handlers provided by an outer component tree (e.g.
	// ChatPage's chatDockRef) so callers don't have to thread props through
	// MessageList → TurnCard → MarkdownView. Explicit props still win.
	const outerCtx = useContext(LinkClickContext);
	const ctxValue = useMemo<LinkClickContextValue>(
		() => ({
			onUrlClick: onUrlClick ?? outerCtx?.onUrlClick,
			onFileClick: onFileClick ?? outerCtx?.onFileClick,
			resolveFileUrl: outerCtx?.resolveFileUrl,
			goalId: goalId ?? outerCtx?.goalId,
			artifactName: artifactName ?? outerCtx?.artifactName,
			// messageId 永远以 props 为准 —— 每条 message 的归属 id 必须由当前
			// MarkdownView 自己声明,不从 outer ctx 串台。
			messageId: messageId ?? outerCtx?.messageId,
		}),
		[onUrlClick, onFileClick, goalId, artifactName, messageId, outerCtx],
	);

	if (!text) return null;

	const containerClass = cn(classesForMode(mode), className);

	const body = !splitBlocks ? (
		<MemoMarkdownBody content={processedText} mode={mode} className={containerClass} />
	) : (
		<div className={containerClass}>
			{blocks.map((block, i) => {
				const isLastBlock = i === blocks.length - 1;
				// 流式时:最后一块用 positional key,允许 token 增长重渲染。
				// 非流式时:所有块都用 content-hash + index key —— hash 保证内容稳定
				// 时 memo 命中,index 后缀避免同一 MarkdownView 内重复内容产生
				// React duplicate-key 警告(只用 hash 时,聊天面板里跨气泡
				// 多 MarkdownView 实例叠加易触发冲突)。
				const key = isLastBlock && isStreaming
					? `active-${i}`
					: `block-${i}-${simpleHash(block.content)}`;
				return <MemoBlock key={key} content={block.content} mode={mode} />;
			})}
		</div>
	);

	return (
		<LinkClickContext.Provider value={ctxValue}>
			{body}
		</LinkClickContext.Provider>
	);
});

MarkdownView.displayName = "MarkdownView";
