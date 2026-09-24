import { type VoiceLocalRuntimeStatus } from "@/features/settings/VoiceLocalRuntimeSettings";
import { type VoiceVadConfigValue } from "@/features/settings/VoiceVadSettings";

/**
 * The voice a selection keeps when its model changes. A model that lists voices keeps only one of
 * them, otherwise the server's default speaks; a model that lists none keeps a typed voice, so a
 * model id typed by hand does not wipe it keystroke by keystroke.
 */
export function keptVoice(voice: string, listed: readonly string[]): string {
  return listed.length === 0 || listed.includes(voice) ? voice : "";
}

interface AudioConfigValue {
  sttLanguage: string;
  audioCuesEnabled: boolean;
  sttVad: VoiceVadConfigValue;
}

export interface AudioConfigResponse {
  config: AudioConfigValue;
  telomiAudio: {
    runtime: VoiceLocalRuntimeStatus;
  };
}
