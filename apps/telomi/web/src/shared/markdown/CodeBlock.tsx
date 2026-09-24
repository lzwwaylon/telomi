import { useEffect, useRef, useState } from "react";
import type { BundledLanguage, ShikiTransformer } from "shiki";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";
import { isCurrentPaperThemeDark } from "@/shared/lib/theme";
import { uiText } from "@/app/ui-text";

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
	js: "javascript",
	ts: "typescript",
	py: "python",
	sh: "bash",
	zsh: "bash",
	yml: "yaml",
	rb: "ruby",
	rs: "rust",
	kt: "kotlin",
	"objective-c": "objc",
	objc: "objc",
};

const highlightCache = new Map<string, string>();
const CACHE_MAX_SIZE = 200;

function getCacheKey(code: string, lang: string, theme: string, lineMeta: string): string {
	return `${theme}:${lang}:${lineMeta}:${code}`;
}

function detectThemePreference(): "light" | "dark" {
	if (isCurrentPaperThemeDark()) return "dark";
	if (document.documentElement.classList.contains("light")) return "light";
	const prefers = window.matchMedia("(prefers-color-scheme: dark)").matches;
	return prefers ? "dark" : "light";
}

export interface CodeBlockProps {
	code: string;
	language?: string;
	/**
	 * Render mode affects code block styling:
	 * - 'terminal': Minimal raw monospace, keeps control chars visible (no shiki)
	 * - 'minimal': Just syntax highlighting, no chrome
	 * - 'full': Rich styling with header, language label, and copy button
	 */
	mode?: "terminal" | "minimal" | "full";
	/**
	 * Force a specific theme. If not provided, detects via detectThemePreference().
	 */
	forcedTheme?: "light" | "dark";
	/**
	 * Extra className appended to the root element of the chosen mode.
	 */
	className?: string;
	/**
	 * Show a gutter with line numbers.
	 */
	showLineNumbers?: boolean;
	/**
	 * 1-indexed line to highlight. The shiki transformer adds `cb-line-highlight`
	 * + `data-line=N` so CSS can paint the row, and the post-render effect
	 * scrolls it into view when {@link scrollToHighlight} is set.
	 */
	highlightLine?: number;
	/**
	 * Auto-scroll the highlighted line into the viewport on mount/update.
	 */
	scrollToHighlight?: boolean;
	/**
	 * Soft-wrap long lines in `full` mode instead of scrolling sideways; suits output and data more than source.
	 */
	wrap?: boolean;
}

const SHIKI_PRE_RESET =
	"[&_pre]:!m-0 [&_pre]:!border-0 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!whitespace-pre [&_pre]:!text-[inherit]";
const SHIKI_CODE_RESET =
	"[&_code]:!bg-transparent [&_code]:!p-0 [&_code]:!text-[inherit] [&_code]:!font-[inherit]";

const RAW_PRE_CLASSES =
	"m-0 border-0 bg-transparent p-0 font-[inherit] text-[inherit] whitespace-pre text-[var(--foreground)]";

/**
 * Tag every shiki line span with `data-line` and (when highlighted) the
 * `cb-line-highlight` class. The actual paint is CSS-only — see
 * `LINE_META_STYLES` further down.
 */
function buildLineMetaTransformer(highlightLine?: number): ShikiTransformer {
	return {
		name: "pi-line-meta",
		line(node, lineNum) {
			const props = (node.properties ??= {});
			props["data-line"] = String(lineNum);
			if (highlightLine && lineNum === highlightLine) {
				const cls = typeof props.class === "string" ? props.class : "";
				props.class = cls ? `${cls} cb-line-highlight` : "cb-line-highlight";
			}
		},
	};
}

const LINE_META_STYLES = `
.cb-with-line-numbers .line {
	display: inline-block;
	width: 100%;
	counter-increment: cb-line;
	position: relative;
	padding-left: 3em;
}
.cb-with-line-numbers .line::before {
	content: counter(cb-line);
	position: absolute;
	left: 0;
	width: 2.5em;
	padding-right: 0.75em;
	text-align: right;
	color: var(--ink-faint, var(--muted-foreground));
	opacity: 0.55;
	user-select: none;
	font-variant-numeric: tabular-nums;
}
.cb-line-highlight {
	background: color-mix(in oklch, var(--accent, #2563eb) 14%, transparent);
	box-shadow: inset 2px 0 0 0 var(--accent, #2563eb);
	scroll-margin-block: 80px;
}
`;

let lineMetaStyleInjected = false;
function ensureLineMetaStyleInjected() {
	if (lineMetaStyleInjected || typeof document === "undefined") return;
	const id = "pi-codeblock-line-meta";
	if (document.getElementById(id)) {
		lineMetaStyleInjected = true;
		return;
	}
	const el = document.createElement("style");
	el.id = id;
	el.textContent = LINE_META_STYLES;
	document.head.appendChild(el);
	lineMetaStyleInjected = true;
}

export function CodeBlock({
	code,
	language = "text",
	mode = "full",
	forcedTheme,
	className,
	showLineNumbers,
	highlightLine,
	scrollToHighlight,
	wrap = false,
}: CodeBlockProps) {
	const [highlighted, setHighlighted] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [copied, setCopied] = useState(false);
	const cancelRef = useRef(false);
	const bodyRef = useRef<HTMLDivElement | null>(null);

	const langLower = language.toLowerCase();
	const resolvedLang: string = LANGUAGE_ALIASES[langLower] || langLower;

	// Inject the line-meta CSS once on first render that needs it. Cheap; idempotent.
	useEffect(() => {
		if (showLineNumbers || highlightLine != null) ensureLineMetaStyleInjected();
	}, [showLineNumbers, highlightLine]);

	useEffect(() => {
		cancelRef.current = false;
		const themeMode = forcedTheme ?? detectThemePreference();
		const theme = themeMode === "dark" ? "github-dark" : "github-light";
		const lineMeta = `${showLineNumbers ? "ln" : "_"}:${highlightLine ?? 0}`;
		const cacheKey = getCacheKey(code, resolvedLang, theme, lineMeta);

		const cached = highlightCache.get(cacheKey);
		if (cached) {
			setHighlighted(cached);
			setIsLoading(false);
			return;
		}

		(async () => {
			try {
				const shiki = await import("shiki");
				const lang = resolvedLang in shiki.bundledLanguages ? resolvedLang as BundledLanguage : "text";
				const transformers: ShikiTransformer[] =
					showLineNumbers || highlightLine != null
						? [buildLineMetaTransformer(highlightLine)]
						: [];
				const html = await shiki.codeToHtml(code, { lang, theme, transformers });
				if (cancelRef.current) return;
				if (highlightCache.size >= CACHE_MAX_SIZE) {
					const firstKey = highlightCache.keys().next().value;
					if (firstKey) highlightCache.delete(firstKey);
				}
				highlightCache.set(cacheKey, html);
				setHighlighted(html);
				setIsLoading(false);
			} catch (err) {
				console.warn(`shiki failed for "${resolvedLang}":`, err);
				if (!cancelRef.current) {
					setHighlighted(null);
					setIsLoading(false);
				}
			}
		})();

		return () => {
			cancelRef.current = true;
		};
	}, [code, resolvedLang, forcedTheme, showLineNumbers, highlightLine]);

	// After render, scroll the highlighted line into view (if requested).
	useEffect(() => {
		if (!scrollToHighlight || !highlightLine || !highlighted) return;
		const el = bodyRef.current?.querySelector(`[data-line="${highlightLine}"]`) as
			| HTMLElement
			| null;
		if (!el) return;
		// rAF lets the browser commit layout before we measure scroll target
		const id = window.requestAnimationFrame(() => {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
		});
		return () => window.cancelAnimationFrame(id);
	}, [highlighted, highlightLine, scrollToHighlight]);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			console.error("copy failed", err);
		}
	};

	if (mode === "terminal") {
		// Raw monospace, no shiki, no chrome. Keeps control chars visible.
		return (
			<pre className={cn(RAW_PRE_CLASSES, "font-mono text-sm whitespace-pre-wrap", className)}>
				<code>{code}</code>
			</pre>
		);
	}

	const lineNumberClass = showLineNumbers ? "cb-with-line-numbers" : undefined;

	if (mode === "minimal") {
		if (isLoading || !highlighted) {
			return (
				<pre className={cn(RAW_PRE_CLASSES, className)}>
					<code>{code}</code>
				</pre>
			);
		}
		return (
			<div
				ref={bodyRef}
				className={cn(SHIKI_PRE_RESET, SHIKI_CODE_RESET, lineNumberClass, className)}
				dangerouslySetInnerHTML={{ __html: highlighted }}
			/>
		);
	}

	return (
		<div
			className={cn(
				"group relative my-2 overflow-hidden rounded-[8px] border border-[var(--border)] bg-[color-mix(in_oklch,var(--muted)_30%,var(--background))]",
				className,
			)}
		>
			<div className="flex items-center justify-between border-b border-[var(--border)] bg-[color-mix(in_oklch,var(--muted)_50%,var(--background))] px-3 py-1.5 text-xs">
				<span className="font-mono font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
					{resolvedLang !== "text" ? resolvedLang : uiText("markdown.codeblock.plainText")}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={handleCopy}
					className={cn(
						"h-auto gap-1 rounded px-1.5 py-[3px] text-[var(--muted-foreground)] opacity-0 transition-[opacity,color] duration-150 ease-out hover:bg-transparent hover:text-[var(--foreground)] focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:opacity-100 motion-reduce:transition-none",
						copied && "opacity-100 text-[var(--success)] hover:text-[var(--success)]",
					)}
					aria-label={copied ? uiText("common.copied") : uiText("common.copyCode")}
					title={copied ? uiText("common.copied") : uiText("common.copy")}
				>
					{copied ? (
						<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
							<path
								d="M3.5 8.5l3 3L12.5 5"
								stroke="currentColor"
								strokeWidth="1.6"
								fill="none"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					) : (
						<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
							<rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
							<rect x="2.5" y="2.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
						</svg>
					)}
				</Button>
			</div>
			<div
				ref={bodyRef}
				className={cn("p-3 font-mono text-sm leading-[1.5]", wrap ? "overflow-x-hidden [overflow-wrap:anywhere]" : "overflow-x-auto")}
			>
				{isLoading || !highlighted ? (
					<pre className={cn(RAW_PRE_CLASSES, wrap && "whitespace-pre-wrap")}>
						<code>{code}</code>
					</pre>
				) : (
					<div
						className={cn(SHIKI_PRE_RESET, SHIKI_CODE_RESET, lineNumberClass, wrap && "[&_pre]:!whitespace-pre-wrap")}
						dangerouslySetInnerHTML={{ __html: highlighted }}
					/>
				)}
			</div>
		</div>
	);
}

export function InlineCode({ children }: { children: React.ReactNode }) {
	return (
		<code className="rounded bg-[var(--foreground-5)] px-1 py-0 font-mono text-[13px] text-[var(--foreground)]">
			{children}
		</code>
	);
}
