export const MAX_VOICE_CLEANUP_INSTRUCTIONS_CHARS = 4_000;
export const MAX_VOICE_CLEANUP_MODEL_ID_CHARS = 300;

export interface VoiceCleanupConfig {
  enabled: boolean;
  /** `provider/model`; empty when the user has not chosen one, in which case cleanup is skipped. */
  modelId: string;
  instructions?: string;
}

export interface VoiceCleanupOutcome {
  requested: boolean;
  applied: boolean;
  modelId?: string;
  durationMs?: number;
  reason?: string;
}

export function normalizeVoiceCleanupConfig(
  value: unknown,
  fallbackModel = "",
): VoiceCleanupConfig {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const modelId =
    typeof record.modelId === "string" ? record.modelId.trim() : "";
  const instructions = normalizeVoiceCleanupInstructions(record.instructions);
  return {
    enabled: record.enabled === true,
    modelId: modelId || fallbackModel,
    ...(instructions ? { instructions } : {}),
  };
}

export function normalizeVoiceCleanupInstructions(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return Array.from(normalized)
    .slice(0, MAX_VOICE_CLEANUP_INSTRUCTIONS_CHARS)
    .join("");
}

export function normalizeVoiceCleanupOutcome(
  value: unknown,
  requested = false,
): VoiceCleanupOutcome {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    requested: record.requested === true || requested,
    applied: record.applied === true,
    ...(typeof record.modelId === "string" && record.modelId.trim()
      ? { modelId: record.modelId.trim() }
      : {}),
    ...(typeof record.durationMs === "number" &&
    Number.isFinite(record.durationMs) &&
    record.durationMs >= 0
      ? { durationMs: record.durationMs }
      : {}),
    ...(typeof record.reason === "string" && record.reason.trim()
      ? { reason: record.reason.trim() }
      : {}),
  };
}
