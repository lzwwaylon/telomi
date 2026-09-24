import { loadSettings } from "../../config/settings.js";
import { resolveSpeechConfiguration } from "../../voice/configuration.js";
import { normalizeVoiceVadConfig, type VoiceVadConfig } from "../voice-vad.js";

/** Voice preferences kept under `settings.audio`. Model, connection and credential selection live in the unified speech and audio configuration. */
export interface AudioSettings {
  sttLanguage?: string;
  sttCleanupEnabled: boolean;
  sttCleanupModel: string;
  sttCleanupInstructions: string;
  audioCuesEnabled?: boolean;
  sttVad?: VoiceVadConfig;
}

export function loadAudioSettings(): AudioSettings {
  const settings = loadSettings();
  const audio = settings.audio;
  const obj = audio && typeof audio === "object" && !Array.isArray(audio) ? audio as Record<string, unknown> : {};
  const speech = resolveSpeechConfiguration(settings);
  return {
    sttLanguage:
      typeof obj.sttLanguage === "string" ? obj.sttLanguage : undefined,
    sttCleanupEnabled: speech.cleanupEnabled,
    sttCleanupModel: speech.cleanupModel ?? "",
    sttCleanupInstructions: speech.cleanupInstructions,
    audioCuesEnabled:
      typeof obj.audioCuesEnabled === "boolean"
        ? obj.audioCuesEnabled
        : undefined,
    sttVad: normalizeVoiceVadConfig(obj.sttVad),
  };
}
