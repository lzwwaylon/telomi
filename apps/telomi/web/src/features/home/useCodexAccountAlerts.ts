import { apiClient } from "@/shared/lib/api-client";
import { useEffect, useMemo, useState } from "react";
import { subscribeProviderAccountsEvents } from "@/shared/lib/providerAccountsStream";
import {
	deriveCodexAccountAlerts,
	type CodexAccountsAlertState,
} from "@/features/home/codexAccountAlerts";
import { useTranslation } from "react-i18next";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";

/**
 * Watches the server-side Codex account ledger. The ledger is updated by real
 * model calls, so this hook consumes no additional model tokens.
 */
export function useCodexAccountAlerts() {
	const { t, i18n } = useTranslation();
	const [state, setState] = useState<CodexAccountsAlertState | null>(null);
	const [clock, setClock] = useState(() => Date.now());

	useEffect(() => {
		let stopped = false;
		void apiClient.get<CodexAccountsAlertState>("/api/accounts/openai-codex")
			.then((next) => {
				if (!stopped) setState(next);
			})
			.catch(() => {
				// The SSE stream below will retry and deliver a full snapshot.
			});

		const unsubscribe = subscribeProviderAccountsEvents<CodexAccountsAlertState>("openai-codex", (next) => {
			if (!stopped) setState(next);
		});
		return () => {
			stopped = true;
			unsubscribe();
		};
	}, []);

	useEffect(() => {
		const interval = window.setInterval(() => setClock(Date.now()), 30_000);
		return () => window.clearInterval(interval);
	}, []);

	return useMemo(
		() => deriveCodexAccountAlerts(state, clock, (key, options) => uiText(key as MessageId, options as Record<string, string | number>), i18n.resolvedLanguage ?? "en"),
		[clock, i18n.resolvedLanguage, state, t],
	);
}
