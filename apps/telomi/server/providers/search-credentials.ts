/**
 * Search Provider credentials under the unified entry point.
 *
 * The store is the same file-locked compare-and-swap helper the model Provider credentials use,
 * pointed at its own files: `auth.json` is what the pi-ai model registry reads, and a search key
 * has no business in it. Saving for later writes only the pending file, which nothing consumes.
 *
 * These values are the authority. Every search resolves its credential from here through
 * `searchCredentialEnvironmentFor` and states it on its own request, so the value that answers a
 * request is the value its cache scope was derived from. `applySearchCredentialEnvironment` only
 * keeps the process environment on the same revision, for a Source Service started later and for
 * anything that still reads the environment directly.
 */
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Credential } from "@earendil-works/pi-ai";

import {
	modifyStoredCredential,
	modifyStoredCredentials,
	readStoredCredentials,
	writeStoredCredential,
} from "../accounts/stored-credentials.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { loadSettings, saveSettings } from "../config/settings.js";
import { firstEnvValue } from "../lib/env.js";
import {
	SEARCH_CREDENTIAL_PROVIDERS,
	searchCredentialEnvNames,
	searchCredentialField,
	searchCredentialFields,
	searchCredentialOverride,
	searchCredentialSuppressedEnvNames,
	searchCredentialTombstoneId,
	type SearchCredentialField,
} from "./search-credential-catalog.js";

export const SEARCH_AUTH_FILE = "search-auth.json";
const SEARCH_PENDING_AUTH_FILE = "search-auth-pending.json";

function activePath(): string {
	return resolveAgentPath(SEARCH_AUTH_FILE);
}

function pendingPath(): string {
	return resolveAgentPath(SEARCH_PENDING_AUTH_FILE);
}

function credentialKey(entry: Credential | undefined): string | undefined {
	if (!entry || entry.type !== "api_key") return undefined;
	return typeof entry.key === "string" && entry.key.length > 0 ? entry.key : undefined;
}

export function readSearchCredential(fieldId: string): string | undefined {
	return credentialKey(readStoredCredentials(activePath())[fieldId]);
}

export function readPendingSearchCredential(fieldId: string): string | undefined {
	return credentialKey(readStoredCredentials(pendingPath())[fieldId]);
}

export function stageSearchCredential(fieldId: string, value: string): void {
	writeStoredCredential(pendingPath(), fieldId, { type: "api_key", key: value });
}

/**
 * Publish a validated credential only while it is still the newest decision for that field.
 * Returns false when a concurrent edit or deletion landed first; that newer decision is kept.
 */
export function publishSearchCredentials(
	values: Record<string, string | null>,
	expected: ReadonlyMap<string, { key: string | undefined; deleted: boolean }>,
): boolean {
	return modifyStoredCredentials(activePath(), (current) => {
		for (const [id, before] of expected) {
			if (credentialKey(current[id]) !== before.key
				|| isProviderCredentialDeleted(searchCredentialTombstoneId(id)) !== before.deleted) return undefined;
		}
		for (const [id, value] of Object.entries(values)) {
			if (value === null) delete current[id];
			else current[id] = { type: "api_key", key: value };
		}
		return current;
	});
}

export function removeSearchCredential(fieldId: string): void {
	writeStoredCredential(activePath(), fieldId, null);
	writeStoredCredential(pendingPath(), fieldId, null);
}

/** Drop the staged value this activation consumed; a draft saved meanwhile is a newer decision. */
export function discardConsumedStagedCredential(fieldId: string, consumed: string): void {
	modifyStoredCredential(pendingPath(), fieldId, (current) =>
		credentialKey(current) === consumed ? null : undefined);
}

/** The managed credentials as the Source Service and the cache identity read them. */
export function activeSearchCredentialEnvironment(): Record<string, string> {
	const stored = readStoredCredentials(activePath());
	const env: Record<string, string> = {};
	for (const field of searchCredentialFields()) {
		const value = credentialKey(stored[field.id]);
		if (value) env[field.env] = value;
	}
	return env;
}

/**
 * One environment snapshot with the managed credentials on top. Unified settings are the
 * authority, so a value the user configured outranks whatever `.env*` left behind. Every consumer
 * that has to agree about which credential a request uses composes it here and nowhere else.
 */
export function searchCredentialEnvironmentFor(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const merged: Record<string, string | undefined> = { ...env, ...activeSearchCredentialEnvironment() };
	// Deleted means deleted: no name this credential used to arrive under may answer for it, wherever
	// that environment came from.
	for (const field of searchCredentialFields()) {
		if (!isProviderCredentialDeleted(searchCredentialTombstoneId(field.id))) continue;
		for (const name of searchCredentialSuppressedEnvNames(field)) delete merged[name];
	}
	return merged;
}

/**
 * Put the managed credentials into a process environment. Called before the Source Service starts
 * so it boots on the configured values rather than on whatever `.env*` happened to contain.
 */
export function applySearchCredentialEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
	const managed = activeSearchCredentialEnvironment();
	for (const [name, value] of Object.entries(managed)) env[name] = value;
	return Object.keys(managed).sort();
}

function importedFieldIds(): string[] {
	const stored = loadSettings().importedSearchCredentials;
	return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordProvenance(fieldId: string, imported: boolean): void {
	const current = importedFieldIds();
	const next = imported
		? [...new Set([...current, fieldId])].sort()
		: current.filter((entry) => entry !== fieldId);
	if (next.length === current.length && next.every((entry, index) => entry === current[index])) return;
	const settings = loadSettings();
	if (next.length > 0) settings.importedSearchCredentials = next;
	else delete settings.importedSearchCredentials;
	saveSettings(settings);
}

/** The user entered this value themselves, so it is no longer an adopted environment value. */
export function clearImportedProvenance(fieldId: string): void {
	recordProvenance(fieldId, false);
}

export function searchCredentialProvenance(fieldId: string): "user" | "imported" | null {
	if (readSearchCredential(fieldId) === undefined) return null;
	return importedFieldIds().includes(fieldId) ? "imported" : "user";
}

/**
 * Adopt a credential that only existed as an environment variable, once, so migration preserves
 * a working configuration instead of silently dropping it. After the import the managed value is
 * the authority and the environment no longer decides anything: a deleted credential is never
 * re-imported because its deletion is recorded, and an already managed field is left alone.
 */
export function importLegacySearchCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
	const imported: string[] = [];
	// Local environment values never governed a separately hosted service.
	if (env.TELOMI_RESEARCH_SOURCE_BASE_URL?.trim()) return imported;
	for (const field of searchCredentialFields()) {
		if (readSearchCredential(field.id) !== undefined) continue;
		if (isProviderCredentialDeleted(searchCredentialTombstoneId(field.id))) continue;
		const value = firstEnvValue(env, searchCredentialEnvNames(field))
			?? adoptableLocationValue(field, env);
		if (!value) continue;
		writeStoredCredential(activePath(), field.id, { type: "api_key", key: value });
		recordProvenance(field.id, true);
		imported.push(field.id);
	}
	return imported;
}

/**
 * The content of a credential file this host owns, or nothing.
 *
 * A file only this machine can read is a credential the user already has, so adopting its content
 * makes the entry point describe what searches actually authenticate with, and stops a later edit
 * to that file from silently changing it. A file a separately hosted Source Service reads is that
 * service's own configuration and is left where it is; so is one that cannot be read, which is
 * reported rather than imported as if it had worked.
 */
function adoptableLocationValue(
	field: SearchCredentialField,
	env: NodeJS.ProcessEnv,
): string | undefined {
	if (env.TELOMI_RESEARCH_SOURCE_BASE_URL?.trim()) return undefined;
	const location = credentialLocation(field, env);
	if (!location) return undefined;
	const read = readCredentialLocation(location.path);
	return "value" in read ? read.value : undefined;
}

/**
 * Whether the user has taken this Provider over here: a stored value or a recorded
 * deletion. Anything else means the entry point has no opinion about it yet.
 */
export function isSearchProviderManaged(providerId: string): boolean {
	const provider = SEARCH_CREDENTIAL_PROVIDERS.find((entry) => entry.id === providerId);
	return provider?.fields.some((field) =>
		readSearchCredential(field.id) !== undefined
		|| isProviderCredentialDeleted(searchCredentialTombstoneId(field.id))) ?? false;
}

/**
 * Matches `read_cookie_file` in the Source Service: a credential file it would refuse is one this
 * entry point must not adopt either, or the import would claim a credential the Provider rejects.
 */
const MAX_CREDENTIAL_FILE_BYTES = 2 * 1024 * 1024;

export type CredentialLocationRead = { value: string } | { error: string };

/**
 * Read a credential the user pointed at with a file path. The raw text is exactly what the Source
 * Service parses, so adopting it does not reinterpret the credential in any way.
 */
export function readCredentialLocation(path: string): CredentialLocationRead {
	const target = resolve(path.startsWith("~/") ? path.replace("~", homedir()) : path);
	try {
		const stat = lstatSync(target);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			return { error: "credential file is not a regular file" };
		}
		if (stat.size > MAX_CREDENTIAL_FILE_BYTES) {
			return { error: "credential file is larger than 2 MiB" };
		}
		const value = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(target)).trim();
		return value ? { value } : { error: "credential file is empty" };
	} catch {
		return { error: "credential file could not be read as UTF-8" };
	}
}

/** The file a field would currently be read from, and whether this host can read it. */
export function credentialLocation(
	field: SearchCredentialField,
	env: Record<string, string | undefined>,
): { name: string; path: string } | undefined {
	if (!field.locationEnv) return undefined;
	for (const name of field.locationEnv) {
		const path = env[name]?.trim();
		if (path) return {
			name,
			path: env.TELOMI_RESEARCH_SOURCE_BASE_URL?.trim() || path.startsWith("~/") ? path : resolve(
				env.TELOMI_RESEARCH_SOURCE_SERVICE_DIR || fileURLToPath(new URL("../../services/research-source-service", import.meta.url)),
				path,
			),
		};
	}
	return undefined;
}

/** The credential and the environment its scopes are derived from, resolved together, once. */
export interface SearchCredentialCapture {
	env: Record<string, string | undefined>;
	/** Absent when this entry point does not decide what the source authenticates with. */
	credential?: Record<string, string | null>;
}

/**
 * Resolve, in one snapshot, what a request must state and what its scopes are derived from.
 *
 * A separately hosted Source Service authenticates with its own configuration, so a Provider the
 * user has not taken over here is left to it, and the request states nothing rather than blanking
 * out credentials this host cannot see. The moment the user configures or deletes one, that
 * decision travels with the request wherever the service happens to run: an entry point that
 * reports a credential active must be the one the search actually uses.
 */
export function captureSearchCredential(
	sourceId: string,
	env: Record<string, string | undefined>,
): SearchCredentialCapture {
	// Goal snapshots contain Goal credentials, not the service address used by the process client.
	const merged = searchCredentialEnvironmentFor({
		...env,
		TELOMI_RESEARCH_SOURCE_BASE_URL: env.TELOMI_RESEARCH_SOURCE_BASE_URL ?? process.env.TELOMI_RESEARCH_SOURCE_BASE_URL,
	});
	const provider = SEARCH_CREDENTIAL_PROVIDERS.find((entry) => entry.sourceIds.includes(sourceId));
	if (!provider) return { env: merged };
	const managed = isSearchProviderManaged(provider.id);
	if (merged.TELOMI_RESEARCH_SOURCE_BASE_URL?.trim() && !managed) {
		return { env: merged };
	}
	return {
		env: merged,
		credential: searchCredentialOverride(sourceId, managed ? searchCredentialEnvironmentFor({}) : merged),
	};
}

export function legacyEnvNamesInUse(fieldId: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const field = searchCredentialField(fieldId);
	if (!field) return [];
	return field.legacyEnv.filter((name) => Boolean(env[name]?.trim()));
}

/** A recognizable fragment, never the secret. Matches how model Provider keys are summarized. */
export function keyHint(value: string | undefined): string | null {
	if (!value || value.length < 8) return null;
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
