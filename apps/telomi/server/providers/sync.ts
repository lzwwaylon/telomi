import { isDeepStrictEqual } from "node:util";
import {
	definesConnection,
	discoverCustomProviderModels,
	loadModelsFile,
	mergeDiscoveredModels,
	refreshCustomProviders,
	saveCustomProviders,
	type CustomProvidersFile,
} from "./custom-models.js";
import { toErrorMessage } from "../lib/values.js";

/**
 * Periodic sync of the project agent directory's `models.json` against each custom provider's
 * own OpenAI-compatible `/v1/models` endpoint. Without this, a user who adds a
 * model at the Provider has to open Settings and discover models by hand before
 * the chat picker can see it.
 *
 * Sync is additive: discovered ids missing from disk get appended and known ids
 * pick up what the listing now says about them (name, capabilities, voices); ids
 * on disk that the remote no longer returns are preserved (the user may have
 * hand-added aliases we shouldn't wipe). A connection whose models the user ticked
 * (`userSelectedModels`) keeps exactly that selection: only its known ids are refreshed. Built-in providers are untouched - they
 * live in pi-ai's static MODELS table and have no remote catalog to poll.
 */

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 min after boot

export type CustomProvidersSyncEvent =
	| { kind: "tick-start"; providerCount: number }
	| { kind: "provider-synced"; provider: string; added: string[]; total: number }
	| { kind: "provider-skipped"; provider: string; reason: string }
	| { kind: "provider-error"; provider: string; error: string }
	| { kind: "tick-end"; changed: number; durationMs: number };

export interface CustomProvidersSyncOptions {
	intervalMs?: number;
	initialDelayMs?: number;
	onEvent?: (event: CustomProvidersSyncEvent) => void;
}

export interface CustomProvidersSyncHandle {
	stop: () => void;
	runNow: () => Promise<void>;
	config: { enabled: boolean; intervalMs: number; initialDelayMs: number };
}

export function startCustomProvidersSync(opts: CustomProvidersSyncOptions = {}): CustomProvidersSyncHandle {
	const intervalMs =
		opts.intervalMs ??
		(Number(process.env.TELOMI_CUSTOM_PROVIDERS_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
	const initialDelayMs =
		opts.initialDelayMs ??
		(Number(process.env.TELOMI_CUSTOM_PROVIDERS_SYNC_INITIAL_DELAY_MS) || DEFAULT_INITIAL_DELAY_MS);

	const emit = (event: CustomProvidersSyncEvent) => {
		try {
			opts.onEvent?.(event);
		} catch {
			// Listener bugs must not break the scheduler.
		}
	};

	let stopped = false;
	let timer: NodeJS.Timeout | null = null;

	const runPass = async (): Promise<void> => {
		const start = Date.now();
		let file: CustomProvidersFile;
		try {
			// The whole file is written back, so entries that are not connections must be read too.
			file = loadModelsFile();
		} catch (err) {
			emit({
				kind: "provider-error",
				provider: "<models.json>",
				error: toErrorMessage(err),
			});
			emit({ kind: "tick-end", changed: 0, durationMs: Date.now() - start });
			return;
		}
		const providers = file.providers ?? {};
		const entries = Object.entries(providers);
		emit({ kind: "tick-start", providerCount: entries.length });
		let changedProviders = 0;
		for (const [pid, entry] of entries) {
			if (!entry || typeof entry !== "object") {
				emit({ kind: "provider-skipped", provider: pid, reason: "invalid entry" });
				continue;
			}
			if (typeof entry.baseUrl !== "string" || !entry.baseUrl) {
				emit({ kind: "provider-skipped", provider: pid, reason: "missing baseUrl" });
				continue;
			}
			if (!definesConnection(pid, entry)) {
				emit({ kind: "provider-skipped", provider: pid, reason: "not a connection definition" });
				continue;
			}
			try {
				const discovered = await discoverCustomProviderModels({
					baseUrl: entry.baseUrl,
					apiKey: entry.apiKey,
					capability: entry.capability,
				});
				const existing = Array.isArray(entry.models) ? entry.models : [];
				const existingIds = new Set(existing.map((m) => m?.id).filter((id): id is string => typeof id === "string"));
				const next = mergeDiscoveredModels(existing, entry.userSelectedModels ? discovered.filter((model) => existingIds.has(model.id)) : discovered);
				const added = next.filter((m) => !existingIds.has(m.id)).map((m) => m.id);
				if (!isDeepStrictEqual(next, existing)) {
					entry.models = next;
					providers[pid] = entry;
					changedProviders += 1;
				}
				emit({ kind: "provider-synced", provider: pid, added, total: next.length });
			} catch (err) {
				emit({
					kind: "provider-error",
					provider: pid,
					error: toErrorMessage(err),
				});
			}
		}
		if (changedProviders > 0) {
			try {
				file.providers = providers;
				saveCustomProviders(file);
				await refreshCustomProviders();
			} catch (err) {
				emit({
					kind: "provider-error",
					provider: "<models.json>",
					error: `save failed: ${toErrorMessage(err)}`,
				});
			}
		}
		emit({ kind: "tick-end", changed: changedProviders, durationMs: Date.now() - start });
	};

	const scheduleNext = () => {
		if (stopped) return;
		timer = setTimeout(async () => {
			await runPass();
			scheduleNext();
		}, intervalMs);
	};

	timer = setTimeout(async () => {
		await runPass();
		scheduleNext();
	}, initialDelayMs);

	return {
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		runNow: runPass,
		config: { enabled: true, intervalMs, initialDelayMs },
	};
}
