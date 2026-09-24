import { isDeepStrictEqual } from "node:util";

import type { Express, Request, Response } from "express";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	resolveRegistryModel,
	redactSecret,
	testCandidateCredential,
	testConfiguredModel,
	type CandidateAuthorization,
} from "../agent-runtime/model-connectivity.js";
import { cleanupProviderSettings } from "../providers/settings-cleanup.js";
import { getRegistryEnvApiKey } from "../agent-runtime/pi-ai.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import {
	clearProviderCredentialTombstone,
	isProviderCredentialDeleted,
	markProviderCredentialDeleted,
} from "../config/credential-tombstones.js";
import {
	modifyStoredCredential,
	readStoredCredentials,
	writeStoredCredential,
} from "./stored-credentials.js";
import { toErrorMessage } from "../lib/values.js";
import { accountManagerFor } from "./manager.js";
import type { AccountCredential } from "./types.js";

const AUTH_PATH = resolveAgentPath("auth.json");
const MODELS_PATH = resolveAgentPath("models.json");
/**
 * Credentials saved for later. No consumer reads this file, so preparing a connection cannot
 * change what running work authenticates with.
 */
const PENDING_AUTH_PATH = resolveAgentPath("auth-pending.json");

function summarizeEntry(entry: Credential | undefined): {
	configured: boolean;
	type: "api_key" | "oauth" | "unknown" | null;
	keyHint: string | null;
} {
	if (!entry || typeof entry !== "object") return { configured: false, type: null, keyHint: null };
	if (entry.type === "api_key") {
		const key = entry.key;
		return {
			configured: typeof key === "string" && key.length > 0,
			type: "api_key",
			keyHint: typeof key === "string" && key.length >= 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : null,
		};
	}
	if (entry.type === "oauth") {
		const access = entry.access;
		return {
			configured: typeof access === "string" && access.length > 0,
			type: "oauth",
			keyHint: null,
		};
	}
	return { configured: Object.keys(entry).length > 0, type: "unknown", keyHint: null };
}

interface ProviderAuthInfo {
	id: string;
	envName: string | null;
	envSet: boolean;
	authEntry: ReturnType<typeof summarizeEntry>;
	/** Prepared but not in use. */
	pendingEntry: ReturnType<typeof summarizeEntry>;
}

function describeProvider(
	id: string,
	auth: Record<string, Credential>,
	pending: Record<string, Credential> = {},
): ProviderAuthInfo {
	let envName: string | null = null;
	let envSet = false;
	try {
		envSet = Boolean(getRegistryEnvApiKey(id as Parameters<typeof getRegistryEnvApiKey>[0]));
	} catch {
		// Custom or future providers may not have a compat environment resolver.
	}
	const ENV_NAMES: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		"openai-codex": "OPENAI_API_KEY",
		anthropic: "ANTHROPIC_API_KEY",
		google: "GEMINI_API_KEY",
		"google-vertex": "GOOGLE_VERTEX_API_KEY",
		groq: "GROQ_API_KEY",
		mistral: "MISTRAL_API_KEY",
		xai: "XAI_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		huggingface: "HF_TOKEN",
		"vercel-ai-gateway": "VERCEL_AI_GATEWAY_API_KEY",
		"amazon-bedrock": "AWS_ACCESS_KEY_ID",
		"azure-openai-responses": "AZURE_OPENAI_API_KEY",
		"github-copilot": "GITHUB_TOKEN",
		"kimi-coding": "KIMI_API_KEY",
		minimax: "MINIMAX_API_KEY",
		"minimax-cn": "MINIMAX_API_KEY",
		"google-antigravity": "GOOGLE_ANTIGRAVITY_TOKEN",
		"google-gemini-cli": "GEMINI_API_KEY",
		opencode: "OPENCODE_API_KEY",
		"opencode-go": "OPENCODE_API_KEY",
		zai: "ZAI_API_KEY",
	};
	envName = ENV_NAMES[id] ?? null;
	if (envName && process.env[envName]) envSet = true;

	return {
		id,
		envName,
		envSet,
		authEntry: summarizeEntry(auth[id]),
		pendingEntry: summarizeEntry(pending[id]),
	};
}

function describeCurrentProvider(id: string): ProviderAuthInfo {
	return describeProvider(id, readStoredCredentials(AUTH_PATH), readStoredCredentials(PENDING_AUTH_PATH));
}

/**
 * The authorization a staged credential would send. An API key travels as itself; an OAuth
 * credential is resolved in an isolated store, so a concurrent login cannot replace the candidate
 * and refreshing its token cannot overwrite a newer pending credential.
 */
async function candidateAuthorization(
	provider: string,
	candidate: Credential,
): Promise<{ ok: true; auth: CandidateAuthorization; credential: Credential } | { ok: false; error: string }> {
	if (candidate.type === "api_key") return { ok: true, auth: { apiKey: candidate.key }, credential: candidate };
	try {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(provider, async () => structuredClone(candidate));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: MODELS_PATH });
		const resolution = await runtime.getAuth(provider);
		if (!resolution) return { ok: false, error: `provider '${provider}' did not resolve the prepared authorization` };
		const credential = await credentials.read(provider);
		if (!credential) return { ok: false, error: `provider '${provider}' did not retain the prepared authorization` };
		return {
			ok: true,
			credential,
			auth: {
				...(resolution.auth.apiKey ? { apiKey: resolution.auth.apiKey } : {}),
				...(resolution.auth.headers ? { headers: resolution.auth.headers as Record<string, string> } : {}),
			},
		};
	} catch (err) {
		return {
			ok: false,
			error: [candidate.access, candidate.refresh].reduce((message, secret) => redactSecret(message, secret), toErrorMessage(err)),
		};
	}
}

/**
 * Check a candidate credential against the Provider before it becomes the active one. Nothing is
 * written to auth.json for this, so a rejected candidate cannot be picked up by a concurrent
 * request and the credential in use survives the failure untouched.
 */
async function validateCandidate(
	provider: string,
	modelId: string,
	candidate: Credential,
): Promise<{ ok: true; credential: Credential } | { ok: false; error: string }> {
	const resolved = await resolveRegistryModel(provider, modelId, { authPath: AUTH_PATH, modelsPath: MODELS_PATH });
	if (!resolved.ok) return resolved;
	const authorization = await candidateAuthorization(provider, candidate);
	if (!authorization.ok) return authorization;
	const result = await testCandidateCredential(resolved.model, authorization.auth);
	return result.ok
		? { ok: true, credential: authorization.credential }
		: { ok: false, error: result.error ?? "the connection test failed" };
}

function testProviderWithModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string; durationMs: number }> {
	return testConfiguredModel(provider, modelId, { authPath: AUTH_PATH, modelsPath: MODELS_PATH });
}

export function mountAuthApi(app: Express): void {
	app.get("/api/auth", (_req: Request, res: Response) => {
		try {
			const auth = readStoredCredentials(AUTH_PATH);
			const pending = readStoredCredentials(PENDING_AUTH_PATH);
			const providers = getBuiltinProviders().map((id) => describeProvider(id, auth, pending));
			res.json({ providers });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.put("/api/auth/:provider", async (req: Request, res: Response) => {
		const provider = typeof req.params.provider === "string" ? req.params.provider : "";
		if (!provider || !getBuiltinProviders().some((id) => id === provider)) {
			res.status(400).json({ error: `unknown provider '${provider}'` });
			return;
		}
		const body = (req.body || {}) as { key?: unknown; mode?: unknown; modelId?: unknown };
		const mode = body.mode === "pending" ? "pending" : "apply";
		const typed = typeof body.key === "string" ? body.key.trim() : "";
		try {
			if (mode === "pending") {
				if (!typed) {
					res.status(400).json({ error: "key is required" });
					return;
				}
				// Save for later: prepared, and deliberately invisible to every consumer.
				writeStoredCredential(PENDING_AUTH_PATH, provider, { type: "api_key", key: typed });
				res.json(describeCurrentProvider(provider));
				return;
			}
			const staged = readStoredCredentials(PENDING_AUTH_PATH)[provider];
			// Apply activates what the user prepared, whether that is a typed key or an
			// authorization an OAuth login obtained into the pending store.
			const candidate: Credential | undefined = typed ? { type: "api_key", key: typed } : staged;
			if (!candidate) {
				res.status(400).json({ error: "no prepared credential to apply" });
				return;
			}
			const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
			if (!modelId) {
				res.status(400).json({ error: "modelId is required to validate the connection" });
				return;
			}
			const before = readStoredCredentials(AUTH_PATH)[provider];
			const deletedBefore = isProviderCredentialDeleted(provider);
			const validation = await validateCandidate(provider, modelId, candidate);
			if (!validation.ok) {
				// Nothing was published, so the credential in use is exactly what it was.
				res.status(422).json({ error: validation.error, ...describeCurrentProvider(provider) });
				return;
			}
			// This includes any OAuth refresh performed in the candidate's isolated store.
			const activated = validation.credential;
			// Activate only if this request is still the newest edit for this Provider.
			const replaced = modifyStoredCredential(AUTH_PATH, provider, (current) => {
				if (!isDeepStrictEqual(current, before)) return undefined;
				if (isProviderCredentialDeleted(provider) !== deletedBefore) return undefined;
				return activated;
			});
			if (!replaced) {
				res.status(409).json({
					error: `the credential for '${provider}' changed while this one was validated`,
					...describeCurrentProvider(provider),
				});
				return;
			}
			// Drop only the staged value this request consumed; a draft saved while it was
			// validating is a newer decision and stays.
			if (staged) {
				modifyStoredCredential(PENDING_AUTH_PATH, provider, (current) =>
					isDeepStrictEqual(current, staged) ? null : undefined);
			}
			clearProviderCredentialTombstone(provider);
			// The applied credential joins the provider's account chain as the active entry, so
			// later applies add siblings instead of overwriting, and runtime failover can rotate.
			const chain = accountManagerFor(provider);
			await chain.load();
			// A credential that predates the chain is the group's first account, not a casualty.
			if (!chain.hasAnyAccount() && before) await chain.importOrUpdate({ credential: before as AccountCredential });
			await chain.importOrUpdate({ credential: activated as AccountCredential, activate: true });
			res.json(describeCurrentProvider(provider));
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.delete("/api/auth/:provider", async (req: Request, res: Response) => {
		const provider = typeof req.params.provider === "string" ? req.params.provider : "";
		if (!provider) {
			res.status(400).json({ error: "provider is required" });
			return;
		}
		try {
			writeStoredCredential(AUTH_PATH, provider, null);
			// Deleting means deleted: no staged copy, no environment value and no account chain
			// entry brings it back. Single accounts are removed from the chain in Connections.
			writeStoredCredential(PENDING_AUTH_PATH, provider, null);
			markProviderCredentialDeleted(provider);
			const chain = accountManagerFor(provider);
			await chain.load();
			await chain.clear();
			const cleanup = cleanupProviderSettings(provider);
			res.json({ ...describeCurrentProvider(provider), cleanup });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.post("/api/auth/:provider/test", async (req: Request, res: Response) => {
		const provider = typeof req.params.provider === "string" ? req.params.provider : "";
		if (!provider || !getBuiltinProviders().some((id) => id === provider)) {
			res.status(400).json({ error: `unknown provider '${provider}'` });
			return;
		}
		const body = (req.body || {}) as { modelId?: unknown };
		const modelId = typeof body.modelId === "string" ? body.modelId : "";
		if (!modelId) {
			res.status(400).json({ error: "modelId is required" });
			return;
		}
		const result = await testProviderWithModel(provider, modelId);
		res.status(result.ok ? 200 : 502).json(result);
	});
}
