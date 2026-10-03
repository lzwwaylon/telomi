import { formatRelativeTime } from "@/shared/lib/format";
import { useNow } from "@/shared/hooks/useNow";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ExternalLink, FileText, Undo2 } from "lucide-react";
import { CompassIcon as Compass, ChatIcon as MessageCircle, CloseIcon as X } from "@/shared/ui/icons";

import {
	type DiscoveryInboxItem,
	useDiscoveryInbox,
} from "@/features/goals/data/useDiscoveryInbox";
import { uiText } from "@/app/ui-text";

const COLLAPSED_ITEM_LIMIT = 5;

export function DiscoveryInboxList({ goalId, items, decidingId, onIgnore }: {
	goalId: string;
	items: DiscoveryInboxItem[];
	decidingId: string | null;
	onIgnore: (item: DiscoveryInboxItem) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const listId = useId();
	const listRef = useRef<HTMLDivElement>(null);
	const now = useNow();
	const hasOverflow = items.length > COLLAPSED_ITEM_LIMIT;
	const visibleItems = expanded ? items : items.slice(0, COLLAPSED_ITEM_LIMIT);

	return <>
		<div className="goal-discovery-list" id={listId} ref={listRef}>
			{visibleItems.map((item, index) => (
				<details className="goal-discovery-item" key={item.id}>
					<summary>
						<span className="goal-discovery-number">{String(index + 1).padStart(2, "0")}</span>
						<span className="goal-discovery-copy">
							<strong>{item.finding}</strong>
							<span className="goal-discovery-sources">
								{item.sources?.length ? item.sources.map((source) => {
									let url: URL | undefined;
									try {
										const parsed = new URL(source.url ?? "");
										if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed;
									} catch { /* Local and unavailable Sources have no external link. */ }
									const content = <><FileText size={12} aria-hidden /><span className="goal-discovery-source-title">{source.title}</span><span className="goal-discovery-source-host">{url?.hostname.replace(/^www\./u, "") ?? uiText("goals.goaldiscoveryinbox.localSource")}</span>{url ? <ExternalLink size={11} aria-hidden /> : null}</>;
									return url ? <a key={source.id} className="goal-discovery-source" href={url.href} title={`${source.title}\n${url.href}`} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>{content}</a>
										: <span key={source.id} className="goal-discovery-source" title={source.title}>{content}</span>;
								}) : <span className="goal-discovery-source-unavailable">{uiText("goals.goaldiscoveryinbox.sourceUnavailable")}</span>}
							</span>
							<small>{uiText("goals.goaldiscoveryinbox.countEvidenceItems", { count: item.evidence.length })} · {formatRelativeTime(item.updated_at ?? item.created_at, undefined, now)}</small>
						</span>
						<ChevronDown className="goal-discovery-chevron" size={14} aria-hidden />
					</summary>
					<div className="goal-discovery-detail">
						<p><strong>{item.cue}</strong>：{item.note}</p>
						<div className="goal-discovery-actions">
							<a href={`/chat/${encodeURIComponent(goalId)}#discovery-${encodeURIComponent(item.id)}`}><MessageCircle size={13} />{uiText("goals.goaldiscoveryinbox.discussWithTheMainAgent")}</a>
							<button type="button" disabled={Boolean(decidingId)} onClick={() => onIgnore(item)}><X size={13} />{decidingId === item.id ? uiText("turnCard.processing") : uiText("goals.goaldiscoveryinbox.dismiss")}</button>
						</div>
					</div>
				</details>
			))}
		</div>
		{hasOverflow ? <button type="button" className="goal-discovery-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => {
			if (expanded) {
				listRef.current?.parentElement?.scrollIntoView({ block: "start" });
				listRef.current?.querySelector("summary")?.focus({ preventScroll: true });
			}
			setExpanded(!expanded);
		}}><ChevronDown size={14} aria-hidden />{expanded ? uiText("goals.goaldiscoveryinbox.collapse") : uiText("goals.goaldiscoveryinbox.showMore", { count: items.length - COLLAPSED_ITEM_LIMIT })}</button> : null}
	</>;
}

export function GoalDiscoveryInbox({ goalId }: { goalId: string }) {
	const { items, loading, error, decidingId, ignore, reopen } = useDiscoveryInbox(goalId);
	const [ignored, setIgnored] = useState<DiscoveryInboxItem | null>(null);
	useEffect(() => {
		if (!ignored) return;
		const timeout = window.setTimeout(() => setIgnored(null), 8_000);
		return () => window.clearTimeout(timeout);
	}, [ignored]);
	if (loading && items.length === 0) return null;
	if (!error && items.length === 0 && !ignored) return null;

	return (
		<section className="goal-discovery-inbox" data-testid="goal-discovery-inbox" aria-label={uiText("goals.goaldiscoveryinbox.discoveryInbox")}>
			{items.length > 0 ? <>
				<header className="goal-discovery-head">
					<div><Compass size={14} aria-hidden /><h2 id="goal-discovery-title">{uiText("goals.goaldiscoveryinbox.discoveryInbox")}</h2></div>
					<span>{uiText("goals.goaldiscoveryinbox.countPending", { count: items.length })}</span>
				</header>
				<DiscoveryInboxList key={goalId} goalId={goalId} items={items} decidingId={decidingId} onIgnore={(item) => {
					void ignore(item).then((ok) => { if (ok) setIgnored(item); });
				}} />
			</> : null}
			{error ? <p className="goal-discovery-error" role="alert">{uiText("goals.goaldiscoveryinbox.failedToLoadDiscovery")} {error}</p> : null}
			{ignored ? <div className="goal-discovery-undo" role="status"><span>{uiText("goals.goaldiscoveryinbox.dismissedFinding", { finding: ignored.finding })}</span><button type="button" onClick={() => void reopen(ignored.id).then((ok) => {
				if (ok) setIgnored(null);
			})}><Undo2 size={12} />{uiText("goals.goaldiscoveryinbox.undo")}</button></div> : null}
		</section>
	);
}
