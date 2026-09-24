import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { loadCustomProviders } from "../providers/custom-models.js";

/**
 * Wire protocols. A selection names only a connection, and the connection decides which of these
 * it speaks. Adding an OpenAI-compatible service needs no new id, and whether Telomi may run the
 * service is not a protocol question: see `isManagedAudioConnection`.
 */
export const STT_PROTOCOLS = ["openai-transcription", "openrouter-transcription"] as const;
export const TTS_PROTOCOLS = ["openai-speech"] as const;
export type SttProtocol = (typeof STT_PROTOCOLS)[number];
export type TtsProtocol = (typeof TTS_PROTOCOLS)[number];

/**
 * Built-in Provider ids whose transcription endpoint takes JSON rather than multipart. These are
 * catalog identities from the model registry, not names a user typed: an id is only read here
 * after the registry confirms it is one of its own.
 */
const JSON_TRANSCRIPTION_BUILTINS: readonly string[] = ["openrouter"];

/**
 * The wire protocol a connection speaks, from what the catalog says the connection is rather than
 * from how its id is spelled: what the connection declares about itself, then the registry's own
 * identity for it. A user-added connection declares a gateway that takes JSON transcription with
 * `compat.transcription: "json"`; everything else is OpenAI-compatible multipart, including the
 * managed local service.
 */
export function sttProtocolForConnection(connection: unknown): SttProtocol {
	const id = normalizeProviderId(connection);
	const declared = catalogEntry(id)?.compat?.transcription;
	if (declared) return declared === "json" ? "openrouter-transcription" : "openai-transcription";
	return JSON_TRANSCRIPTION_BUILTINS.includes(id) && (getBuiltinProviders() as readonly string[]).includes(id) ? "openrouter-transcription" : "openai-transcription";
}

/** An unreadable catalog fails at the consumer that needs the endpoint, not here in protocol choice. */
function catalogEntry(id: string) {
	try {
		return loadCustomProviders().providers?.[id];
	} catch {
		return undefined;
	}
}

export function normalizeProviderId(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export const OPENAI_CLASSIC_TTS_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
];
export const OPENAI_4O_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];
export const XAI_GROK_TTS_VOICES = ["eve", "ara", "rex", "sal", "leo"];

/** What Telomi knows about a well-known cloud TTS model whose gateway does not report it. */
export interface KnownTtsModel {
  id: string;
  name: string;
  supportedVoices: string[];
  /** The only `response_format` values the model returns; any when absent. */
  responseFormats?: string[];
  /** The model voices Mandarin text reliably only when told the spoken language before it. */
  languageInstruction?: boolean;
}

/** Well-known cloud models keyed by legacy brand id. What a server reports about a model supersedes its entry here. */
export const FALLBACK_TTS_MODELS: Record<string, KnownTtsModel[]> = {
  "openai-tts": [
    {
      id: "tts-1",
      name: "OpenAI TTS-1",
      supportedVoices: OPENAI_CLASSIC_TTS_VOICES,
    },
    {
      id: "tts-1-hd",
      name: "OpenAI TTS-1 HD",
      supportedVoices: OPENAI_CLASSIC_TTS_VOICES,
    },
    {
      id: "gpt-4o-mini-tts",
      name: "OpenAI GPT-4o Mini TTS",
      supportedVoices: OPENAI_4O_TTS_VOICES,
    },
  ],
  "openrouter-tts": [
    {
      id: "x-ai/grok-voice-tts-1.0",
      name: "xAI: Grok Voice TTS 1.0",
      supportedVoices: XAI_GROK_TTS_VOICES,
    },
    {
      id: "openai/gpt-4o-mini-tts-2025-12-15",
      name: "OpenAI: GPT-4o Mini TTS",
      supportedVoices: OPENAI_4O_TTS_VOICES,
    },
    {
      id: "google/gemini-3.1-flash-tts-preview",
      name: "Google: Gemini 3.1 Flash TTS Preview",
      supportedVoices: [
        "Zephyr",
        "Puck",
        "Charon",
        "Kore",
        "Fenrir",
        "Leda",
        "Orus",
        "Aoede",
      ],
      responseFormats: ["pcm"],
      languageInstruction: true,
    },
  ],
};

/**
 * The catalog-known model with this id, from whichever brand table lists it. A selection no longer
 * names a brand, so the id alone decides: a model listed for one gateway is accepted on any
 * connection that serves it.
 */
export function knownTtsModel(id: string): KnownTtsModel | undefined {
  return Object.values(FALLBACK_TTS_MODELS).flat().find((model) => model.id === id);
}
