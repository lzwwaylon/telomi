import { ChevronDown, Database, ExternalLink, Image as ImageIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EvidenceImageLightbox, type EvidenceImagePreview } from "@/shared/markdown/EvidenceImageLightbox";
import { MarkdownView } from "@/shared/markdown/MarkdownView";
import { sourceAssetHttpUrl } from "@/shared/markdown/source-asset";
import type { WikiEvidenceEntry } from "@/features/wiki/wiki-model";
import { uiText } from "@/app/ui-text";

export function WikiEvidenceDossier({ goalId, evidence, revision, onOpenSource }: { goalId: string; evidence: WikiEvidenceEntry[]; revision?: string | null; onOpenSource: (sourceId: string) => void }) {
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const [image, setImage] = useState<EvidenceImagePreview | null>(null);
	const evidenceKey = useMemo(() => evidence.map((entry) => entry.id).join("\u0001"), [evidence]);
	useEffect(() => setCollapsed(new Set()), [evidenceKey]);
	if (evidence.length === 0) return null;
	const sourceCount = new Set(evidence.map((entry) => entry.source.id)).size;
	const allCollapsed = collapsed.size === evidence.length;
	const toggle = (id: string) => setCollapsed((current) => {
		const next = new Set(current);
		next.has(id) ? next.delete(id) : next.add(id);
		return next;
	});
	return (
		<section className="wiki-evidence-dossier" aria-labelledby="wiki-evidence-title" data-testid="wiki-evidence-dossier">
			<header className="wiki-evidence-head">
				<div>
					<span>{uiText("wiki.evidencedossier.evidence")}</span>
					<h2 id="wiki-evidence-title">{uiText("wiki.evidencedossier.evidenceDossier")}</h2>
					<p>{uiText("wiki.evidencedossier.cluesCluesSourcesSources", { clues: evidence.length, sources: sourceCount })}</p>
				</div>
				<button type="button" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(evidence.map((entry) => entry.id)))}>
					{allCollapsed ? uiText("wiki.evidencedossier.expandAllSourceExcerpts") : uiText("wiki.evidencedossier.collapseAllSourceExcerpts")}
				</button>
			</header>
			<div className="wiki-evidence-list">
				{evidence.map((entry) => {
					const isCollapsed = collapsed.has(entry.id);
					return <article key={entry.id} id={`evidence-${entry.index}`} className="wiki-evidence-entry" data-testid="wiki-evidence-entry" tabIndex={-1}>
						<div className="wiki-evidence-index">E{entry.index}</div>
						<div className="wiki-evidence-entry-body">
							<div className="wiki-evidence-cue"><small>{entry.section}</small>{entry.sectionSummary ? <p>{entry.sectionSummary}</p> : null}<h3>{entry.cue}</h3></div>
							<div className="wiki-evidence-note"><MarkdownView text={entry.note} goalId={goalId} linkify={false} /></div>
							<button type="button" className="wiki-evidence-source" onClick={() => onOpenSource(entry.source.id)}>
								<Database aria-hidden /><span>{entry.source.title}</span>
							</button>
							{/^https?:/iu.test(entry.source.url) ? <a href={entry.source.url} target="_blank" rel="noreferrer" className="wiki-evidence-source" aria-label={entry.source.url}><ExternalLink aria-hidden /><span>{entry.source.url}</span></a> : null}
							<button type="button" className="wiki-evidence-toggle" aria-expanded={!isCollapsed} onClick={() => toggle(entry.id)}>
								<ChevronDown aria-hidden /><span>{isCollapsed ? uiText("wiki.evidencedossier.expandCountSourceExcerpts", { count: entry.anchors.length }) : uiText("wiki.evidencedossier.collapseSourceExcerpts")}</span>
							</button>
							{!isCollapsed ? <div className="wiki-evidence-anchors">
								{entry.anchors.map((anchor, anchorIndex) => <section key={`${anchor.path}:${anchor.startLine}:${anchor.endLine}`} className="wiki-evidence-anchor">
									<header><code>{anchor.path}</code><span>L{anchor.startLine}-{anchor.endLine}</span></header>
									{anchor.assets.map((asset) => {
									const src = sourceAssetHttpUrl(`source-asset:${asset.sourceId}/${asset.path}`, goalId, revision);
										return src ? <button type="button" key={`${asset.sourceId}:${asset.path}`} className="wiki-evidence-image" onClick={() => setImage({ src, alt: entry.cue })} aria-label={uiText("wiki.evidencedossier.enlargeEvidenceImageCue", { cue: entry.cue })}>
											<img src={src} alt={entry.cue} loading="lazy" /><span><ImageIcon aria-hidden />{uiText("wiki.evidencedossier.viewOriginalImage")}</span>
										</button> : null;
									})}
									{anchor.format === "markdown"
										? <MarkdownView text={anchor.content} goalId={goalId} linkify={false} className="wiki-evidence-markdown" />
										: <pre>{anchor.content}</pre>}
									{anchorIndex < entry.anchors.length - 1 ? <hr /> : null}
								</section>)}
							</div> : null}
						</div>
					</article>;
				})}
			</div>
			<EvidenceImageLightbox image={image} onClose={() => setImage(null)} />
		</section>
	);
}
