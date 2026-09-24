import { AlertCircle, RefreshCcw } from "lucide-react";
import { SearchIcon as Search, ArchiveIcon as Archive, CloseIcon as X } from "@/shared/ui/icons";
import { type VoiceHistoryEntry } from "@shared/voice-history.js";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { type VoiceHistoryClearScope } from "@/features/voice/voiceHistoryDeletion";
import { uiText } from "@/app/ui-text";
import { VOICE_HISTORY_BUTTON as BUTTON } from "./settings-styles";

export function VoiceHistoryRetentionDisabledNotice({
  busy,
  onEnable,
}: {
  busy: boolean;
  onEnable: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-[0.5rem] border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-[0.78rem] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 max-[560px]:items-start"
      role="status"
      aria-live="polite"
      data-testid="voice-history-retention-disabled"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 leading-relaxed">
		{uiText("settings.voicehistorysettings.historyIsOffNewVoiceTranscriptsAndSourceAudio")}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-[0.4rem] border border-amber-500/30 bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={busy}
        onClick={onEnable}
        data-testid="voice-history-retention-enable"
      >
		{busy ? uiText("settings.voicehistorysettings.enabling") : uiText("settings.voicehistorysettings.enableHistory")}
      </button>
    </div>
  );
}

export function VoiceHistorySearchControl({
  query,
  resultCount,
  loadedCount,
  onQueryChange,
  onClear,
}: {
  query: string;
  resultCount: number;
  loadedCount: number;
  onQueryChange: (query: string) => void;
  onClear: () => void;
}) {
  const searching = query.trim().length > 0;
  return (
    <div className="grid gap-1.5" data-testid="voice-history-search">
      <label className="sr-only" htmlFor="voice-history-search-input">
		{uiText("settings.voicehistorysettings.searchVoiceHistory")}
      </label>
      <div className="flex min-w-0 items-center gap-2 rounded-[0.5rem] border border-border bg-popover px-2.5 py-2 focus-within:border-[var(--input)] focus-within:ring-2 focus-within:ring-[var(--ring)]/20">
        <Search
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <input
          id="voice-history-search-input"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={uiText("settings.voicehistorysettings.searchTranscriptText")}
          aria-label={uiText("settings.voicehistorysettings.searchVoiceHistory")}
          className="min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-[0.82rem] text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          data-testid="voice-history-search-input"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[0.35rem] text-muted-foreground transition-colors hover:bg-[var(--foreground-5)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
			aria-label={uiText("settings.voicehistorysettings.clearHistorySearch")}
            data-testid="voice-history-search-clear"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      {searching && (
        <div
          className={`text-[0.74rem] ${
            resultCount > 0 ? "text-muted-foreground" : "text-[var(--warm)]"
          }`}
          role="status"
          aria-live="polite"
          data-testid="voice-history-search-status"
        >
          {resultCount > 0
			? uiText("settings.voicehistorysettings.foundResultsOfLoadedLoadedRecords", { results: resultCount, loaded: loadedCount })
			: uiText("settings.voicehistorysettings.noMatchingTranscripts")}
        </div>
      )}
    </div>
  );
}

export function VoiceHistoryLoadFailureNotice({
  error,
  busy,
  hasSnapshot,
  onRetry,
}: {
  error: string;
  busy: boolean;
  hasSnapshot: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      className="grid gap-2.5 rounded-[0.5rem] border border-destructive/30 bg-destructive/5 px-3 py-3 text-[0.8rem]"
      role="alert"
      aria-live="assertive"
      data-testid="voice-history-load-failure"
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle
          className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
		  <div className="font-medium text-foreground">{uiText("settings.voicehistorysettings.couldNotLoadVoiceHistory")}</div>
          <div className="mt-0.5 leading-relaxed text-muted-foreground">
            {hasSnapshot
			  ? uiText("settings.voicehistorysettings.theLastSuccessfullyLoadedRecordsAreStillShownReload")
			  : uiText("settings.voicehistorysettings.localHistoryHasNotLoadedCheckTheServiceAnd")}
          </div>
          <code className="mt-1 block break-all font-mono text-[0.72rem] text-destructive">
            {error}
          </code>
        </div>
      </div>
      <button
        type="button"
        className={`${BUTTON} justify-self-start`}
        disabled={busy}
        onClick={onRetry}
        data-testid="voice-history-load-retry"
      >
        <RefreshCcw
          className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
          aria-hidden
        />
		{busy ? uiText("settings.voicehistorysettings.reloading") : uiText("settings.voicehistorysettings.reload")}
      </button>
    </div>
  );
}

export function VoiceHistoryRefreshButton({
  busy,
  onRefresh,
}: {
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <button
      type="button"
      className={BUTTON}
      disabled={busy}
      onClick={onRefresh}
      data-testid="voice-history-refresh"
    >
      <RefreshCcw
        className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
        aria-hidden
      />
	  {busy ? uiText("settings.voicehistorysettings.refreshing") : uiText("common.refresh")}
    </button>
  );
}

export function VoiceHistoryDeleteConfirmationContent({
  entry,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  entry: VoiceHistoryEntry;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <>
      <DialogHeader>
		<DialogTitle>{uiText("settings.voicehistorysettings.deleteThisVoiceHistoryRecord")}</DialogTitle>
        <DialogDescription className="pt-1">
		  {uiText(entry.hasAudio ? "common.thisPermanentlyDeletesTheTranscriptAndItsRetainedSource" : "common.thisPermanentlyDeletesTheTranscriptThisActionCannotBe")}
        </DialogDescription>
      </DialogHeader>
      {error && (
        <div className="text-[0.8rem] text-destructive" role="alert">
          {error}
        </div>
      )}
      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
          className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-border bg-transparent px-[0.8rem] text-[0.88rem] font-normal text-foreground shadow-none hover:border-[var(--input)] hover:bg-[var(--foreground-5)] hover:text-foreground"
          data-testid="voice-history-delete-cancel"
        >
		  {uiText("common.cancel")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void onConfirm()}
          disabled={busy}
          className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-destructive bg-destructive px-[0.8rem] text-[0.88rem] font-normal text-destructive-foreground shadow-none hover:border-destructive hover:bg-destructive/90 hover:text-destructive-foreground disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="voice-history-delete-confirm"
        >
		  {busy ? uiText("goals.deleting") : uiText("common.delete")}
        </Button>
      </DialogFooter>
    </>
  );
}

export function VoiceHistoryDeleteDialog({
  entry,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  entry: VoiceHistoryEntry | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        className="border-border bg-card"
        data-testid="voice-history-delete-dialog"
        showCloseButton={!busy}
      >
        {entry && (
          <VoiceHistoryDeleteConfirmationContent
            entry={entry}
            busy={busy}
            error={error}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function VoiceHistoryClearConfirmationContent({
  entryCount,
  hiddenDiscardedCount,
  audioFileCount,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  entryCount: number;
  hiddenDiscardedCount: number;
  audioFileCount: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <>
      <DialogHeader>
		<DialogTitle>{uiText("settings.voicehistorysettings.clearAllVoiceHistory")}</DialogTitle>
        <DialogDescription className="pt-1">
		  {uiText("settings.voicehistorysettings.thisPermanentlyDeletesAllEntriesTranscriptRecordsHiddenAudio", {
			entries: entryCount,
			hidden: hiddenDiscardedCount > 0 ? uiText("settings.voicehistorysettings.includingCountCurrentlyHiddenCancelledRecords", { count: hiddenDiscardedCount }) : "",
			audio: audioFileCount > 0 ? uiText("settings.voicehistorysettings.andCountRetainedSourceAudioFiles", { count: audioFileCount }) : "",
		  })}
        </DialogDescription>
      </DialogHeader>
      {error && (
        <div className="text-[0.8rem] text-destructive" role="alert">
          {error}
        </div>
      )}
      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
          className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-border bg-transparent px-[0.8rem] text-[0.88rem] font-normal text-foreground shadow-none hover:border-[var(--input)] hover:bg-[var(--foreground-5)] hover:text-foreground"
          data-testid="voice-history-clear-cancel"
        >
		  {uiText("common.cancel")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void onConfirm()}
          disabled={busy}
          className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-destructive bg-destructive px-[0.8rem] text-[0.88rem] font-normal text-destructive-foreground shadow-none hover:border-destructive hover:bg-destructive/90 hover:text-destructive-foreground disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="voice-history-clear-confirm"
        >
		  {busy ? uiText("settings.voicehistorysettings.clearing") : uiText("settings.voicehistorysettings.clearAll")}
        </Button>
      </DialogFooter>
    </>
  );
}

export function VoiceHistoryClearDialog({
  target,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  target: VoiceHistoryClearScope | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
    >
      <DialogContent
        className="border-border bg-card"
        data-testid="voice-history-clear-dialog"
        showCloseButton={!busy}
      >
        {target && (
          <VoiceHistoryClearConfirmationContent
            entryCount={target.entryCount}
            hiddenDiscardedCount={target.hiddenDiscardedCount}
            audioFileCount={target.audioFileCount}
            busy={busy}
            error={error}
            onCancel={onCancel}
            onConfirm={onConfirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function VoiceHistoryDiscardedToggle({
  discardedCount,
  showDiscarded,
  busy = false,
  onToggle,
}: {
  discardedCount: number;
  showDiscarded: boolean;
  busy?: boolean;
  onToggle: () => void;
}) {
  if (discardedCount <= 0 && !showDiscarded) return null;
  return (
    <button
      type="button"
      className={BUTTON}
      disabled={busy}
      onClick={onToggle}
      aria-pressed={showDiscarded}
      data-testid="voice-history-show-discarded"
    >
      <Archive className="h-3.5 w-3.5" aria-hidden />
	  {showDiscarded ? uiText("settings.voicehistorysettings.hideCancelled") : uiText("settings.voicehistorysettings.showCancelledCount", { count: discardedCount })}
    </button>
  );
}
