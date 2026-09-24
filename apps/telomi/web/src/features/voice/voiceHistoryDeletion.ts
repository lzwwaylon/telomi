import { uiText } from "@/app/ui-text";

function isVoiceHistoryTransportError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /failed to fetch|network error|load failed/i.test(error.message)
  );
}

export interface VoiceHistoryClearScope {
  entryCount: number;
  hiddenDiscardedCount: number;
  audioFileCount: number;
}

export function captureVoiceHistoryClearScope(
  usage: {
    entryCount: number;
    discardedCount: number;
    audioFileCount: number;
  },
  showDiscarded: boolean,
): VoiceHistoryClearScope {
  return {
    entryCount: usage.entryCount,
    hiddenDiscardedCount: showDiscarded ? 0 : usage.discardedCount,
    audioFileCount: usage.audioFileCount,
  };
}

function formatVoiceHistoryMutationError(
  error: unknown,
  transportMessage: string,
): string {
  if (isVoiceHistoryTransportError(error)) return transportMessage;
  return error instanceof Error ? error.message : String(error);
}

export function formatVoiceHistoryDeleteError(error: unknown): string {
  return formatVoiceHistoryMutationError(
    error,
    uiText("voice.historydeletion.deleteRequestFailedCheckTheLocalServiceConnectionAnd"),
  );
}

export function formatVoiceHistoryClearError(error: unknown): string {
  return formatVoiceHistoryMutationError(
    error,
    uiText("voice.historydeletion.clearRequestFailedCheckTheLocalServiceConnectionAnd"),
  );
}
