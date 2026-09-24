import { apiClient } from "@/shared/lib/api-client";
import { Database } from "lucide-react";
import { ArrowLeftIcon as ArrowLeft } from "@/shared/ui/icons";
import { useEffect, useState } from "react";

import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { stripWikiFrontmatter } from "@/features/wiki/wiki-model";
import { uiText } from "@/app/ui-text";

interface SourceDocument {
	path: string;
	title: string;
	content: string;
	runId?: string;
}

export function WikiSourcePreview({ goalId, path, revision, onBack }: { goalId: string; path: string; revision?: string | null; onBack: () => void }) {
	const [source, setSource] = useState<SourceDocument | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		setSource(null);
		setError(null);
		const params = new URLSearchParams({ path });
		if (revision) params.set("revision", revision);
		void apiClient.get<SourceDocument>(`/api/goals/${encodeURIComponent(goalId)}/wiki/source?${params}`, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		})
			.then(setSource)
			.catch((reason) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => controller.abort();
	}, [goalId, path, revision]);

	return (
		<div className="grid h-full min-h-0" style={{ gridTemplateRows: "auto minmax(0,1fr)" }} data-testid="wiki/source-preview">
			<div className="grid grid-cols-[auto_1fr] items-center gap-2.5 border-b border-[var(--line-soft)] bg-[var(--paper-2)] px-2 py-1.5">
				<button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[12px] font-medium text-[var(--ink-mut)] hover:bg-[var(--paper)] hover:text-[var(--ink)]"><ArrowLeft className="h-3.5 w-3.5" />{uiText("wiki.sourcepreview.backToWiki")}</button>
				<span className="min-w-0 truncate font-mono text-[11px] text-[var(--ink-faint)]" title={path}>{path}</span>
			</div>
			<div className="min-h-0 overflow-y-auto bg-[var(--background)] px-5 py-5">
				{!source && !error ? <p className="text-[12px] italic text-[var(--ink-faint)]">{uiText("wiki.sourcepreview.loadingOriginalSource")}</p> : null}
				{error ? <p className="text-[12px] text-[var(--warm-deep)]" role="alert">{uiText("common.failedToLoad")} {error}</p> : null}
				{source ? <article className="mx-auto max-w-[68ch]" aria-labelledby="wiki/source-title">
					<header className="mb-5 border-b border-[var(--line)] pb-4">
						<div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--warm)]"><Database className="h-3.5 w-3.5" />{uiText("wiki.sourcepreview.originalSource")}</div>
						<h1 id="wiki/source-title" className="font-serif text-[clamp(1.25rem,2vw,1.75rem)] leading-tight text-[var(--ink)]">{source.title}</h1>
						{source.runId ? <p className="mt-2 font-mono text-[10px] text-[var(--ink-faint)]">{uiText("wiki.sourcepreview.sourceRun")} {source.runId}</p> : null}
					</header>
					<div className="text-[var(--ink)]"><MarkdownView text={stripWikiFrontmatter(source.content).replace(/^\s*#\s+.+\r?\n/u, "")} goalId={goalId} /></div>
				</article> : null}
			</div>
		</div>
	);
}
