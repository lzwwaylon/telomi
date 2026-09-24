import assert from "node:assert/strict";
import {
	deriveCodexAccountAlerts,
	type CodexAccountsAlertState,
} from "../../web/src/features/home/codexAccountAlerts.js";
import { classifyProviderError } from "../../server/accounts/error-classify.js";

const now = 1_750_000_000_000;
const healthy: CodexAccountsAlertState = {
	activeId: "primary",
	accounts: [
		{
			id: "primary",
			label: "主账号",
			status: "ok",
			isActive: true,
		},
		{
			id: "stale",
			label: "旧账号",
			status: "auth-error",
			lastErrorClass: "auth",
			isActive: false,
		},
	],
};

assert.deepEqual(deriveCodexAccountAlerts(null, now), []);
assert.deepEqual(
	deriveCodexAccountAlerts(healthy, now),
	[],
	"an inactive stale credential must not create a global alert",
);

const quotaState: CodexAccountsAlertState = {
	...healthy,
	activeId: "fallback",
	accounts: [
		{
			id: "primary",
			label: "本月账号",
			status: "rate-limited",
			lastErrorClass: "quota",
			cooldownUntil: now + 121_000,
			isActive: false,
		},
		{
			id: "fallback",
			label: "备用账号",
			status: "ok",
			isActive: true,
		},
	],
};
const quotaAlerts = deriveCodexAccountAlerts(quotaState, now);
assert.equal(quotaAlerts.length, 1);
assert.equal(quotaAlerts[0]?.kind, "quota");
assert.match(quotaAlerts[0]?.description ?? "", /3 分钟/);
assert.match(
	quotaAlerts[0]?.description ?? "",
	/本月账号/,
	"quota alert must survive a successful fallback switch",
);

const authState: CodexAccountsAlertState = {
	activeId: "primary",
	accounts: [
		{
			id: "primary",
			label: "本月账号",
			status: "auth-error",
			lastErrorClass: "auth",
			isActive: true,
		},
	],
};
const authAlerts = deriveCodexAccountAlerts(authState, now);
assert.equal(authAlerts.length, 1);
assert.equal(authAlerts[0]?.kind, "auth");
assert.match(authAlerts[0]?.title ?? "", /鉴权失败/);

const usageWarningState: CodexAccountsAlertState = {
	...healthy,
	usage: {
		status: "ok",
		accountId: "primary",
		primary: {
			usedPercent: 80,
			windowDurationMins: 10_080,
			resetsAt: Math.floor((now + 86_400_000) / 1_000),
		},
	},
};
const usageWarningAlerts = deriveCodexAccountAlerts(usageWarningState, now);
assert.equal(usageWarningAlerts.length, 1);
assert.match(usageWarningAlerts[0]?.title ?? "", /80%/);

const usageExhaustedState: CodexAccountsAlertState = {
	...quotaState,
	usage: {
		status: "ok",
		accountId: "primary",
		primary: {
			usedPercent: 100,
			windowDurationMins: 10_080,
			resetsAt: Math.floor((now + 86_400_000) / 1_000),
		},
		rateLimitReachedType: "rate_limit_reached",
	},
};
const usageExhaustedAlerts = deriveCodexAccountAlerts(usageExhaustedState, now);
assert.equal(
	usageExhaustedAlerts.filter((alert) => alert.kind === "quota").length,
	1,
	"precise usage alert must replace the active account's generic quota alert",
);
assert.match(usageExhaustedAlerts[0]?.title ?? "", /额度已用完/);

assert.equal(classifyProviderError("You've hit your usage limit"), "quota");
assert.equal(classifyProviderError("WebSocket error"), "transient");
assert.equal(classifyProviderError("429 rate_limit_exceeded"), "quota");
assert.equal(classifyProviderError("403 forbidden"), "auth");

console.log("codex account alert derivation test passed");
