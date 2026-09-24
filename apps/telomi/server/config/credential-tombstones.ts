/**
 * Deleted Provider credentials stay deleted.
 *
 * A stored credential already outranks the environment, but a Provider with no stored
 * credential falls back to ambient environment variables. Without a record of the deletion,
 * a key left in `.env*` silently reactivates the Provider on the next restart, and the unified
 * settings entry point would no longer describe what actually runs.
 *
 * The Runtime therefore records the deletion in settings and removes the environment variables
 * the Provider would otherwise read, both when the user deletes the credential and again at
 * startup after the project environment files are loaded.
 */
import { loadSettings, saveSettings } from "./settings.js";
import { findRegistryEnvKeys } from "../agent-runtime/pi-ai.js";
import {
	SEARCH_TOMBSTONE_PREFIX,
	searchCredentialField,
	searchCredentialSuppressedEnvNames,
} from "../providers/search-credential-catalog.js";

function readTombstones(): string[] {
	const stored = loadSettings().deletedProviderCredentials;
	return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Remove the environment variables a Provider would authenticate with.
 *
 * ponytail: covers Providers whose ambient credential is an environment variable. Ambient
 * credentials that are not environment variables (Vertex ADC files, AWS profiles) still resolve;
 * suppressing those needs a per-request auth context from pi-ai.
 */
function stripProviderEnvironment(provider: string, env: NodeJS.ProcessEnv): string[] {
	let names: string[] | undefined;
	if (provider.startsWith(SEARCH_TOMBSTONE_PREFIX)) {
		const field = searchCredentialField(provider.slice(SEARCH_TOMBSTONE_PREFIX.length));
		names = field ? searchCredentialSuppressedEnvNames(field) : [];
		return removeNames(names, env);
	}
	try {
		const present = Object.fromEntries(
			Object.entries(env).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])),
		);
		names = findRegistryEnvKeys(provider, present);
	} catch {
		// A custom or future Provider has no compat environment resolver; it has no ambient key.
		return [];
	}
	return removeNames(names ?? [], env);
}

function removeNames(names: readonly string[], env: NodeJS.ProcessEnv): string[] {
	const removed: string[] = [];
	for (const name of names) {
		if (env[name] === undefined) continue;
		delete env[name];
		removed.push(name);
	}
	return removed;
}

/** Record that the user deleted this Provider's credential and drop its ambient environment. */
export function markProviderCredentialDeleted(
	provider: string,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const settings = loadSettings();
	const tombstones = new Set(readTombstones());
	if (!tombstones.has(provider)) {
		tombstones.add(provider);
		settings.deletedProviderCredentials = [...tombstones].sort();
		saveSettings(settings);
	}
	return stripProviderEnvironment(provider, env);
}

/** A newly configured credential replaces the deletion; the Provider is managed again. */
export function clearProviderCredentialTombstone(provider: string): void {
	const tombstones = readTombstones();
	if (!tombstones.includes(provider)) return;
	const settings = loadSettings();
	const remaining = tombstones.filter((entry) => entry !== provider);
	if (remaining.length > 0) settings.deletedProviderCredentials = remaining;
	else delete settings.deletedProviderCredentials;
	saveSettings(settings);
}

export function isProviderCredentialDeleted(provider: string): boolean {
	return readTombstones().includes(provider);
}

/** Apply every recorded deletion to this process, after the project environment files load. */
export function applyCredentialTombstones(env: NodeJS.ProcessEnv = process.env): string[] {
	return readTombstones().flatMap((provider) => stripProviderEnvironment(provider, env));
}
