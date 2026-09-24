import { formatBytes } from "@/shared/lib/format";
import { ApiError } from "@/shared/lib/api-client";
import { voiceApi } from "@/features/voice/api";
import { Database, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type VoiceHistoryEntry,
  type VoiceHistorySettings,
  type VoiceHistorySnapshot,
} from "@shared/voice-history.js";
import { copyVoiceHistoryText } from "@/features/voice/voiceHistoryClipboard";
import { groupVoiceHistoryEntries } from "@/features/voice/voiceHistoryDates";
import {
  captureVoiceHistoryClearScope,
  formatVoiceHistoryClearError,
  formatVoiceHistoryDeleteError,
  type VoiceHistoryClearScope,
} from "@/features/voice/voiceHistoryDeletion";
import { fetchVoiceHistorySnapshot } from "@/features/voice/voiceHistoryLoader";
import { subscribeVoiceHistoryForegroundRefresh } from "@/features/voice/voiceHistoryRefresh";
import { filterVoiceHistoryEntries } from "@/features/voice/voiceHistorySearch";
import { uiText } from "@/app/ui-text";
import {
  VoiceHistoryRetentionDisabledNotice,
  VoiceHistorySearchControl,
  VoiceHistoryLoadFailureNotice,
  VoiceHistoryRefreshButton,
  VoiceHistoryDeleteDialog,
  VoiceHistoryClearDialog,
  VoiceHistoryDiscardedToggle,
} from "./VoiceHistoryControls";
import { VoiceHistoryEntryCard, VoiceUserEditUsageSummary } from "./VoiceHistoryEntryCard";
import { VOICE_HISTORY_BUTTON as BUTTON } from "./settings-styles";
export {
  VoiceHistoryRetentionDisabledNotice,
  VoiceHistorySearchControl,
  VoiceHistoryLoadFailureNotice,
  VoiceHistoryRefreshButton,
  VoiceHistoryDeleteConfirmationContent,
  VoiceHistoryClearConfirmationContent,
  VoiceHistoryDiscardedToggle,
} from "./VoiceHistoryControls";
export {
  VoiceHistoryFailureGuidanceContent,
  VoiceHistoryEntryCard,
  VoiceUserEditUsageSummary,
  VoiceUserEditDetails,
} from "./VoiceHistoryEntryCard";

const SELECT =
  "rounded-[0.5rem] border border-border bg-popover px-2.5 py-1.5 text-[0.82rem] text-foreground outline-none transition-colors focus-visible:border-[var(--input)] disabled:opacity-50";

const EMPTY_VOICE_HISTORY_USAGE: VoiceHistorySnapshot["usage"] = {
  entryCount: 0,
  completedCount: 0,
  failedCount: 0,
  discardedCount: 0,
  audioFileCount: 0,
  audioBytes: 0,
  userEdit: {
    measuredCount: 0,
    unmeasuredCount: 0,
    totalOriginalCharacters: 0,
    totalEditDistance: 0,
    modificationRate: null,
  },
};

export function VoiceHistorySettings() {
  const [snapshot, setSnapshot] = useState<VoiceHistorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VoiceHistoryEntry | null>(
    null,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [clearTarget, setClearTarget] = useState<VoiceHistoryClearScope | null>(
    null,
  );
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const copyAttemptRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);
  const deleteInFlightRef = useRef(false);
  const clearInFlightRef = useRef(false);
  const historyLoadAttemptRef = useRef(0);
  const historyLoadInFlightRef = useRef(false);
  const historyLoadTargetRef = useRef(false);
  const showDiscardedRef = useRef(false);

  const load = useCallback(
    async (includeDiscarded = showDiscardedRef.current) => {
      const attempt = historyLoadAttemptRef.current + 1;
      historyLoadAttemptRef.current = attempt;
      historyLoadInFlightRef.current = true;
      historyLoadTargetRef.current = includeDiscarded;
      setLoading(true);
      try {
        const data = await fetchVoiceHistorySnapshot(includeDiscarded);
        if (historyLoadAttemptRef.current !== attempt) return;
        setSnapshot(data);
        showDiscardedRef.current = includeDiscarded;
        setShowDiscarded(includeDiscarded);
        setLoadError(null);
      } catch (loadError) {
        if (historyLoadAttemptRef.current !== attempt) return;
        setLoadError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      } finally {
        if (historyLoadAttemptRef.current === attempt) {
          historyLoadInFlightRef.current = false;
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void load();
    const disposeForegroundRefresh = subscribeVoiceHistoryForegroundRefresh(
      () => {
        if (historyLoadInFlightRef.current) return;
        void load(historyLoadTargetRef.current);
      },
    );
    return () => {
      disposeForegroundRefresh();
      historyLoadAttemptRef.current += 1;
      historyLoadInFlightRef.current = false;
      audioRef.current?.pause();
      audioRef.current = null;
      copyAttemptRef.current += 1;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, [load]);

  const toggleDiscarded = useCallback(() => {
    if (loading) return;
    void load(!showDiscardedRef.current);
  }, [load, loading]);

  const updateSettings = useCallback(
    async (patch: Partial<VoiceHistorySettings>) => {
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        const data = await voiceApi.history.saveSettings(patch);
        await load();
        setNotice(
          data.dataRetentionEnabled
			? uiText("settings.voicehistorysettings.futureVoiceTranscriptsWillBeWrittenToLocalHistory")
			: uiText("settings.voicehistorysettings.futureTranscriptsWillNotBeRecordedExistingHistoryWas"),
        );
      } catch (saveError) {
        setError(
          saveError instanceof Error ? saveError.message : String(saveError),
        );
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  const retry = useCallback(
    async (entry: VoiceHistoryEntry) => {
      setRetryingId(entry.id);
      setError(null);
      setNotice(null);
      try {
        await voiceApi.history.retry(entry.id);
        await load();
		setNotice(uiText("settings.voicehistorysettings.capturedTheRetryConfigurationAndRetranscribedTheSourceAudio"));
      } catch (retryError) {
        if (retryError instanceof ApiError && retryError.status > 0) await load();
        setError(
          retryError instanceof Error ? retryError.message : String(retryError),
        );
      } finally {
        setRetryingId(null);
      }
    },
    [load],
  );

  const play = useCallback(
    (entry: VoiceHistoryEntry) => {
      audioRef.current?.pause();
      if (playingId === entry.id) {
        audioRef.current = null;
        setPlayingId(null);
        return;
      }
      const audio = new Audio(voiceApi.history.audioUrl(entry.id));
      audioRef.current = audio;
      setPlayingId(entry.id);
      audio.addEventListener(
        "ended",
        () => {
          audioRef.current = null;
          setPlayingId(null);
        },
        { once: true },
      );
      audio.addEventListener(
        "error",
        () => {
          audioRef.current = null;
          setPlayingId(null);
		  setError(uiText("settings.voicehistorysettings.sourceAudioPlaybackFailed"));
        },
        { once: true },
      );
      void audio.play().catch((playError) => {
        audioRef.current = null;
        setPlayingId(null);
        setError(
          playError instanceof Error ? playError.message : String(playError),
        );
      });
    },
    [playingId],
  );

  const copy = useCallback(async (entry: VoiceHistoryEntry) => {
    const attempt = copyAttemptRef.current + 1;
    copyAttemptRef.current = attempt;
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopyingId(entry.id);
    setCopiedId(null);
    setError(null);
    setNotice(null);
    try {
      await copyVoiceHistoryText(entry.text);
      if (copyAttemptRef.current !== attempt) return;
      setCopiedId(entry.id);
	  setNotice(uiText("settings.voicehistorysettings.finalTranscriptCopied"));
      copyTimerRef.current = window.setTimeout(() => {
        if (copyAttemptRef.current === attempt) setCopiedId(null);
        copyTimerRef.current = null;
      }, 2_000);
    } catch (copyError) {
      if (copyAttemptRef.current !== attempt) return;
      setError(
        copyError instanceof Error ? copyError.message : String(copyError),
      );
    } finally {
      if (copyAttemptRef.current === attempt) setCopyingId(null);
    }
  }, []);

  const requestRemove = useCallback((entry: VoiceHistoryEntry) => {
    setError(null);
    setDeleteError(null);
    setDeleteTarget(entry);
  }, []);

  const cancelRemove = useCallback(() => {
    if (deleteInFlightRef.current) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }, []);

  const confirmRemove = useCallback(async () => {
    const entry = deleteTarget;
    if (!entry || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeletingId(entry.id);
    setDeleteError(null);
    setError(null);
    try {
      await voiceApi.history.remove(entry.id);
      if (playingId === entry.id) {
        audioRef.current?.pause();
        audioRef.current = null;
        setPlayingId(null);
      }
      setDeleteTarget(null);
      await load();
	  setNotice(uiText("settings.voicehistorysettings.deletedTheTranscriptAndItsSourceAudio"));
    } catch (removeError) {
      setDeleteError(formatVoiceHistoryDeleteError(removeError));
    } finally {
      deleteInFlightRef.current = false;
      setDeletingId(null);
    }
  }, [deleteTarget, load, playingId]);

  const requestClear = useCallback((scope: VoiceHistoryClearScope) => {
    setError(null);
    setNotice(null);
    setClearError(null);
    setClearTarget(scope);
  }, []);

  const cancelClear = useCallback(() => {
    if (clearInFlightRef.current) return;
    setClearTarget(null);
    setClearError(null);
  }, []);

  const confirmClear = useCallback(async () => {
    if (!clearTarget || clearInFlightRef.current) return;
    clearInFlightRef.current = true;
    setClearing(true);
    setClearError(null);
    setError(null);
    try {
      await voiceApi.history.clear();
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingId(null);
      showDiscardedRef.current = false;
      setShowDiscarded(false);
      setDeleteTarget(null);
      setDeleteError(null);
      setSnapshot((current) =>
        current
          ? { ...current, entries: [], usage: EMPTY_VOICE_HISTORY_USAGE }
          : current,
      );
      await load(false);
      setClearTarget(null);
	  setNotice(uiText("settings.voicehistorysettings.clearedLocalVoiceHistoryAndSourceAudio"));
    } catch (clearHistoryError) {
      setClearError(formatVoiceHistoryClearError(clearHistoryError));
    } finally {
      clearInFlightRef.current = false;
      setClearing(false);
    }
  }, [clearTarget, load]);

  if (loading && !snapshot && !loadError) {
    return (
      <div
        className="rounded-[0.55rem] border border-border bg-card px-3 py-3 text-[0.82rem] text-muted-foreground"
        data-testid="voice-history-settings"
      >
		{uiText("settings.voicehistorysettings.loadingLocalVoiceHistory")}
      </div>
    );
  }

  if (!snapshot && loadError) {
    return (
      <div
        className="rounded-[0.55rem] border border-border bg-card px-3 py-3"
        data-testid="voice-history-settings"
      >
        <VoiceHistoryLoadFailureNotice
          error={loadError}
          busy={loading}
          hasSnapshot={false}
          onRetry={() => void load(historyLoadTargetRef.current)}
        />
      </div>
    );
  }

  const settings = snapshot?.settings ?? {
    dataRetentionEnabled: false,
    audioRetentionDays: 30,
    saveDiscardedTranscriptions: false,
    updatedAt: null,
  };
  const usage = snapshot?.usage ?? EMPTY_VOICE_HISTORY_USAGE;
  const entries = snapshot?.entries ?? [];
  const visibleEntries = filterVoiceHistoryEntries(entries, historyQuery);
  const entryGroups = groupVoiceHistoryEntries(visibleEntries);

  return (
    <div
      className="grid gap-4 rounded-[0.55rem] border border-border bg-card px-3 py-3"
      data-testid="voice-history-settings"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 max-[640px]:grid-cols-1">
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h3 className="m-0 text-[0.95rem] font-medium">
			  {uiText("settings.voicehistorysettings.transcriptionHistoryAndFailureRetries")}
            </h3>
          </div>
          <p className="m-0 text-[0.8rem] leading-relaxed text-muted-foreground">
			{uiText("settings.voicehistorysettings.theLocalRuntimeRecordsProviderTextFinalTextErrors")}
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-[0.82rem] text-foreground">
          <input
            type="checkbox"
            checked={settings.dataRetentionEnabled}
            disabled={saving}
            onChange={(event) =>
              void updateSettings({
                dataRetentionEnabled: event.target.checked,
              })
            }
            data-testid="voice-history-enabled"
          />
		  {uiText("settings.voicehistorysettings.recordFutureTranscripts")}
        </label>
      </div>

      {!settings.dataRetentionEnabled && (
        <VoiceHistoryRetentionDisabledNotice
          busy={saving}
          onEnable={() => void updateSettings({ dataRetentionEnabled: true })}
        />
      )}

      {loadError && (
        <VoiceHistoryLoadFailureNotice
          error={loadError}
          busy={loading}
          hasSnapshot
          onRetry={() => void load(historyLoadTargetRef.current)}
        />
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[0.5rem] bg-[var(--foreground-3)] px-3 py-2.5 max-[560px]:grid-cols-1">
        <div className="grid gap-0.5 text-[0.8rem]">
		  <span className="text-foreground">{uiText("settings.voicehistorysettings.sourceAudioRetention")}</span>
          <span className="text-muted-foreground">
			{uiText("common.countFiles", { count: usage.audioFileCount })} · {formatBytes(usage.audioBytes)}
          </span>
        </div>
        <select
          value={settings.audioRetentionDays}
          disabled={saving}
          onChange={(event) =>
            void updateSettings({
              audioRetentionDays: Number(event.target.value),
            })
          }
          className={SELECT}
          aria-label={uiText("settings.voicehistorysettings.sourceAudioRetention")}
          data-testid="voice-history-retention"
        >
		  <option value={0}>{uiText("settings.voicehistorysettings.doNotRetainSourceAudio")}</option>
		  <option value={7}>{uiText("common.countDays", { count: 7 })}</option>
		  <option value={14}>{uiText("common.countDays", { count: 14 })}</option>
		  <option value={30}>{uiText("common.countDays", { count: 30 })}</option>
		  <option value={60}>{uiText("common.countDays", { count: 60 })}</option>
		  <option value={90}>{uiText("common.countDays", { count: 90 })}</option>
        </select>
      </div>

      <label
        className={`inline-flex items-start gap-2 text-[0.8rem] ${
          settings.dataRetentionEnabled && settings.audioRetentionDays > 0
            ? "text-foreground"
            : "text-muted-foreground"
        }`}
      >
        <input
          type="checkbox"
          checked={settings.saveDiscardedTranscriptions}
          disabled={
            saving ||
            !settings.dataRetentionEnabled ||
            settings.audioRetentionDays === 0
          }
          onChange={(event) =>
            void updateSettings({
              saveDiscardedTranscriptions: event.target.checked,
            })
          }
          data-testid="voice-history-save-discarded"
        />
        <span>
		  {uiText("settings.voicehistorysettings.keepManuallyCancelledRecordings")}
          <span className="mt-0.5 block text-[0.74rem] leading-relaxed text-muted-foreground">
			{uiText("settings.voicehistorysettings.keepOnlyRecordingsAtLeastOneSecondLongThat")}
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-[0.76rem] text-muted-foreground">
		  {uiText("settings.voicehistorysettings.entriesRecordsCompletedCompletedFailedFailedDiscardedCancelled", { entries: usage.entryCount, completed: usage.completedCount, failed: usage.failedCount, discarded: usage.discardedCount })}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <VoiceHistoryRefreshButton
            busy={loading}
            onRefresh={() => void load(historyLoadTargetRef.current)}
          />
          <VoiceHistoryDiscardedToggle
            discardedCount={usage.discardedCount}
            showDiscarded={showDiscarded}
            busy={loading}
            onToggle={toggleDiscarded}
          />
          <button
            type="button"
            className={BUTTON}
            disabled={usage.entryCount === 0}
            onClick={() =>
              requestClear(captureVoiceHistoryClearScope(usage, showDiscarded))
            }
            data-testid="voice-history-clear-request"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
			{uiText("settings.voicehistorysettings.clearAll")}
          </button>
        </div>
      </div>
      {(usage.userEdit.measuredCount > 0 ||
        usage.userEdit.unmeasuredCount > 0) && (
        <VoiceUserEditUsageSummary usage={usage.userEdit} />
      )}

      {entries.length > 0 && (
        <VoiceHistorySearchControl
          query={historyQuery}
          resultCount={visibleEntries.length}
          loadedCount={entries.length}
          onQueryChange={setHistoryQuery}
          onClear={() => setHistoryQuery("")}
        />
      )}

      {entries.length === 0 ? (
        <div
          className="rounded-[0.5rem] bg-[var(--foreground-3)] px-3 py-3 text-[0.82rem] text-muted-foreground"
          data-testid="voice-history-empty"
        >
		  {uiText("settings.voicehistorysettings.noLocalTranscriptionHistoryAfterHistoryIsEnabledNew")}
        </div>
      ) : visibleEntries.length === 0 ? (
        <div
          className="grid justify-items-start gap-2 rounded-[0.5rem] bg-[var(--foreground-3)] px-3 py-3 text-[0.82rem] text-muted-foreground"
          data-testid="voice-history-search-empty"
        >
		  <span>{uiText("settings.voicehistorysettings.noMatchesInTheCurrentlyLoadedTranscripts")}</span>
          <button
            type="button"
            className={BUTTON}
            onClick={() => setHistoryQuery("")}
          >
			{uiText("common.clearSearch")}
          </button>
        </div>
      ) : (
        <div className="grid gap-4" data-testid="voice-history-list">
          {entryGroups.map((group) => (
            <section
              key={group.key}
              className="grid gap-2"
              data-testid="voice-history-date-group"
              data-date-key={group.key}
            >
              <div className="flex items-center gap-2 px-0.5 text-[0.72rem] font-medium text-muted-foreground">
                <span>{group.label}</span>
                <span className="h-px flex-1 bg-border" aria-hidden />
              </div>
              <div className="grid gap-2">
                {group.entries.map((entry) => (
                  <VoiceHistoryEntryCard
                    key={entry.id}
                    entry={entry}
                    timeOnly
                    retrying={retryingId === entry.id}
                    playing={playingId === entry.id}
                    copying={copyingId === entry.id}
                    copied={copiedId === entry.id}
                    onRetry={retry}
                    onPlay={play}
                    onCopy={copy}
                    onRemove={requestRemove}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {notice && (
        <div className="text-[0.78rem] text-emerald-700 dark:text-emerald-400">
          {notice}
        </div>
      )}
      {error && (
        <div className="text-[0.78rem] text-destructive" role="alert">
          {error}
        </div>
      )}
      <VoiceHistoryDeleteDialog
        entry={deleteTarget}
        busy={deletingId !== null}
        error={deleteError}
        onCancel={cancelRemove}
        onConfirm={confirmRemove}
      />
      <VoiceHistoryClearDialog
        target={clearTarget}
        busy={clearing}
        error={clearError}
        onCancel={cancelClear}
        onConfirm={confirmClear}
      />
    </div>
  );
}
