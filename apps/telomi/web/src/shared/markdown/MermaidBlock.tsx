import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { uiText } from "@/app/ui-text";

const MIN_READABLE_HEIGHT = 280;
const FADE_SIZE = 32;
const SMALL_OVERFLOW_THRESHOLD = 200;

function parseSvgDimensions(svg: string): { width: number; height: number } | null {
	const w = svg.match(/width="(\d+(?:\.\d+)?)"/);
	const h = svg.match(/height="(\d+(?:\.\d+)?)"/);
	if (!w?.[1] || !h?.[1]) return null;
	return { width: parseFloat(w[1]), height: parseFloat(h[1]) };
}

interface ScaledDims {
	scale: number;
	width?: number;
	height?: number;
	needsScroll: boolean;
}

export function MermaidBlock({ source }: { source: string }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [containerWidth, setContainerWidth] = useState(0);
	const [rendered, setRendered] = useState<{ svg: string | null; error: Error | null; loading: boolean }>({ svg: null, error: null, loading: true });
	const { svg, error, loading } = rendered;

	useEffect(() => {
		let cancelled = false;
		setRendered({ svg: null, error: null, loading: true });
		void import("beautiful-mermaid").then(({ renderMermaidSVG }) => {
			try {
				const nextSvg = renderMermaidSVG(source, {
					bg: "var(--background)",
					fg: "var(--foreground)",
					accent: "var(--accent)",
					line: "var(--foreground-30)",
					muted: "var(--muted-foreground)",
					surface: "var(--foreground-3)",
					border: "var(--foreground-20)",
					transparent: true,
					interactive: true,
				});
				if (!cancelled) setRendered({ svg: nextSvg, error: null, loading: false });
			} catch (err) {
				if (!cancelled) setRendered({ svg: null, error: err instanceof Error ? err : new Error(String(err)), loading: false });
			}
		}).catch((err) => {
			if (!cancelled) setRendered({ svg: null, error: err instanceof Error ? err : new Error(String(err)), loading: false });
		});
		return () => { cancelled = true; };
	}, [source]);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el) setContainerWidth(el.clientWidth);
	}, [svg]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const scaledDims = useMemo<ScaledDims | null>(() => {
		if (!svg || !containerWidth) return null;
		const dims = parseSvgDimensions(svg);
		if (!dims) return null;
		const fitScale = containerWidth / dims.width;
		const projectedHeight = dims.height * fitScale;
		if (projectedHeight >= MIN_READABLE_HEIGHT) {
			const overflow = dims.width - containerWidth;
			if (overflow > 0 && overflow < SMALL_OVERFLOW_THRESHOLD) {
				return { scale: fitScale, width: containerWidth, height: dims.height * fitScale, needsScroll: false };
			}
			return {
				scale: 1,
				width: overflow > 0 ? dims.width : undefined,
				height: overflow > 0 ? dims.height : undefined,
				needsScroll: overflow > 0,
			};
		}
		const desired = MIN_READABLE_HEIGHT / dims.height;
		const scale = Math.min(desired, 1);
		const sw = dims.width * scale;
		const sh = dims.height * scale;
		const so = sw - containerWidth;
		if (so > 0 && so < SMALL_OVERFLOW_THRESHOLD) {
			const fs = containerWidth / dims.width;
			return { scale: fs, width: containerWidth, height: dims.height * fs, needsScroll: false };
		}
		return { scale, width: sw, height: sh, needsScroll: so > 0 };
	}, [svg, containerWidth]);

	if (loading) {
		return <div className="rounded-[8px] border border-[var(--border)] bg-[var(--paper-2)] p-3 text-[0.8rem] text-[var(--foreground-50)]">{uiText("markdown.mermaidblock.renderingMermaid")}</div>;
	}

	if (error || !svg) {
		return (
			<div className="rounded-[8px] border border-[color-mix(in_oklab,var(--destructive)_22%,var(--border))] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] p-2 text-[0.8rem] text-[color-mix(in_oklab,var(--destructive)_70%,var(--foreground))]">
				{uiText("markdown.mermaidblock.mermaidRenderingFailed")} {error?.message ?? uiText("markdown.mermaidblock.renderingError")}
				<pre className="mt-1.5 mb-0 text-[var(--foreground-50)]">{source}</pre>
			</div>
		);
	}

	const needsScaling = scaledDims != null && (scaledDims.width != null || scaledDims.scale !== 1);
	const maskImage = scaledDims?.needsScroll
		? `linear-gradient(to right, transparent 0%, black ${FADE_SIZE}px, black calc(100% - ${FADE_SIZE}px), transparent 100%)`
		: undefined;

	return (
		<div className="rounded-[8px] border border-[var(--border)] bg-[color-mix(in_oklch,var(--muted)_30%,var(--background))] p-2">
			<div
				ref={scrollRef}
				style={{
					overflowX: "auto",
					overflowY: "hidden",
					maskImage,
					WebkitMaskImage: maskImage,
				}}
			>
				<div
					style={{
						width: needsScaling && scaledDims?.width ? `${scaledDims.width}px` : undefined,
						height: needsScaling && scaledDims?.height ? `${scaledDims.height}px` : undefined,
						display: needsScaling ? "block" : "flex",
						justifyContent: needsScaling ? undefined : "center",
						margin: needsScaling && !scaledDims?.needsScroll ? "0 auto" : undefined,
					}}
				>
					<div
						dangerouslySetInnerHTML={{ __html: svg }}
						style={{
							transformOrigin: "top left",
							transform: scaledDims && scaledDims.scale !== 1 ? `scale(${scaledDims.scale})` : undefined,
						}}
					/>
				</div>
			</div>
		</div>
	);
}
