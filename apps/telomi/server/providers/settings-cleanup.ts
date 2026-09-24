import { loadSettings, saveSettings, type PiSettings } from "../config/settings.js";

function isProviderModelRef(value: unknown, provider: string): value is string {
	return typeof value === "string" && value.startsWith(`${provider}/`);
}

function removeProviderRefsFromArray(value: unknown, provider: string): { next: string[]; removed: string[] } {
	if (!Array.isArray(value)) return { next: [], removed: [] };
	const next: string[] = [];
	const removed: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		if (isProviderModelRef(item, provider)) {
			removed.push(item);
		} else {
			next.push(item);
		}
	}
	return { next, removed };
}

export interface ProviderSettingsCleanupResult {
	changed: boolean;
	removedEnabledModels: string[];
	removedProviderFallbackModels: string[];
	clearedDefaultModel: boolean;
}

export function cleanupProviderSettings(provider: string): ProviderSettingsCleanupResult {
	const settings = loadSettings();
	const result: ProviderSettingsCleanupResult = {
		changed: false,
		removedEnabledModels: [],
		removedProviderFallbackModels: [],
		clearedDefaultModel: false,
	};

	const enabled = removeProviderRefsFromArray(settings.enabledModels, provider);
	if (enabled.removed.length > 0) {
		result.changed = true;
		result.removedEnabledModels = enabled.removed;
		if (enabled.next.length > 0) settings.enabledModels = enabled.next;
		else delete settings.enabledModels;
	}

	const fallback = removeProviderRefsFromArray(settings.providerFallbackModels, provider);
	if (fallback.removed.length > 0) {
		result.changed = true;
		result.removedProviderFallbackModels = fallback.removed;
		if (fallback.next.length > 0) settings.providerFallbackModels = fallback.next;
		else delete settings.providerFallbackModels;
	}

	if (settings.defaultProvider === provider) {
		result.changed = true;
		result.clearedDefaultModel = true;
		delete settings.defaultProvider;
		delete settings.defaultModel;
	}

	if (result.changed) saveSettings(settings as PiSettings);
	return result;
}
