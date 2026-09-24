import { isManagedAudioConnection } from "./connections.js";

export type VoiceTranscriptionFailureCode =
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER_ERROR"
  | "OFFLINE"
  | "AUTH_EXPIRED"
  | "AUTH_REQUIRED"
  | "LIMIT_REACHED"
  | "PROVIDER_RATE_LIMITED"
  | "API_KEY_MISSING"
  | "INVALID_KEY"
  | "MODEL_NOT_AVAILABLE";

export type VoiceHistoryFailureGuidanceKind =
  "configuration" | "connection" | "limit" | "transient";

export type VoiceHistoryFailureSettingsTarget =
  "local-runtime" | "self-hosted-stt" | "stt-provider";

export type VoiceHistoryFailureGuidanceMessageCode =
  | "configuration-retry-retained"
  | "configuration-next-recording"
  | "offline-retry-retained"
  | "offline-record-again"
  | "local-runtime-retry-retained"
  | "local-runtime-record-again"
  | "self-hosted-retry-retained"
  | "self-hosted-record-again"
  | "connection-retry-retained"
  | "connection-record-again"
  | "limit-reached"
  | "rate-limited"
  | "timeout-retry-retained"
  | "timeout-record-again"
  | "server-retry-retained"
  | "server-record-again";

export type VoiceHistoryFailureGuidanceActionCode =
  | "open-transcription-settings"
  | "open-local-runtime"
  | "open-self-hosted-stt";

export interface VoiceHistoryFailureGuidance {
  kind: VoiceHistoryFailureGuidanceKind;
  messageCode: VoiceHistoryFailureGuidanceMessageCode;
  actionCode?: VoiceHistoryFailureGuidanceActionCode;
  settingsTarget?: VoiceHistoryFailureSettingsTarget;
}

const CONFIGURATION_CODES = new Set<string>([
  "API_KEY_MISSING",
  "INVALID_KEY",
  "MODEL_NOT_AVAILABLE",
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
]);

export function classifyVoiceTranscriptionFailure(
  provider: string,
  reason: string,
): VoiceTranscriptionFailureCode | undefined {
  const normalized = reason.trim();
  if (!normalized || isExpectedNoAudioOrCancellation(normalized)) {
    return undefined;
  }
  if (
    /(?:api[ _-]?key|credential|token).{0,40}(?:not set|not found|missing|required)/i.test(
      normalized,
    ) ||
    /(?:not set|not found|missing|required).{0,40}(?:api[ _-]?key|credential|token)/i.test(
      normalized,
    )
  ) {
    return "API_KEY_MISSING";
  }
  if (/\b(?:auth(?:entication)? required|login required)\b/i.test(normalized)) {
    return "AUTH_REQUIRED";
  }
  if (/\b(?:auth|token|session).{0,20}expired\b/i.test(normalized)) {
    return "AUTH_EXPIRED";
  }
  if (
    /\b(?:401|403)\b/.test(normalized) ||
    /\b(?:invalid|incorrect|unauthorized).{0,24}(?:api[ _-]?key|credential|token)\b/i.test(
      normalized,
    )
  ) {
    return "INVALID_KEY";
  }
  if (
    /\bmodel\b.{0,80}\b(?:not available|not found|does not exist|unknown|unsupported)\b/i.test(
      normalized,
    ) ||
    /\b(?:not available|not found|does not exist|unknown|unsupported)\b.{0,40}\bmodel\b/i.test(
      normalized,
    )
  ) {
    return "MODEL_NOT_AVAILABLE";
  }
  if (/\b(?:you(?:'|’)re|you are|currently) offline\b/i.test(normalized)) {
    return "OFFLINE";
  }
  if (
    /\b(?:insufficient[_ -]?quota|quota exceeded|daily limit|usage limit|limit reached)\b/i.test(
      normalized,
    ) &&
    !/\brate limit\b/i.test(normalized)
  ) {
    return "LIMIT_REACHED";
  }
  if (
    /\b429\b|\brate[ _-]?limit(?:ed)?\b|\btoo many requests\b/i.test(normalized)
  ) {
    return "PROVIDER_RATE_LIMITED";
  }
  if (/\b(?:timed? out|timeout)\b/i.test(normalized)) {
    return "TIMEOUT";
  }
  if (/\bHTTP\s+5\d\d\b|\b5\d\d\s+(?:server|service)\b/i.test(normalized)) {
    return "SERVER_ERROR";
  }
  if (
    /\b(?:fetch failed|failed to fetch|network error|connection refused|econnrefused|enotfound|ehostunreach|socket hang up)\b/i.test(
      normalized,
    ) ||
    (isManagedAudioConnection(provider) &&
      /\b(?:sidecar|ASR).{0,30}unavailable\b/i.test(normalized))
  ) {
    return "NETWORK";
  }
  return undefined;
}

export function getVoiceHistoryFailureGuidance(input: {
  provider: string;
  errorCode?: string;
  hasAudio: boolean;
}): VoiceHistoryFailureGuidance | null {
  const code = input.errorCode;
  if (!code) return null;

  if (CONFIGURATION_CODES.has(code)) {
    return {
      kind: "configuration",
      messageCode: input.hasAudio
        ? "configuration-retry-retained"
        : "configuration-next-recording",
      actionCode: "open-transcription-settings",
      settingsTarget: settingsTargetForProvider(input.provider),
    };
  }
  if (code === "OFFLINE") {
    return {
      kind: "connection",
      messageCode: input.hasAudio
        ? "offline-retry-retained"
        : "offline-record-again",
    };
  }
  if (code === "NETWORK") {
    if (isManagedAudioConnection(input.provider)) {
      return {
        kind: "connection",
        messageCode: input.hasAudio
          ? "local-runtime-retry-retained"
          : "local-runtime-record-again",
        actionCode: "open-local-runtime",
        settingsTarget: "local-runtime",
      };
    }
    if (input.provider === "self-hosted-stt") {
      return {
        kind: "connection",
        messageCode: input.hasAudio
          ? "self-hosted-retry-retained"
          : "self-hosted-record-again",
        actionCode: "open-self-hosted-stt",
        settingsTarget: "self-hosted-stt",
      };
    }
    return {
      kind: "connection",
      messageCode: input.hasAudio
        ? "connection-retry-retained"
        : "connection-record-again",
    };
  }
  if (code === "LIMIT_REACHED") {
    return {
      kind: "limit",
      messageCode: "limit-reached",
    };
  }
  if (code === "PROVIDER_RATE_LIMITED") {
    return {
      kind: "transient",
      messageCode: "rate-limited",
    };
  }
  if (code === "TIMEOUT") {
    return {
      kind: "transient",
      messageCode: input.hasAudio
        ? "timeout-retry-retained"
        : "timeout-record-again",
    };
  }
  if (code === "SERVER_ERROR") {
    return {
      kind: "transient",
      messageCode: input.hasAudio
        ? "server-retry-retained"
        : "server-record-again",
    };
  }
  return null;
}

function settingsTargetForProvider(
  provider: string,
): VoiceHistoryFailureSettingsTarget {
  if (isManagedAudioConnection(provider)) return "local-runtime";
  if (provider === "self-hosted-stt") return "self-hosted-stt";
  return "stt-provider";
}

function isExpectedNoAudioOrCancellation(reason: string): boolean {
  return /(?:no audio|no speech|silence|silent|audio.{0,20}too short|empty transcription|\b(?:abort(?:ed)?|cancel(?:led|ed)?)\b)/i.test(
    reason,
  );
}
