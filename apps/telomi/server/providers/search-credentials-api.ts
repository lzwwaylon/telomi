/**
 * The unified entry point for the credentials of the already integrated search Providers.
 *
 * Saving for later prepares a key without changing what any search calls with. Applying asks the
 * Provider about the candidate through a throwaway source in the Source Service, so an unproven
 * key is never the credential in use and a rejection leaves the working configuration untouched.
 * Only then is it published, as one set and only while it is still the newest decision.
 *
 * There is nothing to keep in step afterwards: the Runtime resolves the credential for each search
 * from this store and states it on the request, so the Source Service answers with exactly the
 * value the request's cache scope was derived from. A rotation reaches the next request, a request
 * already sent finishes on the credential it started with, and a deleted key cannot keep serving
 * from a long-lived service or come back from the environment after a restart.
 */
import { browserSessionOwns } from "../config/local-credentials.js";
import type { Express, Request, Response } from "express";

import { redactSecret } from "../agent-runtime/model-connectivity.js";
import {
	clearProviderCredentialTombstone,
	isProviderCredentialDeleted,
	markProviderCredentialDeleted,
} from "../config/credential-tombstones.js";
import { toErrorMessage } from "../lib/values.js";
import { loadSettings, saveSettings } from "../config/settings.js";
import { getSourceStatusMonitor, type SourceStatusMonitor } from "./source-status.js";
import {
	SEARCH_CREDENTIAL_PROVIDERS,
	searchCredentialProvider,
	searchCredentialOverride,
	searchCredentialTombstoneId,
	type SearchCredentialField,
	type SearchCredentialProvider,
} from "./search-credential-catalog.js";
import { sourceDescriptor } from "./source-descriptors.js";
import {
	applySearchCredentialEnvironment,
	clearImportedProvenance,
	credentialLocation,
	discardConsumedStagedCredential,
	isSearchProviderManaged,
	keyHint,
	legacyEnvNamesInUse,
	publishSearchCredentials,
	readCredentialLocation,
	readPendingSearchCredential,
	readSearchCredential,
	removeSearchCredential,
	searchCredentialProvenance,
	stageSearchCredential,
} from "./search-credentials.js";

/** The Source Service seam. Injected so this module stays free of the transport. */
export interface SearchCredentialServiceClient {
	verifyCredential(sourceId: string, credential: Record<string, string | null>): Promise<void>;
}

export interface SearchCredentialsDependencies {
	sourceService: SearchCredentialServiceClient;
	env?: NodeJS.ProcessEnv;
	/** Receives the outcome of an activation or deletion, so the source status is never staler than the credential. */
	statuses?: SourceStatusMonitor;
}

interface FieldStatus {
	id: string;
	env: string;
	optional: boolean;
	configured: boolean;
	keyHint: string | null;
	provenance: "user" | "imported" | "browser" | null;
	pendingConfigured: boolean;
	deleted: boolean;
	legacyEnvSet: string[];
	/** A file this credential would be read from while no value is managed here. */
	locationEnv: string | null;
	/** Why that file was not adopted, when it could not be. Never its contents. */
	locationError: string | null;
}

export interface SearchProviderStatus {
	id: string;
	sourceIds: string[];
	status: "active" | "pending" | "unconfigured";
	/** Why a stored credential is not what the Provider actually authenticates with. */
	pendingReason: string | null;
	fields: FieldStatus[];
}

/**
 * A separately hosted Source Service authenticates with its own configuration until the user takes
 * a Provider over here. While they have not, this entry point cannot say what that Provider uses,
 * and saying so is the only honest answer. Once they configure or delete a credential, the request
 * states it wherever the service runs, so there is nothing left to report.
 */
function unmanagedRemoteReason(provider: SearchCredentialProvider, env: NodeJS.ProcessEnv): string | null {
	const remote = env.TELOMI_RESEARCH_SOURCE_BASE_URL?.trim();
	if (!remote || isSearchProviderManaged(provider.id)) return null;
	return "the separately hosted Source Service authenticates with its own configuration";
}

function describeField(field: SearchCredentialField, env: NodeJS.ProcessEnv): FieldStatus {
	const active = readSearchCredential(field.id);
	// The user's live browser login stands in for a credential until one is managed here.
	const browser = active === undefined && browserSessionOwns(field.env);
	// A file only matters while no value is managed here; once one is, the request stops naming it.
	const deleted = isProviderCredentialDeleted(searchCredentialTombstoneId(field.id));
	const location = active === undefined && !deleted ? credentialLocation(field, env) : undefined;
	const read = location && !env.TELOMI_RESEARCH_SOURCE_BASE_URL?.trim()
		? readCredentialLocation(location.path) : undefined;
	return {
		id: field.id,
		env: field.env,
		optional: Boolean(field.optional),
		configured: active !== undefined || browser,
		keyHint: keyHint(active),
		provenance: browser ? "browser" : searchCredentialProvenance(field.id),
		pendingConfigured: readPendingSearchCredential(field.id) !== undefined,
		deleted,
		legacyEnvSet: legacyEnvNamesInUse(field.id, env),
		locationEnv: location?.name ?? null,
		locationError: read && "error" in read ? read.error : null,
	};
}

export function describeSearchProvider(provider: SearchCredentialProvider, env: NodeJS.ProcessEnv): SearchProviderStatus {
	const fields = provider.fields.map((field) => describeField(field, env));
	const configured = fields.some((field) => !field.optional && field.configured);
	// Every search resolves its credential from this store and states it on its own request, so a
	// published credential is what the next request uses, on any service host.
	const pendingReason = unmanagedRemoteReason(provider, env);
	return {
		id: provider.id,
		sourceIds: [...provider.sourceIds],
		status: pendingReason ? "pending" : configured ? "active" : "unconfigured",
		pendingReason,
		fields,
	};
}

function buildResponse(env: NodeJS.ProcessEnv) {
	const providers = SEARCH_CREDENTIAL_PROVIDERS.map((provider) => describeSearchProvider(provider, env));
	const pending = providers.filter((provider) => provider.status === "pending");
	return {
		providers,
		consumers: [{
			id: "sourceService",
			status: pending.length > 0 ? "pending" as const : "active" as const,
			pendingProviders: pending.map((provider) => provider.id),
		}],
	};
}

function parseValues(
	provider: SearchCredentialProvider,
	body: unknown,
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "values must be an object" };
	}
	const values: Record<string, string> = {};
	for (const [id, raw] of Object.entries(body as Record<string, unknown>)) {
		const field = provider.fields.find((entry) => entry.id === id);
		if (!field) return { ok: false, error: `unknown credential field '${id}' for '${provider.id}'` };
		if (typeof raw !== "string") return { ok: false, error: `${id} must be a string` };
		const trimmed = raw.trim();
		if (trimmed) values[id] = trimmed;
	}
	return { ok: true, values };
}

/**
 * The candidate exactly as a request would state it, so the Provider is asked about the credential
 * that will actually be used: a value replaces the file it would otherwise be read from.
 */
function candidateCredential(
	provider: SearchCredentialProvider,
	resolved: Record<string, string | null>,
): Record<string, string | null> {
	return searchCredentialOverride(provider.sourceIds[0]!, Object.fromEntries(
		provider.fields.map((field) => [field.env, resolved[field.id] ?? undefined]),
	))!;
}

function redactAll(message: string, secrets: Array<string | null>): string {
	return secrets.reduce<string>(
		(text, secret) => (secret ? redactSecret(text, secret) : text),
		message,
	);
}

export function mountSearchCredentialsApi(app: Express, deps: SearchCredentialsDependencies): void {
	const env = deps.env ?? process.env;

	app.get("/api/search-credentials", (_req: Request, res: Response) => {
		try {
			res.json(buildResponse(env));
		} catch (error) {
			res.status(500).json({ error: toErrorMessage(error) });
		}
	});

	app.put("/api/search-credentials/:provider", async (req: Request, res: Response) => {
		const provider = searchCredentialProvider(
			typeof req.params.provider === "string" ? req.params.provider : "",
		);
		if (!provider) {
			res.status(400).json({ error: `unknown search Provider '${String(req.params.provider)}'` });
			return;
		}
		const body = (req.body || {}) as { values?: unknown; mode?: unknown };
		const mode = body.mode === "pending" ? "pending" : "apply";
		const parsed = parseValues(provider, body.values ?? {});
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		try {
			if (mode === "pending") {
				if (Object.keys(parsed.values).length === 0) {
					res.status(400).json({ error: "at least one credential value is required" });
					return;
				}
				// Save for later: prepared, and deliberately invisible to every consumer.
				for (const [id, value] of Object.entries(parsed.values)) stageSearchCredential(id, value);
				res.json(buildResponse(env));
				return;
			}
			await applyProvider(deps, env, provider, parsed.values, res);
		} catch (error) {
			// Whatever failed, the diagnostic leaves this process without the values involved.
			res.status(500).json({
				error: redactAll(toErrorMessage(error), [
					...Object.values(parsed.values),
					...provider.fields.map((field) => readSearchCredential(field.id) ?? null),
				]),
			});
		}
	});

	app.delete("/api/search-credentials/:provider", (req: Request, res: Response) => {
		const provider = searchCredentialProvider(
			typeof req.params.provider === "string" ? req.params.provider : "",
		);
		if (!provider) {
			res.status(400).json({ error: `unknown search Provider '${String(req.params.provider)}'` });
			return;
		}
		try {
			// Deleting means deleted: the stored value, the staged copy and every environment alias
			// go, and the deletion is recorded so a restart that reloads `.env*` cannot revive it.
			// The next search resolves no credential for this Provider and says so on the request,
			// so a service that is already running cannot keep answering with the old key either.
			for (const field of provider.fields) {
				removeSearchCredential(field.id);
				clearImportedProvenance(field.id);
				markProviderCredentialDeleted(searchCredentialTombstoneId(field.id), env);
			}
			(deps.statuses ?? getSourceStatusMonitor()).record(
				provider.id,
				sourceDescriptor(provider.id)?.auth === "browser_session" ? "needs_login" : "unconfigured",
			);
			res.json(buildResponse(env));
		} catch (error) {
			res.status(500).json({ error: toErrorMessage(error) });
		}
	});
}

async function applyProvider(
	deps: SearchCredentialsDependencies,
	env: NodeJS.ProcessEnv,
	provider: SearchCredentialProvider,
	typed: Record<string, string>,
	res: Response,
): Promise<void> {
	const before = new Map(provider.fields.map((field) => [field.id, {
		key: readSearchCredential(field.id),
		deleted: isProviderCredentialDeleted(searchCredentialTombstoneId(field.id)),
	}]));
	const consumed = new Map<string, string>();
	const resolved: Record<string, string | null> = {};
	for (const field of provider.fields) {
		const staged = typed[field.id] ? undefined : readPendingSearchCredential(field.id);
		if (staged) consumed.set(field.id, staged);
		resolved[field.id] = typed[field.id] ?? staged ?? before.get(field.id)!.key ?? null;
	}
	const required = provider.fields.filter((field) => !field.optional);
	if (required.every((field) => resolved[field.id] === null)) {
		res.status(400).json({ error: `a credential value is required for '${provider.id}'` });
		return;
	}
	const changed = provider.fields.filter((field) => resolved[field.id] !== (before.get(field.id)!.key ?? null));

	// Ask the Provider about the candidate without it becoming anything's credential. Nothing has
	// been written, so a rejection leaves the credential in use exactly as it was.
	if (changed.length > 0) {
		try {
			await deps.sourceService.verifyCredential(
				provider.sourceIds[0]!,
				candidateCredential(provider, resolved),
			);
		} catch (error) {
			// Providers routinely quote a rejected key back. Scrub the candidate and the credential
			// it would have replaced, so neither reaches the response, the status or a log.
			res.status(422).json({
				error: redactAll(toErrorMessage(error), [
					...Object.values(resolved),
					...[...before.values()].map((entry) => entry.key ?? null),
				]),
				...buildResponse(env),
			});
			return;
		}
	}

	// Check the entire validated set and replace it in one atomic write. A competing edit to an
	// unchanged field also invalidates the candidate combination.
	const previousSettings = loadSettings();
	if (!publishSearchCredentials(resolved, before)) {
		res.status(409).json({
			error: `the credential for '${provider.id}' changed while this one was validated`
				+ ` (${provider.fields.map((field) => field.id).join(", ")})`,
			...buildResponse(env),
		});
		return;
	}
	try {
		for (const field of changed) {
			if (resolved[field.id] !== null) clearProviderCredentialTombstone(searchCredentialTombstoneId(field.id));
			clearImportedProvenance(field.id);
		}
		for (const [id, staged] of consumed) discardConsumedStagedCredential(id, staged);
	} catch (error) {
		// Metadata or pending-store failure must not leave a failed activation serving new keys.
		publishSearchCredentials(
			Object.fromEntries([...before].map(([id, value]) => [id, value.key ?? null])),
			new Map(provider.fields.map((field) => [field.id, {
				key: resolved[field.id] ?? undefined,
				deleted: isProviderCredentialDeleted(searchCredentialTombstoneId(field.id)),
			}])),
		);
		saveSettings(previousSettings);
		throw error;
	}
	// Keep the process environment on whatever the store now holds, so a Source Service started
	// later, or a consumer that reads the environment rather than this store, sees the same thing.
	applySearchCredentialEnvironment(env);
	// The Provider just accepted this credential, which is exactly what a verification establishes.
	(deps.statuses ?? getSourceStatusMonitor()).record(provider.id, "ok");
	res.json(buildResponse(env));
}
