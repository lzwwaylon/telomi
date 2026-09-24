import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { uiText } from "@/app/ui-text";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
	"pdfjs-dist/build/pdf.worker.min.mjs",
	import.meta.url,
).toString();

// Wide panes stop growing the page so long lines stay readable; narrow panes,
// such as the chat dock, get exactly the room they have.
const MAX_PAGE_WIDTH = 900;

export function PdfArtifact({ url }: { url: string }) {
	const [numPages, setNumPages] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [width, setWidth] = useState(0);
	const frameRef = useRef<HTMLDivElement>(null);

	// Pages are rasterised at a fixed pixel width, so they have to follow the
	// surface that holds them rather than the window.
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
		observer.observe(frame);
		return () => observer.disconnect();
	}, []);

	if (error) {
		return (
			<div className="rounded-[8px] border border-[color-mix(in_oklab,var(--destructive)_22%,var(--border))] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] px-2.5 py-2 text-[0.78rem] text-[color-mix(in_oklab,var(--destructive)_70%,var(--foreground))]">
				{uiText("artifacts.pdfartifact.failedToLoadPdf")} {error}
			</div>
		);
	}

	return (
		<div
			ref={frameRef}
			className="flex flex-col gap-3 overflow-auto rounded-[8px] border border-[var(--border)] bg-[color-mix(in_oklch,var(--muted)_30%,var(--background))] p-3 max-h-[800px]"
		>
			<Document
				file={url}
				onLoadSuccess={({ numPages: n }) => setNumPages(n)}
				onLoadError={(err) => setError(err instanceof Error ? err.message : String(err))}
				loading={
					<div className="italic text-[0.82rem] text-[var(--foreground-50)] py-2">
						{uiText("artifacts.pdfartifact.loadingPdf")}
					</div>
				}
			>
				{numPages && width > 0 &&
					Array.from({ length: numPages }, (_, i) => (
						<div key={`page-${i + 1}`} className="flex flex-col items-center gap-1">
							<div className="text-[0.72rem] text-[var(--foreground-50)]">
								{uiText("artifacts.pdfartifact.pagePageOfTotal", { page: i + 1, total: numPages })}
							</div>
							<Page
								pageNumber={i + 1}
								width={Math.floor(Math.min(width, MAX_PAGE_WIDTH))}
								renderAnnotationLayer={false}
								renderTextLayer={false}
							/>
						</div>
					))}
			</Document>
		</div>
	);
}
