import type { VoiceHistoryEntry } from "@shared/voice-history.js";

function normalizeSearchText(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

/**
 * Search the final user-visible transcript only.
 *
 * Provider raw text and failure diagnostics remain audit details and must not
 * make a History row appear for a query the final transcript does not contain.
 */
export function filterVoiceHistoryEntries(
  entries: readonly VoiceHistoryEntry[],
  query: string,
): readonly VoiceHistoryEntry[] {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) return entries;
  return entries.filter((entry) =>
    normalizeSearchText(entry.text).includes(normalizedQuery),
  );
}
