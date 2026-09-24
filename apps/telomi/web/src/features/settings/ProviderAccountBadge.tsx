import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import type { ProviderAccountsState } from "@shared/types.js";
import { uiText } from "@/app/ui-text";
import { subscribeProviderAccountsEvents } from "@/shared/lib/providerAccountsStream";
import { cn } from "@/shared/lib/utils";

interface ProviderAccountBadgeProps {
	/** Compound `<provider>/<modelId>` - same shape ModelPicker takes. */
	currentModelId?: string;
	/** Optional click handler — typically navigates to Settings → Codex 账号. */
	onClick?: () => void;
}

/**
 * Tiny badge that surfaces the currently-active account of the selected
 * model's Provider next to the ModelPicker, only once that Provider has an
 * account chain in accounts/<provider>.json.
 *
 * Subscribes to the global event bus so the badge updates the moment a
 * fallback rotates the active id mid-stream.
 */
export function ProviderAccountBadge({ currentModelId, onClick }: ProviderAccountBadgeProps) {
	const [state, setState] = useState<ProviderAccountsState | null>(null);
	const [tick, setTick] = useState(0);

	const slash = (currentModelId ?? "").indexOf("/");
	const provider = slash > 0 ? (currentModelId ?? "").slice(0, slash) : "";

	useEffect(() => {
		setState(null);
		if (!provider) return;
		return subscribeProviderAccountsEvents<ProviderAccountsState>(provider, setState);
	}, [provider]);

	// Re-render every 30s so the cooldown countdown decays without manual events.
	useEffect(() => {
		if (!provider) return;
		const iv = setInterval(() => setTick((t) => t + 1), 30_000);
		return () => clearInterval(iv);
	}, [provider]);
	// Suppress unused-state warning - `tick` only exists to invalidate the render.
	void tick;

	if (!provider) return null;
	if (!state || state.accounts.length === 0) return null;

	const active = state.accounts.find((a) => a.id === state.activeId) ?? null;
	if (!active) return null;

	const total = state.accounts.length;
	const onCooldown = !!(active.cooldownUntil && active.cooldownUntil > Date.now());
	const degraded = onCooldown || active.status === "rate-limited" || active.status === "auth-error" || active.status === "expired";

	const tooltip = [
		uiText("settings.codexaccountbadge.codexAccountLabelPositionTotal", {
			label: active.label || active.id,
			position: active.chainPosition + 1,
			total,
		}),
		active.maskedToken ? `Token: ${active.maskedToken}` : null,
		active.lastErrorMessage ? uiText("settings.codexaccountbadge.latestErrorError", { error: active.lastErrorMessage }) : null,
		onCooldown ? uiText("settings.codexaccountbadge.coolingDownMinutesMinRemaining", {
			minutes: Math.max(1, Math.ceil((active.cooldownUntil! - Date.now()) / 60_000)),
		}) : null,
		uiText("settings.codexaccountbadge.openSettingsCodexAccounts"),
	].filter(Boolean).join("\n");

	const stateText = onCooldown
		? uiText("settings.codexaccountbadge.coolingDownMinutesMinRemaining", {
			minutes: Math.max(1, Math.ceil((active.cooldownUntil! - Date.now()) / 60_000)),
		})
		: active.status === "rate-limited" ? uiText("common.rateLimited")
		: active.status === "auth-error" ? uiText("settings.codexaccountbadge.authenticationError")
		: active.status === "expired" ? uiText("common.expired")
		: uiText("common.available");

	const ariaLabel = [
		uiText("settings.codexaccountbadge.codexAccountLabel", { label: active.label || active.id }),
		uiText("settings.codexaccountbadge.accountPositionOfTotal", { position: active.chainPosition + 1, total }),
		uiText("settings.codexaccountbadge.statusStatus", { status: stateText }),
		active.lastErrorMessage ? uiText("settings.codexaccountbadge.latestErrorError.169403b", { error: active.lastErrorMessage }) : null,
		uiText("settings.codexaccountbadge.openSettings"),
	].filter(Boolean).join(", ");

	const display = active.label?.trim() || `#${active.chainPosition + 1}`;
	const truncated = display.length > 12 ? `${display.slice(0, 11)}…` : display;

	return (
		<button
			type="button"
			onClick={onClick}
			title={tooltip}
			aria-label={ariaLabel}
			data-testid="provider-account-badge"
			data-active-id={active.id}
			className={cn(
				"inline-flex items-center gap-1 h-7 px-2 rounded-[6px] border border-transparent text-[12px] leading-[1.1] cursor-pointer transition-colors duration-[120ms] ease-[ease]",
				"text-[var(--foreground-50)] hover:text-[var(--foreground)] hover:bg-[var(--foreground-5)]",
				degraded && "text-[var(--destructive)] hover:text-[var(--destructive)]",
				!onClick && "cursor-default",
			)}
		>
			<KeyRound className="h-[0.85rem] w-[0.85rem] flex-none" aria-hidden />
			<span className="max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap">{truncated}</span>
			{total > 1 && (
				<span className="text-[10px] text-[var(--foreground-30)]">
					{active.chainPosition + 1}/{total}
				</span>
			)}
		</button>
	);
}
