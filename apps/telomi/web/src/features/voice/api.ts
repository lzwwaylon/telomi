import { apiUrl } from "@/shared/lib/api";
import { apiClient } from "@/shared/lib/api-client";
import type { VoiceGlossaryEntry, VoiceGlossarySnapshot } from "@shared/voice-stt.js";
import type { VoiceHistorySettings, VoiceHistorySnapshot } from "@shared/voice-history.js";
import type { VoiceContextSnapshotDescriptor } from "@shared/voice-context.js";

/**
 * Every voice and audio-configuration route the web app calls, in one place. Components pass
 * request options through when they need a signal, a custom error message or a test fetcher.
 */
type RequestOptions = NonNullable<Parameters<typeof apiClient.get>[1]>;

const goalVoice = (goalId: string) => `/api/goals/${encodeURIComponent(goalId)}/voice`;
const historyEntry = (id: string) => `/api/voice/history/${encodeURIComponent(id)}`;

export const voiceApi = {
  glossary: {
    load: () => apiClient.get<VoiceGlossarySnapshot>("/api/voice/glossary"),
    save: (entries: VoiceGlossaryEntry[]) => apiClient.put<VoiceGlossarySnapshot>("/api/voice/glossary", { entries }),
  },
  correctionLearning: {
    load: () => apiClient.get<{ enabled: boolean }>("/api/voice/correction-learning"),
    setEnabled: (enabled: boolean) => apiClient.put<{ enabled: boolean }>("/api/voice/correction-learning", { enabled }),
    observe: (originalText: string, editedText: string) =>
      apiClient.post<{ corrections?: unknown }>("/api/voice/correction-learning/observe", { originalText, editedText }),
    undo: (corrections: string[]) =>
      apiClient.post<{ removed?: unknown }>("/api/voice/correction-learning/undo", { corrections }),
  },
  history: {
    list: (query: URLSearchParams, options?: RequestOptions) =>
      apiClient.get<VoiceHistorySnapshot>(`/api/voice/history?${query.toString()}`, options),
    loadSettings: () => apiClient.get<Partial<VoiceHistorySettings>>("/api/voice/history/settings"),
    saveSettings: (patch: Partial<VoiceHistorySettings>) => apiClient.put<VoiceHistorySettings>("/api/voice/history/settings", patch),
    retry: (id: string) => apiClient.post(`${historyEntry(id)}/retry`),
    remove: (id: string) => apiClient.delete(historyEntry(id)),
    clear: () => apiClient.delete("/api/voice/history"),
    userEdit: (id: string, body: unknown) => apiClient.post(`${historyEntry(id)}/user-edit`, body),
    /** Retained source audio, as a media element source or a download link. */
    audioUrl: (id: string, download = false) => apiUrl(`${historyEntry(id)}/audio${download ? "?download=1" : ""}`),
  },
  goal: (goalId: string) => ({
    captureContextSnapshot: (options?: RequestOptions) =>
      apiClient.post<Partial<VoiceContextSnapshotDescriptor> & { error?: string }>(`${goalVoice(goalId)}/context-snapshots`, undefined, options),
    warmup: (options?: RequestOptions) => apiClient.post(`${goalVoice(goalId)}/warmup`, undefined, options),
    livekitToken: <T>(options?: RequestOptions) => apiClient.post<T>(`${goalVoice(goalId)}/livekit/token`, undefined, options),
    /** Binary microphone upload; the caller reads the native response. */
    transcribe: (query: URLSearchParams, init: RequestInit) =>
      apiClient.response(apiUrl(`${goalVoice(goalId)}/transcribe?${query.toString()}`), init),
    /** Binary upload of a recording the user cancelled; only the acknowledgement matters. */
    discarded: (query: URLSearchParams, init: RequestInit) =>
      apiClient.response(apiUrl(`${goalVoice(goalId)}/discarded?${query.toString()}`), init),
  }),
};

export const audioConfigApi = {
  /** Paths the applied-configuration hook reads and posts `/apply` to. */
  recognitionPath: "/api/audio-config/recognition",
  generationPath: "/api/audio-config/generation",
  load: <T>() => apiClient.get<T>("/api/audio-config"),
  patch: <T>(body: Record<string, unknown>) => apiClient.patch<T>("/api/audio-config", body),
  localRuntime: {
    load: <T>() => apiClient.get<T>("/api/audio-config/local-runtime"),
    start: <T>() => apiClient.post<T>("/api/audio-config/local-runtime/start"),
  },
  voicePreview: (body: { connection: string; model: string; voice: string; rate: number; text: string }) =>
    apiClient.post<{ url: string }>("/api/audio-config/voice-preview", body),
};
