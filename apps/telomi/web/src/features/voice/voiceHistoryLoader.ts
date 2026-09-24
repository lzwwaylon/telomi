import { voiceApi } from "@/features/voice/api";
import type { VoiceHistorySnapshot } from "@shared/voice-history.js";

type VoiceHistoryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchVoiceHistorySnapshot(
  includeDiscarded: boolean,
  fetcher?: VoiceHistoryFetch,
): Promise<VoiceHistorySnapshot> {
  const query = new URLSearchParams({ limit: "50" });
  if (includeDiscarded) query.set("includeDiscarded", "1");

  return voiceApi.history.list(query, { fetcher });
}
