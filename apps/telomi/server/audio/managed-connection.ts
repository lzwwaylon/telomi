import { isDeepStrictEqual } from "node:util";
import { MANAGED_AUDIO_CONNECTION_ID } from "../../shared/connections.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { discoverCustomProviderModels, loadCustomProviders, mergeDiscoveredModels, writeCustomProvider } from "../providers/custom-models.js";
import { sameEndpoint } from "./local-runtime.js";

/**
 * List the bundled local runtime as the managed connection, with the models and voices it serves,
 * so the settings pages can choose, test and preview them like any other connection. It runs when
 * the runtime turns healthy. A managed connection the user deleted or pointed at another address
 * is left as it is.
 */
export async function listManagedAudioConnection(baseUrl: string): Promise<void> {
	if (isProviderCredentialDeleted(MANAGED_AUDIO_CONNECTION_ID)) return;
	const existing = loadCustomProviders().providers?.[MANAGED_AUDIO_CONNECTION_ID];
	if (existing && !sameEndpoint(existing.baseUrl, baseUrl)) return;
	const discovered = await discoverCustomProviderModels({ baseUrl });
	const next = { ...existing, baseUrl: existing?.baseUrl ?? baseUrl, api: existing?.api ?? "openai-completions" as const, models: mergeDiscoveredModels(existing?.models ?? [], discovered) };
	if (!isDeepStrictEqual(next, existing)) writeCustomProvider(MANAGED_AUDIO_CONNECTION_ID, next);
}
