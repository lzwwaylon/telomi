import { formatDate } from "@/shared/lib/format";
export type ProviderAccountStatus = "ok" | "expired" | "rate-limited" | "auth-error" | "unknown";

export interface CodexAccountAlertSummary {
	id: string;
	label: string;
	status: ProviderAccountStatus;
	lastErrorClass?: "auth" | "quota" | "transient" | "permanent";
	cooldownUntil?: number;
	isActive: boolean;
}

export interface CodexAccountsAlertState {
	accounts: CodexAccountAlertSummary[];
	activeId: string | null;
	usage?: {
		status: "idle" | "loading" | "ok" | "error" | "unsupported";
		accountId?: string;
		primary?: {
			usedPercent: number;
			windowDurationMins: number | null;
			resetsAt: number | null;
		} | null;
		rateLimitReachedType?: string | null;
	};
}

export interface CodexAccountAlert {
	id: string;
	kind: "quota" | "auth";
	title: string;
	description: string;
}

/**
 * Converts persisted Codex account health into actionable inbox alerts.
 *
 * Quota alerts remain visible after fallback switches to another account, so a
 * successful fallback cannot hide the account that exhausted its allowance.
 * Authentication alerts only track the active account to avoid surfacing stale
 * inactive credentials that the user is not currently relying on.
 */
export function deriveCodexAccountAlerts(
	state: CodexAccountsAlertState | null,
	now = Date.now(),
	translate?: (key: string, options?: Record<string, unknown>) => string,
	locale = "zh-CN",
): CodexAccountAlert[] {
	if (!state) return [];
	const text = (key: string, fallback: string, options?: Record<string, unknown>) => translate?.(key, options) ?? fallback;

	const alerts: CodexAccountAlert[] = [];
	const usage = state.usage;
	const usedPercent =
		usage?.status === "ok" && usage.primary ? usage.primary.usedPercent : null;
	const usageReached =
		usedPercent !== null &&
		(usedPercent >= 100 || Boolean(usage?.rateLimitReachedType));
	const usageWarning = usedPercent !== null && usedPercent >= 80;

	if (usageWarning) {
		const reset = usage?.primary?.resetsAt
			? text("inbox.resetAt", `，将在 ${formatResetTime(usage.primary.resetsAt, locale)} 重置`, { time: formatResetTime(usage.primary.resetsAt, locale) })
			: "";
		alerts.push({
			id: `codex-usage-${usage?.accountId ?? "active"}`,
			kind: "quota",
			title: usageReached
				? text("inbox.quotaExhausted", "Codex 额度已用完")
				: text("inbox.quotaUsage", `Codex 本周期用量已达 ${formatPercent(usedPercent)}`, { percent: formatPercent(usedPercent) }),
			description: usageReached
				? text("inbox.quotaExhaustedDescription", `当前订阅窗口已触发使用限制${reset}。请切换账号，或等待额度恢复。`, { reset })
				: text("inbox.quotaWarningDescription", `当前订阅窗口已使用 ${formatPercent(usedPercent)}${reset}。达到 100% 时 Telomi 会继续提醒你。`, { percent: formatPercent(usedPercent), reset }),
		});
	}

	for (const account of state.accounts) {
		if (account.status !== "rate-limited") continue;
		if (usageWarning && account.id === usage?.accountId) continue;
		const cooldownMinutes =
			account.cooldownUntil && account.cooldownUntil > now
				? Math.max(1, Math.ceil((account.cooldownUntil - now) / 60_000))
				: null;
		alerts.push({
			id: `codex-quota-${account.id}`,
			kind: "quota",
			title: text("inbox.limitTriggered", "Codex 使用限制已触发"),
			description: cooldownMinutes
				? text("inbox.cooldown", `账号「${account.label}」已进入冷却，预计 ${cooldownMinutes} 分钟后可重试。你也可以现在切换账号。`, { account: account.label, minutes: cooldownMinutes })
				: text("inbox.limited", `账号「${account.label}」最近触发了额度或速率限制。请切换账号，或稍后重试以确认额度已经恢复。`, { account: account.label }),
		});
	}

	const active =
		state.accounts.find((account) => account.id === state.activeId) ??
		state.accounts.find((account) => account.isActive);
	if (active?.status === "auth-error" || active?.status === "expired") {
		alerts.push({
			id: `codex-auth-${active.id}`,
			kind: "auth",
			title: active.status === "expired" ? text("inbox.loginExpired", "Codex 登录已过期") : text("inbox.authFailed", "Codex 鉴权失败"),
			description: text("inbox.authDescription", `当前账号「${active.label}」无法继续调用。请到设置重新登录，或切换到另一个账号。`, { account: active.label }),
		});
	}

	return alerts;
}

function formatPercent(value: number): string {
	return `${Math.max(0, Math.min(100, Math.round(value * 10) / 10))}%`;
}

function formatResetTime(epochSeconds: number, locale: string): string {
	return formatDate(new Date(epochSeconds * 1_000), {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}, locale);
}
