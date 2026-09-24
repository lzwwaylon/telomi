import { formatWindowDuration, formatDate, formatRelativeTime } from "@/shared/lib/format";
import { useNow } from "@/shared/hooks/useNow";
import { apiClient } from "@/shared/lib/api-client";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, Loader2, RefreshCcw, Trash2 } from "lucide-react";
import type {
	ProviderAccountSummary,
	ProviderAccountsState,
	CodexUsageSnapshot,
} from "@shared/types.js";
import { subscribeProviderAccountsEvents } from "@/shared/lib/providerAccountsStream";
import { currentUiLocale } from "@/app/i18n";
import { uiText } from "@/app/ui-text";

const BUTTON_GHOST =
	"inline-flex items-center gap-1.5 rounded-[0.5rem] border border-border px-3 py-1.5 text-[0.85rem] text-foreground transition-colors hover:bg-[var(--foreground-5)] disabled:opacity-50";

const ICON_BUTTON =
	"inline-flex h-7 w-7 items-center justify-center rounded-[0.4rem] border border-transparent text-[var(--foreground-60)] transition-colors hover:bg-[var(--foreground-5)] hover:border-border hover:text-foreground disabled:opacity-50";

/**
 * Inline multi-account fallback chain UI for one Provider. Lives inside the
 * Provider's row in Connections: the OAuth login and API-key save flows already
 * exist on that row, and every applied credential joins this chain server-side.
 * This component only handles chain *management*: list, reorder, activate,
 * delete, manual import. The usage card appears only for Providers that report
 * subscription usage (openai-codex).
 *
 * Subscribes to the global event bus so reorder/activate from another
 * tab (or a mid-stream fallback rotation) shows up immediately.
 */
export function ProviderAccountsInline({ providerId, onChanged }: { providerId: string; onChanged?: () => void }) {
	const base = `/api/accounts/${encodeURIComponent(providerId)}`;
	const [state, setState] = useState<ProviderAccountsState | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [actionInfo, setActionInfo] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const data = await apiClient.get<ProviderAccountsState>(base);
			setState(data);
			setLoadError(null);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err));
		}
	}, [base]);

	useEffect(() => {
		void refresh();
		return subscribeProviderAccountsEvents<ProviderAccountsState>(providerId, setState);
	}, [providerId, refresh]);

	const guard = useCallback(async (fn: () => Promise<ProviderAccountsState | void>) => {
		setBusy(true);
		setActionError(null);
		setActionInfo(null);
		try {
			const next = await fn();
			if (next) setState(next);
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, []);

	const handleActivate = (id: string) =>
		guard(async () => {
			return await apiClient.post<ProviderAccountsState>(`${base}/${id}/activate`);
		});

	// Deleting a credential cannot be undone, so the account waits here until the user confirms it.
	const [deleting, setDeleting] = useState<string | null>(null);
	const handleDelete = (id: string) =>
		guard(async () => await apiClient.delete<ProviderAccountsState>(`${base}/${id}`));

	const handleMove = (id: string, dir: -1 | 1) =>
		guard(async () => {
			if (!state) return;
			const order = [...state.chainOrder];
			const idx = order.indexOf(id);
			const target = idx + dir;
			if (idx < 0 || target < 0 || target >= order.length) return;
			[order[idx], order[target]] = [order[target], order[idx]];
			return await apiClient.put<ProviderAccountsState>(`${base}/order`, { order });
		});

	const handleUsageRefresh = () =>
		guard(async () => {
			const data = await apiClient.post<ProviderAccountsState>(`${base}/usage/refresh`);
			if (data.usage?.status === "ok") setActionInfo(uiText("settings.codexaccountsinline.codexUsageRefreshed"));
			else if (data.usage?.error) throw new Error(data.usage.error);
			return data;
		});

	// The credential in use follows the current account; the Provider row reads it from auth.json,
	// so a switch after the first load asks the row to refresh. The first load itself is not a switch.
	const activeId = state?.activeId;
	const seenActiveId = useRef<string | null | undefined>(undefined);
	useEffect(() => {
		if (activeId === undefined) return;
		const previous = seenActiveId.current;
		seenActiveId.current = activeId;
		if (previous !== undefined && previous !== activeId) onChanged?.();
	}, [activeId, onChanged]);

	const accounts = useMemo(() => state?.accounts ?? [], [state]);
	// One account is just the Provider's credential; the group view starts at two.
	const isGroup = accounts.length > 1;
	if (!isGroup && !state?.usage && !loadError) return null;

	return (
		<div className="grid gap-2 px-3 pb-3 border-t border-border pt-3" data-testid={`accounts/${providerId}-inline`}>
			{isGroup && (
				<div className="flex items-center gap-2 flex-wrap">
					<span className="text-[0.82rem] font-medium text-foreground">{uiText("settings.codexaccountsinline.accounts")}</span>
					<span className="text-[0.78rem] text-muted-foreground flex-1">
						{uiText("settings.codexaccountsinline.eachLoginOauthOrReplaceActionIsSavedAs")}
					</span>
					{busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />}
				</div>
			)}

			{loadError && (
				<div className="rounded-[0.5rem] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[0.8rem] text-destructive">
					{uiText("common.failedToLoad")} {loadError}
				</div>
			)}
			{actionError && (
				<div className="rounded-[0.5rem] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[0.8rem] text-destructive whitespace-pre-wrap">
					{actionError}
				</div>
			)}
			{actionInfo && (
				<div className="rounded-[0.5rem] border border-border bg-card px-3 py-2 text-[0.8rem] text-muted-foreground">
					{actionInfo}
				</div>
			)}

			{state?.usage && (
				<UsageCard
					usage={state.usage}
					busy={busy}
					onRefresh={handleUsageRefresh}
				/>
			)}

			{isGroup && (
			<div className="grid gap-1.5">
				{accounts.map((acc, i) => (
						<AccountRow
							key={acc.id}
							account={acc}
							canMoveUp={i > 0}
							canMoveDown={i < accounts.length - 1}
							busy={busy}
							onActivate={() => handleActivate(acc.id)}
							onDelete={() => setDeleting(acc.id)}
							onMoveUp={() => handleMove(acc.id, -1)}
							onMoveDown={() => handleMove(acc.id, 1)}
						/>
					))}
			</div>
			)}
			<ConfirmDialog
				open={deleting !== null}
				title={uiText("settings.codexaccountsinline.deleteAccountTitle")}
				description={uiText("settings.codexaccountsinline.deleteAccountDescription")}
				confirmLabel={uiText("common.delete")}
				destructive
				onCancel={() => setDeleting(null)}
				onConfirm={async () => {
					const id = deleting;
					setDeleting(null);
					if (id) await handleDelete(id);
				}}
				testId="provider-account-delete-dialog"
			/>
		</div>
	);
}

function UsageCard(props: {
	usage: CodexUsageSnapshot;
	busy: boolean;
	onRefresh: () => void;
}) {
	const { usage } = props;
	const now = useNow();
	const percent = usage.primary?.usedPercent;
	const hasPercent = typeof percent === "number" && Number.isFinite(percent);
	const boundedPercent = hasPercent ? Math.max(0, Math.min(100, percent)) : 0;
	const exhausted =
		hasPercent && (percent >= 100 || Boolean(usage.rateLimitReachedType));
	const warning = hasPercent && percent >= 80;

	return (
		<div
			className="grid gap-2 rounded-[0.55rem] border border-border bg-card px-3 py-2.5"
			data-testid="codex-usage-card"
		>
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 flex-wrap">
						<span className="text-[0.82rem] font-medium text-foreground">
							{uiText("settings.codexaccountsinline.codexSubscriptionUsage")}
						</span>
						{usage.planType && (
							<span className="rounded-full border border-border px-1.5 text-[0.68rem] uppercase text-muted-foreground">
								{usage.planType}
							</span>
						)}
						{usage.status === "loading" && (
							<Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label={uiText("settings.codexaccountsinline.refreshingUsage")} />
						)}
					</div>
					<div className="mt-0.5 text-[0.75rem] text-muted-foreground">
						{usage.status === "unsupported"
							? usage.error || uiText("settings.codexaccountsinline.subscriptionUsageIsUnavailableForThisSignInMethod")
							: usage.status === "error" && !hasPercent
								? uiText("settings.codexaccountsinline.failedToLoadError", { error: usage.error || uiText("settings.codexaccountsinline.unknownError") })
								: hasPercent
									? exhausted
										? uiText("settings.codexaccountsinline.allowanceExhaustedForThisPeriod")
										: uiText("settings.codexaccountsinline.percentUsedThisPeriod", { percent: formatUsagePercent(percent) })
									: uiText("settings.codexaccountsinline.loadingUsage")}
					</div>
				</div>
				<button
					type="button"
					className={BUTTON_GHOST}
					onClick={props.onRefresh}
					disabled={props.busy || usage.status === "loading"}
					data-testid="codex-usage-refresh"
				>
					<RefreshCcw className="h-3.5 w-3.5" aria-hidden /> {uiText("common.refresh")}
				</button>
			</div>

			{hasPercent && (
				<>
					<div className="h-1.5 overflow-hidden rounded-full bg-[var(--foreground-10)]">
						<div
							className={
								"h-full rounded-full transition-[width] duration-300 " +
								(exhausted || warning ? "bg-destructive" : "bg-foreground")
							}
							style={{ width: `${boundedPercent}%` }}
							role="progressbar"
							aria-label={uiText("settings.codexaccountsinline.codexSubscriptionUsage")}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={boundedPercent}
						/>
					</div>
					<div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.72rem] text-muted-foreground">
						{usage.primary?.windowDurationMins && (
							<span>{uiText("settings.codexaccountsinline.period")} {formatWindowDuration(usage.primary.windowDurationMins)}</span>
						)}
						{usage.primary?.resetsAt && (
							<span>{uiText("settings.codexaccountsinline.reset")} {formatResetDate(usage.primary.resetsAt)}</span>
						)}
						{typeof usage.resetCreditsAvailable === "number" && (
							<span>{uiText("settings.codexaccountsinline.fullResetCreditsCount", { count: usage.resetCreditsAvailable })}</span>
						)}
						{usage.checkedAt && <span>{uiText("settings.codexaccountsinline.checked")} {formatRelativeTime(usage.checkedAt, undefined, now)}</span>}
					</div>
				</>
			)}
		</div>
	);
}

function AccountRow(props: {
	account: ProviderAccountSummary;
	canMoveUp: boolean;
	canMoveDown: boolean;
	busy: boolean;
	onActivate: () => void;
	onDelete: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
}) {
	const now = useNow();
	const { account: a } = props;
	const cooldownLeft = a.cooldownUntil && a.cooldownUntil > Date.now() ? a.cooldownUntil - Date.now() : 0;
	const statusLabel = renderStatus(a, cooldownLeft);

	return (
		<div
			className={
				"grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-[0.55rem] border px-2.5 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] " +
				(a.isActive ? "border-foreground/40 bg-[var(--foreground-5)]" : "border-border")
			}
			data-testid={`accounts-inline-row-${a.id}`}
		>
			<div className="flex flex-col items-center gap-0.5 text-[0.7rem] text-muted-foreground w-6">
				<button
					type="button"
					className={ICON_BUTTON + " h-5 w-5"}
					onClick={props.onMoveUp}
					disabled={!props.canMoveUp || props.busy}
					aria-label={uiText("settings.codexaccountsinline.moveAccountLabelUp", { label: a.label })}
					title={uiText("common.moveUp")}
				>
					<ArrowUp className="h-3 w-3" aria-hidden />
				</button>
				<span className="font-mono text-[0.68rem]" aria-hidden="true">#{a.chainPosition + 1}</span>
				<button
					type="button"
					className={ICON_BUTTON + " h-5 w-5"}
					onClick={props.onMoveDown}
					disabled={!props.canMoveDown || props.busy}
					aria-label={uiText("settings.codexaccountsinline.moveAccountLabelDown", { label: a.label })}
					title={uiText("common.moveDown")}
				>
					<ArrowDown className="h-3 w-3" aria-hidden />
				</button>
			</div>

			<div className="grid gap-0.5 min-w-0">
				<div className="flex items-center gap-2 flex-wrap">
					<span className="font-medium text-[0.88rem] truncate">{a.label}</span>
					{a.isActive && (
						<span className="inline-flex items-center gap-1 rounded-full border border-foreground/40 px-1.5 py-0 text-[0.68rem] text-foreground">
							<CheckCircle2 className="h-3 w-3" aria-hidden /> {uiText("settings.codexaccountsinline.active")}
						</span>
					)}
					<span className={"text-[0.7rem] uppercase tracking-wide " + statusLabel.tone}>{statusLabel.text}</span>
				</div>
				<div className="flex items-center gap-2 flex-wrap text-[0.74rem] text-muted-foreground">
					<span>{a.type === "oauth" ? "OAuth" : "API Key"}</span>
					{a.maskedToken && <span className="font-mono">{a.maskedToken}</span>}
					{a.accountId && <span className="font-mono">acct: {a.accountId.slice(0, 8)}…</span>}
					{a.lastUsedAt && <span>{uiText("settings.codexaccountsinline.lastUsed")} {formatRelativeTime(a.lastUsedAt, undefined, now)}</span>}
				</div>
				{a.lastErrorMessage && a.lastErrorClass && a.lastErrorClass !== "permanent" && (
					<div className="text-[0.72rem] text-destructive truncate" title={a.lastErrorMessage}>
						{uiText("settings.codexaccountsinline.recentErrorErrorclass", { errorClass: a.lastErrorClass })} {a.lastErrorMessage}
					</div>
				)}
			</div>

			<div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
				{!a.isActive && (
					<button type="button" className={BUTTON_GHOST} onClick={props.onActivate} disabled={props.busy}>
						{uiText("settings.codexaccountsinline.setActive")}
					</button>
				)}
				<button
					type="button"
					className={ICON_BUTTON}
					onClick={props.onDelete}
					disabled={props.busy}
					aria-label={uiText("settings.codexaccountsinline.deleteAccountLabel", { label: a.label })}
					title={uiText("common.delete")}
				>
					<Trash2 className="h-4 w-4" aria-hidden />
				</button>
			</div>
		</div>
	);
}

/** Every status reaches the user as product copy; a raw enum value is never shown. */
export function renderStatus(a: ProviderAccountSummary, cooldownLeft: number): { text: string; tone: string } {
	if (cooldownLeft > 0) {
		const mins = Math.ceil(cooldownLeft / 60_000);
		return { text: uiText("settings.codexaccountsinline.coolingDownForMinutesMin", { minutes: mins }), tone: "text-muted-foreground" };
	}
	switch (a.status) {
		case "ok":
			return { text: uiText("common.available"), tone: "text-muted-foreground" };
		case "rate-limited":
			return { text: uiText("common.rateLimited"), tone: "text-amber-500" };
		case "auth-error":
			return { text: uiText("settings.codexaccountsinline.authenticationFailed"), tone: "text-destructive" };
		case "expired":
			return { text: uiText("common.expired"), tone: "text-destructive" };
		default:
			return { text: uiText("settings.codexaccountsinline.statusUnknown"), tone: "text-muted-foreground" };
	}
}


function formatUsagePercent(value: number): string {
	return `${Math.max(0, Math.min(100, Math.round(value * 10) / 10))}%`;
}



function formatResetDate(epochSeconds: number): string {
	return formatDate(new Date(epochSeconds * 1_000), {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}, currentUiLocale());
}
