import type { SpeechSelection } from "../../shared/speech-configuration.js";
import type { AudioGenerationSelection } from "../../shared/audio-generation.js";

/**
 * Writes a managed speech selection into the current data directory the way an applied settings
 * page configuration would. Tests call this after pointing `TELOMI_DATA_DIR` at a temporary directory.
 */
export async function configureManagedSpeech(selection: SpeechSelection & { baseUrl: string; apiKey?: string }): Promise<void> {
	const { loadSettings, saveSettings } = await import("../../server/config/settings.js");
	const { loadCustomProviders, saveCustomProviders } = await import("../../server/providers/custom-models.js");
	const { writeStoredCredential } = await import("../../server/accounts/stored-credentials.js");
	const { resolveAgentPath } = await import("../../server/config/agent-directory.js");
	const catalog = loadCustomProviders();
	catalog.providers ??= {};
	catalog.providers[selection.connection] = { baseUrl: selection.baseUrl, api: "openai-completions", capability: "audio-recognition", models: [{ id: selection.model }] };
	saveCustomProviders(catalog);
	if (selection.apiKey) writeStoredCredential(resolveAgentPath("auth.json"), selection.connection, { type: "api_key", key: selection.apiKey });
	const { baseUrl: _baseUrl, apiKey: _apiKey, ...selected } = selection;
	saveSettings({ ...loadSettings(), speechRecognition: { default: selected, cleanupEnabled: false, cleanupInstructions: "" } });
}

/** Same as `configureManagedSpeech` for the audio generation default selection. */
export async function configureManagedAudioGeneration(selection: AudioGenerationSelection & { baseUrl: string; apiKey?: string }): Promise<void> {
	const { loadSettings, saveSettings } = await import("../../server/config/settings.js");
	const { loadCustomProviders, saveCustomProviders } = await import("../../server/providers/custom-models.js");
	const { writeStoredCredential } = await import("../../server/accounts/stored-credentials.js");
	const { resolveAgentPath } = await import("../../server/config/agent-directory.js");
	const catalog = loadCustomProviders();
	catalog.providers ??= {};
	catalog.providers[selection.connection] = { baseUrl: selection.baseUrl, api: "openai-completions", capability: "audio-generation", models: [{ id: selection.model }] };
	saveCustomProviders(catalog);
	if (selection.apiKey) writeStoredCredential(resolveAgentPath("auth.json"), selection.connection, { type: "api_key", key: selection.apiKey });
	const { baseUrl: _baseUrl, apiKey: _apiKey, ...selected } = selection;
	saveSettings({ ...loadSettings(), audioGeneration: { default: selected } });
}
