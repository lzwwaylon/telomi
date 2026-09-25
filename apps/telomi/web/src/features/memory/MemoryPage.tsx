import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, PanelLeftClose, RotateCcw, Trash2 } from "lucide-react";
import { apiClient, ApiError } from "@/shared/lib/api-client";
import { formatDate, formatRelativeTime } from "@/shared/lib/format";
import { CloseIcon as X, MemoryIcon, PencilIcon, SearchIcon as Search } from "@/shared/ui/icons";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
	USER_MEMORY_UNAVAILABLE,
	type MemoryEpisodeView,
	type MemoryFactView,
	type UserMemoryResponse,
} from "@shared/user-memory";
import "@/features/memory/memory.css";

type MemoryView = "active" | "invalidated";

const SOURCE_LABEL = {
	message: "memory.source.message",
	topic_plan: "memory.source.topic_plan",
	schedule_proposal: "memory.source.schedule_proposal",
	other: "memory.source.other",
} as const;

/** Retention follows the reply by a few seconds; the page checks again while an Episode waits. */
const WAITING_REFRESH_MS = 4_000;

/**
 * What User Memory holds for this Goal and globally: each thing the user said with the Memory Facts
 * extracted from it. The user curates here; Agents only read memory through recall.
 */
export function MemoryPage({ goalId, goalTitle, onBack }: { goalId: string; goalTitle: string; onBack: () => void }) {
	const { t } = useTranslation();
	const [memory, setMemory] = useState<UserMemoryResponse | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [view, setView] = useState<MemoryView>("active");
	const [query, setQuery] = useState("");
	// The target outlives `deleteOpen` so the dialog keeps its wording while it closes.
	const [deleteTarget, setDeleteTarget] = useState<MemoryEpisodeView | null>(null);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const base = `/api/goals/${encodeURIComponent(goalId)}/memory`;

	const load = useCallback(async () => {
		try {
			setMemory(await apiClient.get<UserMemoryResponse>(base));
			setFailure(null);
		} catch (error) {
			setFailure(error instanceof ApiError && error.status === 503 && error.message === USER_MEMORY_UNAVAILABLE
				? t("memory.unavailable")
				: error instanceof Error ? error.message : String(error));
		}
	}, [base, t]);

	useEffect(() => { void load(); }, [load]);

	const waiting = memory ? [...memory.goal, ...memory.global].some((episode) => episode.status === "waiting") : false;
	useEffect(() => {
		if (!waiting) return;
		const timer = window.setTimeout(() => void load(), WAITING_REFRESH_MS);
		return () => window.clearTimeout(timer);
	}, [waiting, memory, load]);

	/** Every change reloads: Hindsight re-derives what depends on it, and the list shows its result. */
	const act = useCallback(async (change: () => Promise<unknown>) => {
		setActionError(null);
		try {
			await change();
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		}
		await load();
	}, [load]);

	const actions: EpisodeActions = useMemo(() => ({
		saveFact: (fact, text) => act(() => apiClient.patch(`${base}/facts/${encodeURIComponent(fact.id)}`, { text })),
		setInvalidated: (fact, invalidated) => act(() => apiClient.patch(`${base}/facts/${encodeURIComponent(fact.id)}`, { invalidated })),
		setGlobal: (episode, global) => act(() => apiClient.put(`${base}/episodes/${encodeURIComponent(episode.documentId)}/scope`, { global })),
		requestDelete: (episode) => { setDeleteTarget(episode); setDeleteOpen(true); },
	}), [act, base]);

	const needle = query.trim().toLowerCase();
	const emptyText = (episodes: MemoryEpisodeView[], none: string) => needle ? t("memory.noMatches")
		: view === "invalidated" ? t("memory.noneInvalidated")
			// Everything here was invalidated: saying there is no memory yet would be wrong.
			: episodes.length > 0 ? t("memory.allInvalidated") : none;
	const shown = (episodes: MemoryEpisodeView[]) => episodes.flatMap((episode) => {
		const facts = episode.facts.filter((fact) => fact.invalidated === (view === "invalidated"));
		// Active lists Episodes still being retained or with nothing extracted; invalidated only lists retired facts.
		if (facts.length === 0 && (view === "invalidated" || episode.facts.length > 0)) return [];
		if (needle && ![episode.text, ...facts.map((fact) => fact.text)].some((text) => text.toLowerCase().includes(needle))) return [];
		return [{ episode, facts }];
	});
	const all = memory ? [...memory.goal, ...memory.global] : [];
	const activeCount = all.reduce((sum, episode) => sum + episode.facts.filter((fact) => !fact.invalidated).length, 0);
	const invalidatedCount = all.reduce((sum, episode) => sum + episode.facts.filter((fact) => fact.invalidated).length, 0);

	return (
		<section className="memory-page" aria-label={t("memory.title")} data-testid="memory-page">
			<header className="memory-topbar">
				<div className="memory-brand">
					<MemoryIcon aria-hidden />
					<span className="memory-brand-divider" />
					<div><strong>{t("memory.title")}</strong><small>{goalTitle}</small></div>
				</div>
				<nav className="memory-view-tabs" aria-label={t("memory.views")}>
					<button type="button" data-active={view === "active" ? "true" : undefined} aria-current={view === "active" ? "page" : undefined} onClick={() => setView("active")}>
						{t("memory.active")}<span>{activeCount}</span>
					</button>
					<button type="button" data-active={view === "invalidated" ? "true" : undefined} aria-current={view === "invalidated" ? "page" : undefined} onClick={() => setView("invalidated")}>
						{t("memory.invalidated")}<span>{invalidatedCount}</span>
					</button>
				</nav>
				<label className="memory-search">
					<Search aria-hidden />
					<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("memory.search")} aria-label={t("memory.search")} />
					{query ? <button type="button" onClick={() => setQuery("")} aria-label={t("common.clearSearch")}><X aria-hidden /></button> : null}
				</label>
				<button type="button" className="memory-back" onClick={onBack} aria-label={t("topbar.backToGoal")} title={t("topbar.backToGoal")}><PanelLeftClose aria-hidden /></button>
			</header>

			<div className="memory-body">
				{failure ? (
					<div className="memory-state" role="alert">
						<MemoryIcon aria-hidden />
						<h2>{t("memory.unavailableTitle")}</h2>
						<p>{failure}</p>
						<button type="button" onClick={() => void load()}>{t("memory.retry")}</button>
					</div>
				) : !memory ? (
					<div className="memory-state" role="status"><p>{t("memory.loading")}</p></div>
				) : (
					<div className="memory-columns">
						<p className="memory-intro">{t("memory.intro")}</p>
						{actionError ? <p className="memory-action-error" role="alert">{actionError}</p> : null}
						<MemorySection
							title={t("memory.goalSection")}
							hint={t("memory.goalSectionHint")}
							items={shown(memory.goal)}
							empty={emptyText(memory.goal, t("memory.goalEmpty"))}
							goalId={goalId}
							view={view}
							actions={actions}
						/>
						<MemorySection
							title={t("memory.globalSection")}
							hint={t("memory.globalSectionHint")}
							items={shown(memory.global)}
							empty={emptyText(memory.global, t("memory.globalEmpty"))}
							goalId={goalId}
							view={view}
							actions={actions}
						/>
					</div>
				)}
			</div>
			<ConfirmDialog
				open={deleteOpen}
				title={t("memory.deleteTitle")}
				description={t("memory.deleteDescription", { count: deleteTarget?.facts.length ?? 0 })}
				confirmLabel={t("common.delete")}
				destructive
				onCancel={() => setDeleteOpen(false)}
				onConfirm={async () => {
					if (!deleteTarget) return;
					await apiClient.delete(`${base}/episodes/${encodeURIComponent(deleteTarget.documentId)}`);
					setDeleteOpen(false);
					await load();
				}}
				testId="memory-delete-dialog"
			/>
		</section>
	);
}

interface EpisodeActions {
	saveFact: (fact: MemoryFactView, text: string) => Promise<void>;
	setInvalidated: (fact: MemoryFactView, invalidated: boolean) => Promise<void>;
	setGlobal: (episode: MemoryEpisodeView, global: boolean) => Promise<void>;
	requestDelete: (episode: MemoryEpisodeView) => void;
}

function MemorySection({ title, hint, items, empty, goalId, view, actions }: {
	title: string;
	hint: string;
	items: Array<{ episode: MemoryEpisodeView; facts: MemoryFactView[] }>;
	empty: string;
	goalId: string;
	view: MemoryView;
	actions: EpisodeActions;
}) {
	return (
		<section className="memory-section" aria-label={title}>
			<header className="memory-section-head">
				<h2>{title}</h2>
				<span>{items.length}</span>
				<p>{hint}</p>
			</header>
			{items.length === 0
				? <p className="memory-empty">{empty}</p>
				: items.map(({ episode, facts }) => <MemoryEpisode key={episode.documentId} episode={episode} facts={facts} goalId={goalId} view={view} actions={actions} />)}
		</section>
	);
}

function MemoryEpisode({ episode, facts, goalId, view, actions }: {
	episode: MemoryEpisodeView;
	facts: MemoryFactView[];
	goalId: string;
	view: MemoryView;
	actions: EpisodeActions;
}) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const origin = episode.goalId === goalId ? null
		: episode.goalId ? t("memory.fromGoal", { title: episode.goalTitle ?? episode.goalId }) : t("memory.fromNoGoal");
	const status = episode.status === "waiting" ? t("memory.statusWaiting")
		: episode.status === "failed" ? t("memory.statusFailed")
			: episode.facts.length === 0 ? t("memory.statusNothing") : t("memory.statusRetained", { count: episode.facts.length });
	const long = episode.text.length > 280;
	const run = async (change: () => Promise<void>) => {
		setBusy(true);
		try { await change(); } finally { setBusy(false); }
	};

	return (
		<article className="memory-episode" data-status={episode.status} data-testid="memory-episode" aria-busy={busy || undefined}>
			<header className="memory-episode-head">
				<span className="memory-source">{t(SOURCE_LABEL[episode.source])}</span>
				<time dateTime={episode.occurredAt} title={formatDate(episode.occurredAt, { dateStyle: "medium", timeStyle: "short" })}>{formatRelativeTime(episode.occurredAt)}</time>
				{origin ? <span className="memory-origin">{origin}</span> : null}
				<span className="memory-status" data-status={episode.status} data-empty={episode.status === "retained" && episode.facts.length === 0 ? "true" : undefined}>{status}</span>
				{episode.status === "retained" ? (
					<span className="memory-episode-actions">
						{/* An Episode without a Goal (its Goal was deleted) has nowhere to return to; it stays global or goes. */}
						{view === "invalidated" || (episode.global && !episode.goalId) ? null : (
							<button type="button" disabled={busy} onClick={() => void run(() => actions.setGlobal(episode, !episode.global))} data-testid="memory-toggle-global">
								<Globe aria-hidden />{episode.global ? t("memory.makeGoalOnly") : t("memory.makeGlobal")}
							</button>
						)}
						<button type="button" disabled={busy} onClick={() => actions.requestDelete(episode)} aria-label={t("memory.deleteEpisode")} title={t("memory.deleteEpisode")} data-testid="memory-delete-episode">
							<Trash2 aria-hidden />
						</button>
					</span>
				) : null}
			</header>
			<blockquote className="memory-episode-text" data-expanded={expanded || !long ? "true" : undefined}>{episode.text}</blockquote>
			{long ? <button type="button" className="memory-expand" onClick={() => setExpanded((value) => !value)}>{expanded ? t("memory.collapse") : t("memory.expand")}</button> : null}
			{facts.length > 0 ? (
				<ul className="memory-facts">
					{facts.map((fact) => <MemoryFact key={fact.id} fact={fact} busy={busy} onRun={run} actions={actions} />)}
				</ul>
			) : null}
		</article>
	);
}

function MemoryFact({ fact, busy, onRun, actions }: {
	fact: MemoryFactView;
	busy: boolean;
	onRun: (change: () => Promise<void>) => Promise<void>;
	actions: EpisodeActions;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<string | null>(null);
	if (draft !== null) {
		const text = draft.trim();
		return (
			<li className="memory-fact" data-editing="true">
				<form onSubmit={(event) => {
					event.preventDefault();
					if (!text || text === fact.text) { setDraft(null); return; }
					void onRun(async () => { await actions.saveFact(fact, text); setDraft(null); });
				}}>
					<textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={t("memory.editFact")} rows={3} autoFocus
						onKeyDown={(event) => { if (event.key === "Escape") setDraft(null); }} />
					<div className="memory-fact-edit-actions">
						<button type="button" onClick={() => setDraft(null)} disabled={busy}>{t("common.cancel")}</button>
						<button type="submit" data-primary="true" disabled={busy || !text}>{t("common.save")}</button>
					</div>
				</form>
			</li>
		);
	}
	return (
		<li className="memory-fact" data-invalidated={fact.invalidated ? "true" : undefined} data-testid="memory-fact">
			<div className="memory-fact-text">
				<p>{fact.text}</p>
				{fact.editedAt ? <small className="memory-edited">{t("memory.editedByYou")} · <time dateTime={fact.editedAt}>{formatRelativeTime(fact.editedAt)}</time></small> : null}
			</div>
			<span className="memory-fact-actions">
				{fact.invalidated ? (
					<button type="button" disabled={busy} onClick={() => void onRun(() => actions.setInvalidated(fact, false))} data-testid="memory-restore-fact">
						<RotateCcw aria-hidden />{t("memory.restore")}
					</button>
				) : (
					<>
						<button type="button" disabled={busy} onClick={() => setDraft(fact.text)} aria-label={t("memory.editFact")} title={t("memory.editFact")} data-testid="memory-edit-fact">
							<PencilIcon aria-hidden />
						</button>
						<button type="button" disabled={busy} onClick={() => void onRun(() => actions.setInvalidated(fact, true))} data-testid="memory-invalidate-fact">
							{t("memory.invalidate")}
						</button>
					</>
				)}
			</span>
		</li>
	);
}
