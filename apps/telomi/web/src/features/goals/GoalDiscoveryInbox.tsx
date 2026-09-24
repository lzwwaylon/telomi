import { formatRelativeTime } from "@/shared/lib/format";
import { useNow } from "@/shared/hooks/useNow";
import { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import { CompassIcon as Compass, ChatIcon as MessageCircle, CloseIcon as X } from "@/shared/ui/icons";

import {
	type DiscoveryInboxItem,
	useDiscoveryInbox,
} from "@/features/goals/data/useDiscoveryInbox";
import { uiText } from "@/app/ui-text";

export function GoalDiscoveryInbox({ goalId }: { goalId: string }) {
	const { items, loading, error, decidingId, ignore, reopen } = useDiscoveryInbox(goalId);
	const [ignored, setIgnored] = useState<DiscoveryInboxItem | null>(null);
	const now = useNow();
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
				<div className="goal-discovery-list">
				{items.map((item, index) => (
					<details className="goal-discovery-item" key={item.id}>
						<summary>
							<span className="goal-discovery-number">{String(index + 1).padStart(2, "0")}</span>
							<span className="goal-discovery-copy">
								<strong>{item.finding}</strong>
								<small>{uiText("goals.goaldiscoveryinbox.countEvidenceItems", { count: item.evidence.length })} · {formatRelativeTime(item.updated_at ?? item.created_at, undefined, now)}</small>
							</span>
						</summary>
						<div className="goal-discovery-detail">
							<p><strong>{item.cue}</strong>：{item.note}</p>
							<div className="goal-discovery-actions">
								<a href={`/chat/${encodeURIComponent(goalId)}#discovery-${encodeURIComponent(item.id)}`}><MessageCircle size={13} />{uiText("goals.goaldiscoveryinbox.discussWithTheMainAgent")}</a>
								<button type="button" disabled={Boolean(decidingId)} onClick={() => void ignore(item).then((ok) => {
									if (ok) setIgnored(item);
								})}><X size={13} />{decidingId === item.id ? uiText("turnCard.processing") : uiText("goals.goaldiscoveryinbox.dismiss")}</button>
							</div>
						</div>
					</details>
				))}
				</div>
			</> : null}
			{error ? <p className="goal-discovery-error" role="alert">{uiText("goals.goaldiscoveryinbox.failedToLoadDiscovery")} {error}</p> : null}
			{ignored ? <div className="goal-discovery-undo" role="status"><span>{uiText("goals.goaldiscoveryinbox.dismissedFinding", { finding: ignored.finding })}</span><button type="button" onClick={() => void reopen(ignored.id).then((ok) => {
				if (ok) setIgnored(null);
			})}><Undo2 size={12} />{uiText("common.remove")}</button></div> : null}
		</section>
	);
}
