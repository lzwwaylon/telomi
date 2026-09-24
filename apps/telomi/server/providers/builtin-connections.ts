import { existsSync } from "node:fs";
import type { ConnectionCapability } from "../../shared/connections.js";
import { capabilitiesFor } from "../../shared/model-capabilities.js";
import { getRegistryEnvApiKey } from "../agent-runtime/pi-ai.js";
import { readStoredCredentials, type StoredCredentials } from "../accounts/stored-credentials.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { readJson, writeJsonAtomic } from "../lib/fs.js";
import { sha256 } from "../lib/hash.js";
import { discoverCustomProviderModels, loadCustomProviders, type CustomProvider, type CustomProviderModel } from "./custom-models.js";

/**
 * Built-in cloud Providers whose one credential also serves OpenAI-compatible embedding, speech and
 * transcription endpoints, so signing in for chat is enough for every capability page.
 * `oauthIssuesApiKey`: the Provider's OAuth login yields a permanent API key, which pi stores as the
 * credential's `access`, rather than a session token only its chat endpoint accepts.
 */
const BUILTINS: Record<string, { baseUrl: string; oauthIssuesApiKey?: true }> = {
	openrouter: { baseUrl: "https://openrouter.ai/api/v1", oauthIssuesApiKey: true },
	openai: { baseUrl: "https://api.openai.com/v1" },
};

const NON_CHAT: readonly ConnectionCapability[] = ["embedding", "tts", "stt"];
const REDISCOVER_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long a settings request waits for a stale listing, the same bound the chat catalog has. */
const DISCOVERY_WAIT_MS = 4_000;

/** A built-in Provider the user has not replaced with a connection definition of the same id. */
function builtin(id: string) {
	return Object.hasOwn(BUILTINS, id) && !loadCustomProviders().providers?.[id] ? BUILTINS[id] : undefined;
}

/**
 * The API key a connection authenticates with, the way pi resolves it: a stored credential owns the
 * connection, and a built-in Provider falls back to its environment variable only when nothing is
 * stored. A stored OAuth session counts only where the login issued an API key.
 */
export function connectionApiKey(connection: string, credentials: StoredCredentials): string | undefined {
	if (isProviderCredentialDeleted(connection)) return undefined;
	const stored = credentials[connection];
	if (stored?.type === "api_key") return stored.key || undefined;
	if (stored?.type === "oauth") return BUILTINS[connection]?.oauthIssuesApiKey ? stored.access || undefined : undefined;
	if (stored || !builtin(connection)) return undefined;
	try { return getRegistryEnvApiKey(connection as Parameters<typeof getRegistryEnvApiKey>[0]) || undefined; } catch { return undefined; }
}

/** Whether a built-in connection's credential can serve more than chat. */
export function servesEveryCapability(connection: string, credentials: StoredCredentials): boolean {
	return Boolean(builtin(connection) && connectionApiKey(connection, credentials));
}

interface Discovered { credential: string; discoveredAt: number; models: CustomProviderModel[] }

function discoveryPath(): string { return resolveAgentPath("builtin-connection-models.json"); }

function readDiscovered(): Record<string, Discovered> {
	try { return existsSync(discoveryPath()) ? readJson<Record<string, Discovered>>(discoveryPath()) : {}; } catch { return {}; }
}

/** The listing discovery saved under this credential; a listing made with another key says nothing about this one. */
function savedListing(connection: string, key: string | undefined): Discovered | undefined {
	const saved = readDiscovered()[connection];
	return saved && key && saved.credential === sha256(key) ? saved : undefined;
}

/**
 * A built-in connection as the embedding and audio consumers read a connection definition: the
 * Provider's endpoint and the embedding, speech and transcription models discovery last listed.
 * It always requires authorization, never passing as an anonymous local service.
 */
export function builtinConnectionEntry(connection: string, credentials: StoredCredentials = readStoredCredentials(resolveAgentPath("auth.json"))): CustomProvider | undefined {
	const definition = builtin(connection);
	if (!definition) return undefined;
	return { baseUrl: definition.baseUrl, api: "openai-completions", authHeader: true, models: savedListing(connection, connectionApiKey(connection, credentials))?.models ?? [] };
}

const running = new Map<string, Promise<void>>();

/**
 * Relist a built-in connection's non-chat models when its listing is missing, a day old, or made
 * with another credential. The caller waits only briefly; a slow listing finishes in the background
 * and a failed one keeps the previous listing, leaving the model to be typed.
 */
export async function refreshBuiltinConnectionModels(connection: string, credentials: StoredCredentials): Promise<void> {
	const definition = builtin(connection);
	const key = connectionApiKey(connection, credentials);
	if (!definition || !key) return;
	const saved = savedListing(connection, key);
	if (saved && Date.now() - saved.discoveredAt < REDISCOVER_AFTER_MS) return;
	const credential = sha256(key);
	let pass = running.get(credential);
	if (!pass) {
		pass = discoverCustomProviderModels({ baseUrl: definition.baseUrl, apiKey: key })
			.then((models) => {
				const all = readDiscovered();
				all[connection] = { credential, discoveredAt: Date.now(), models: models.filter((model) => capabilitiesFor(model).some((capability) => NON_CHAT.includes(capability))) };
				writeJsonAtomic(discoveryPath(), all, { mode: 0o600 });
			})
			.catch(() => undefined)
			.finally(() => running.delete(credential));
		running.set(credential, pass);
	}
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([pass, new Promise<void>((resolve) => { timer = setTimeout(resolve, DISCOVERY_WAIT_MS); })]);
	clearTimeout(timer);
}
