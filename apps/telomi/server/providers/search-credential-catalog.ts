import { firstEnvValue } from "../lib/env.js";
import { SOURCE_DESCRIPTORS } from "./source-descriptors.js";

/**
 * The already integrated search Providers whose credentials the unified entry point manages.
 *
 * This catalog is closed on purpose: this delivery configures Providers Telomi already implements,
 * it does not let a URL and a key register an arbitrary search API. The fields come from the source
 * descriptors, so the variable the Python Source Service authenticates with, the aliases a deletion
 * has to suppress, and the value the Node cache identity hashes can never drift apart.
 */

export interface SearchCredentialField {
	/** Storage key, request field, and tombstone id. */
	id: string;
	/** The variable the Source Service reads first. Managed values are written here. */
	env: string;
	/** Older names the same credential used to arrive under; they must not outrank a managed value. */
	legacyEnv: readonly string[];
	/** An optional field refines an otherwise usable credential rather than establishing it. */
	optional?: boolean;
	/**
	 * Names that point at the same credential without carrying its value, such as a file the
	 * Provider reads the credential from. The entry point never stores or shows one, but a request
	 * has to state it and a deletion has to suppress it, or the Provider keeps authenticating from
	 * it after the user removed the credential.
	 */
	locationEnv?: readonly string[];
}

export interface SearchCredentialProvider {
	id: string;
	/** The Source Service source ids this credential authenticates. */
	sourceIds: readonly string[];
	fields: readonly SearchCredentialField[];
}

export const SEARCH_CREDENTIAL_PROVIDERS: readonly SearchCredentialProvider[] = SOURCE_DESCRIPTORS
	.flatMap((source) => source.fields ? [{ id: source.id, sourceIds: [source.provider.id], fields: source.fields }] : []);

/**
 * Search credentials share the deletion record with model Provider credentials, so their ids are
 * namespaced: `huggingface` names both a model Provider and a search Provider, and deleting one
 * must not suppress the other's environment.
 */
export const SEARCH_TOMBSTONE_PREFIX = "search:";

export function searchCredentialTombstoneId(fieldId: string): string {
	return `${SEARCH_TOMBSTONE_PREFIX}${fieldId}`;
}

export function searchCredentialProvider(providerId: string): SearchCredentialProvider | undefined {
	return SEARCH_CREDENTIAL_PROVIDERS.find((provider) => provider.id === providerId);
}

export function searchCredentialFields(): readonly SearchCredentialField[] {
	return SEARCH_CREDENTIAL_PROVIDERS.flatMap((provider) => provider.fields);
}

export function searchCredentialField(fieldId: string): SearchCredentialField | undefined {
	return searchCredentialFields().find((field) => field.id === fieldId);
}

/** Every name one credential can arrive under, most authoritative first. */
export function searchCredentialEnvNames(field: SearchCredentialField): string[] {
	return [field.env, ...field.legacyEnv];
}

/** Every name a deletion has to suppress: the credential itself and where it is read from. */
export function searchCredentialSuppressedEnvNames(field: SearchCredentialField): string[] {
	return [...searchCredentialEnvNames(field), ...(field.locationEnv ?? [])];
}

function searchCredentialSourceProvider(sourceId: string): SearchCredentialProvider | undefined {
	return SEARCH_CREDENTIAL_PROVIDERS.find((provider) => provider.sourceIds.includes(sourceId));
}

/**
 * The alias groups the Node cache identity hashes for one Source Service source, in field order.
 * Sources with no managed credential return no groups and stay anonymously scoped.
 */
export function searchCredentialAliasGroups(sourceId: string): string[][] {
	return searchCredentialSourceProvider(sourceId)?.fields.map(searchCredentialEnvNames) ?? [];
}

/**
 * The credential one Source Service request must be answered with, under the canonical names, as
 * resolved from a single environment snapshot. Every managed field is stated, including the ones
 * that have no value, so the service cannot answer from a configuration the caller cannot see:
 * that is what would let a request be served by one credential and cached under another, and what
 * would let a deleted key keep working inside a long-lived service.
 *
 * A location is stated only when the field itself has no value, which is the order the Provider
 * resolves them in: once a value is managed here, the file it used to be read from stops deciding
 * anything and later edits to that file cannot change what a request authenticates with.
 */
export function searchCredentialOverride(
	sourceId: string,
	env: Record<string, string | undefined>,
): Record<string, string | null> | undefined {
	const provider = searchCredentialSourceProvider(sourceId);
	if (!provider) return undefined;
	return Object.fromEntries(provider.fields.flatMap((field) => {
		const value = firstEnvValue(env, searchCredentialEnvNames(field)) ?? null;
		return [
			[field.env, value] as const,
			...(field.locationEnv
				? [[field.locationEnv[0]!, value ? null : firstEnvValue(env, field.locationEnv) ?? null] as const]
				: []),
		];
	}));
}
