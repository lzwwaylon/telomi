import { voiceApi } from "@/features/voice/api";
import { formatDate, formatElapsedSeconds } from "@/shared/lib/format";
import { AlertCircle, Check, RefreshCcw, Trash2 } from "lucide-react";
import { CopyIcon as Copy, DownloadIcon as Download, PlayIcon as Play } from "@/shared/ui/icons";
import {
  type VoiceHistoryEntry,
  type VoiceHistoryUserEdit,
  type VoiceHistoryUserEditUsage,
} from "@shared/voice-history.js";
import {
  getVoiceHistoryFailureGuidance,
  type VoiceHistoryFailureGuidance,
  type VoiceHistoryFailureGuidanceActionCode,
  type VoiceHistoryFailureGuidanceMessageCode,
  type VoiceHistoryFailureSettingsTarget,
} from "@shared/voice-history-failure.js";
import { formatVoiceHistoryDuration } from "@/features/voice/voiceHistoryDuration";
import { currentUiLocale } from "@/app/i18n";
import { uiText } from "@/app/ui-text";
import { type MessageId } from "@/app/locales/zh-CN";
import { VOICE_HISTORY_BUTTON as BUTTON } from "./settings-styles";

const FAILURE_GUIDANCE_MESSAGE_IDS: Record<VoiceHistoryFailureGuidanceMessageCode, MessageId> = {
  "configuration-retry-retained": "settings.voiceHistory.failure.configurationRetryRetained",
  "configuration-next-recording": "settings.voiceHistory.failure.configurationNextRecording",
  "offline-retry-retained": "settings.voiceHistory.failure.offlineRetryRetained",
  "offline-record-again": "settings.voiceHistory.failure.offlineRecordAgain",
  "local-runtime-retry-retained": "settings.voiceHistory.failure.localRuntimeRetryRetained",
  "local-runtime-record-again": "settings.voiceHistory.failure.localRuntimeRecordAgain",
  "self-hosted-retry-retained": "settings.voiceHistory.failure.selfHostedRetryRetained",
  "self-hosted-record-again": "settings.voiceHistory.failure.selfHostedRecordAgain",
  "connection-retry-retained": "settings.voiceHistory.failure.connectionRetryRetained",
  "connection-record-again": "settings.voiceHistory.failure.connectionRecordAgain",
  "limit-reached": "settings.voiceHistory.failure.limitReached",
  "rate-limited": "settings.voiceHistory.failure.rateLimited",
  "timeout-retry-retained": "settings.voiceHistory.failure.timeoutRetryRetained",
  "timeout-record-again": "settings.voiceHistory.failure.timeoutRecordAgain",
  "server-retry-retained": "settings.voiceHistory.failure.serverRetryRetained",
  "server-record-again": "settings.voiceHistory.failure.serverRecordAgain",
};

const FAILURE_GUIDANCE_ACTION_IDS: Record<VoiceHistoryFailureGuidanceActionCode, MessageId> = {
  "open-transcription-settings": "settings.voiceHistory.failure.openTranscriptionSettings",
  "open-local-runtime": "settings.voiceHistory.failure.openLocalRuntime",
  "open-self-hosted-stt": "settings.voiceHistory.failure.openSelfHostedStt",
};
export function VoiceHistoryFailureGuidanceContent({
  guidance,
  onOpenSettings,
}: {
  guidance: VoiceHistoryFailureGuidance;
  onOpenSettings: (target: VoiceHistoryFailureSettingsTarget) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-[0.45rem] border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[0.74rem] text-amber-800 dark:text-amber-300"
      data-testid="voice-history-failure-guidance"
      data-guidance-kind={guidance.kind}
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
	  <span className="min-w-0 flex-1 leading-relaxed">{uiText(FAILURE_GUIDANCE_MESSAGE_IDS[guidance.messageCode])}</span>
      {guidance.actionCode && guidance.settingsTarget && (
        <button
          type="button"
          className="shrink-0 rounded-[0.4rem] border border-amber-500/30 bg-card px-2 py-1 font-medium text-foreground transition-colors hover:bg-amber-500/10"
          onClick={() => onOpenSettings(guidance.settingsTarget!)}
          data-testid="voice-history-failure-open-settings"
        >
		  {uiText(FAILURE_GUIDANCE_ACTION_IDS[guidance.actionCode])}
        </button>
      )}
    </div>
  );
}

export function VoiceHistoryEntryCard({
  entry,
  timeOnly = false,
  retrying,
  playing,
  copying,
  copied,
  onRetry,
  onPlay,
  onCopy,
  onRemove,
}: {
  entry: VoiceHistoryEntry;
  timeOnly?: boolean;
  retrying: boolean;
  playing: boolean;
  copying: boolean;
  copied: boolean;
  onRetry: (entry: VoiceHistoryEntry) => Promise<void>;
  onPlay: (entry: VoiceHistoryEntry) => void;
  onCopy: (entry: VoiceHistoryEntry) => Promise<void>;
  onRemove: (entry: VoiceHistoryEntry) => void;
}) {
  const hasRawText =
    entry.status === "completed" && entry.rawText.trim().length > 0;
  const rawMatchesFinal = hasRawText && entry.rawText === entry.text;
  const routingAttempts = entry.routing?.attempts ?? [];
  const fallbackUsed = entry.routing?.fallback.used === true;
  const failureGuidance =
    entry.status === "failed" ? getVoiceHistoryFailureGuidance(entry) : null;
  const discardedDuration =
    entry.status === "discarded"
      ? formatVoiceHistoryDuration(entry.durationSec)
      : null;
  return (
    <article
      className="grid gap-2 rounded-[0.5rem] bg-[var(--foreground-3)] px-3 py-2.5"
      data-testid={`voice-history-entry-${entry.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.72rem] text-muted-foreground">
          <span
            className={
              entry.status === "completed"
                ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-400"
                : entry.status === "discarded"
                  ? "rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400"
                  : "rounded-full bg-destructive/10 px-2 py-0.5 text-destructive"
            }
          >
            {entry.status === "completed"
			  ? uiText("settings.voicehistorysettings.completed")
              : entry.status === "discarded"
				? uiText("settings.voicehistorysettings.cancelled")
				: uiText("settings.voicehistorysettings.failed")}
          </span>
          <span>{formatTimestamp(entry.createdAt, timeOnly)}</span>
          <span className="font-mono">
            {entry.provider}
            {entry.model ? ` / ${entry.model}` : ""}
          </span>
          {fallbackUsed && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400">
			  {uiText("settings.voicehistorysettings.cloudFallback")}
            </span>
          )}
		  {entry.attemptCount > 1 && <span>{uiText("settings.voicehistorysettings.countAttempts", { count: entry.attemptCount })}</span>}
          {entry.contextSnapshotId && (
            <span className="font-mono" title={entry.contextSnapshotId}>
			  {uiText("settings.voicehistorysettings.context")} {entry.contextSnapshotId.slice(-8)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {entry.status === "completed" && entry.text.trim() && (
            <button
              type="button"
              className={BUTTON}
              disabled={copying}
              onClick={() => void onCopy(entry)}
			  aria-label={copied ? uiText("settings.voicehistorysettings.finalTranscriptCopied") : uiText("settings.voicehistorysettings.copyFinalTranscript")}
			  title={copied ? uiText("settings.voicehistorysettings.finalTranscriptCopied") : uiText("settings.voicehistorysettings.copyFinalTranscript")}
              data-testid={`voice-history-copy-${entry.id}`}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden />
              )}
			  {copying ? uiText("settings.voicehistorysettings.copying") : copied ? uiText("common.copied") : uiText("common.copy")}
            </button>
          )}
          {entry.hasAudio && (
            <a
              className={BUTTON}
              href={voiceApi.history.audioUrl(entry.id, true)}
              download
			  aria-label={uiText("settings.voicehistorysettings.downloadSourceAudio")}
			  title={uiText("settings.voicehistorysettings.downloadSourceAudio")}
              data-testid={`voice-history-download-${entry.id}`}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
			  {uiText("common.download")}
            </a>
          )}
          <button
            type="button"
            className={BUTTON}
            disabled={!entry.hasAudio}
            onClick={() => onPlay(entry)}
			aria-label={playing ? uiText("settings.voicehistorysettings.stopSourceAudioPlayback") : uiText("settings.voicehistorysettings.playSourceAudio")}
			title={entry.hasAudio ? uiText("settings.voicehistorysettings.playSourceAudio") : uiText("settings.voicehistorysettings.sourceAudioWasNotRetainedOrHasExpired")}
          >
            <Play className="h-3.5 w-3.5" aria-hidden />
			{playing ? uiText("settings.voicehistorysettings.stop") : uiText("media.play")}
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={!entry.hasAudio || retrying}
            onClick={() => void onRetry(entry)}
            data-testid={`voice-history-retry-${entry.id}`}
          >
            <RefreshCcw
              className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`}
              aria-hidden
            />
			{retrying ? uiText("settings.voicehistorysettings.retrying") : uiText("media.retry")}
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[0.45rem] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onRemove(entry)}
			aria-label={uiText("settings.voicehistorysettings.deleteTranscriptRecord")}
			title={uiText("common.delete")}
            data-testid={`voice-history-delete-request-${entry.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>
      <p
        className={`m-0 whitespace-pre-wrap break-words text-[0.84rem] leading-relaxed ${
          entry.status === "failed" && !entry.text
            ? "text-destructive"
            : entry.text
              ? "text-foreground"
              : "italic text-muted-foreground"
        }`}
      >
        {entry.text ||
          entry.errorMessage ||
          (entry.status === "completed" && entry.cleanup.applied
            ? uiText("common.aiTextCleanupRemovedEverythingOnlyFillersWereSpoken")
            : entry.status === "discarded"
            ? discardedDuration
			  ? uiText("settings.voicehistorysettings.recordingCancelledByTheUserDurationRetainedSourceAudio", { duration: discardedDuration })
			  : uiText("settings.voicehistorysettings.recordingCancelledByTheUserRetainedSourceAudioCan")
			  : uiText("settings.voicehistorysettings.noTextToDisplay"))}
      </p>
      {failureGuidance && (
        <VoiceHistoryFailureGuidanceContent
          guidance={failureGuidance}
          onOpenSettings={focusVoiceHistoryFailureSettings}
        />
      )}
      {hasRawText && (
        <details
          className="text-[0.76rem] text-muted-foreground"
          data-testid={`voice-history-raw-${entry.id}`}
        >
          <summary className="cursor-pointer select-none">
			{uiText("settings.voicehistorysettings.viewProviderText")}
          </summary>
          <p className="mb-0 mt-1 whitespace-pre-wrap break-words rounded-[0.4rem] border border-border px-2 py-1.5 font-mono text-[0.72rem]">
            {entry.rawText}
          </p>
          {rawMatchesFinal && (
            <p className="mb-0 mt-1 text-[0.7rem] italic text-muted-foreground">
              {entry.cleanup.applied
				? uiText("settings.voicehistorysettings.providerTextMatchesTheFinalTextAiCleanupMade")
				: uiText("settings.voicehistorysettings.providerTextMatchesTheFinalTextAiCleanupWas")}
            </p>
          )}
        </details>
      )}
      {entry.userEdit && <VoiceUserEditDetails userEdit={entry.userEdit} />}
      {routingAttempts.length > 0 && (
        <details className="text-[0.76rem] text-muted-foreground">
          <summary className="cursor-pointer select-none">
			{uiText("settings.voicehistorysettings.viewSttRouting")}
            {fallbackUsed
			  ? ` · ${uiText("settings.voicehistorysettings.countProviderAttempts", { count: routingAttempts.length })}`
              : ""}
          </summary>
          <ol className="mb-0 mt-1 grid list-none gap-1 rounded-[0.4rem] border border-border px-2 py-1.5">
            {routingAttempts.map((attempt, index) => (
              <li
                key={`${attempt.provider}-${index}`}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 font-mono text-[0.7rem] max-[560px]:grid-cols-[auto_minmax(0,1fr)]"
              >
                <span
                  className={
                    attempt.ok
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-destructive"
                  }
                >
				  {attempt.ok ? uiText("settings.voicehistorysettings.completed") : uiText("settings.voicehistorysettings.failed")}
                </span>
                <span className="min-w-0 break-all">
                  {attempt.provider}
                  {attempt.model ? ` / ${attempt.model}` : ""}
                  {attempt.reason ? ` · ${attempt.reason}` : ""}
                </span>
                <span className="text-right max-[560px]:col-start-2">
                  {attempt.durationMs} ms
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {entry.errorMessage &&
        (entry.status === "completed" || Boolean(entry.text)) && (
          <p className="m-0 text-[0.74rem] text-destructive">
			{entry.status === "completed" ? `${uiText("settings.voicehistorysettings.latestRetryFailed")} ` : ""}
            {entry.errorMessage}
          </p>
        )}
    </article>
  );
}

function focusVoiceHistoryFailureSettings(
  target: VoiceHistoryFailureSettingsTarget,
): void {
  const ids: Record<VoiceHistoryFailureSettingsTarget, string> = {
    "local-runtime": "voice-local-runtime-settings",
    "self-hosted-stt": "voice-self-hosted-stt-settings",
    "stt-provider": "voice-stt-provider-settings",
  };
  const element = document.getElementById(ids[target]);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.focus({ preventScroll: true });
}

export function VoiceUserEditUsageSummary({
  usage,
}: {
  usage: VoiceHistoryUserEditUsage;
}) {
  return (
    <div
      className="grid gap-0.5 rounded-[0.5rem] border border-border bg-[var(--foreground-3)] px-3 py-2 text-[0.76rem] text-muted-foreground"
      data-testid="voice-history-user-edit-usage"
    >
      {usage.modificationRate !== null ? (
        <span className="text-foreground">
		  {uiText("settings.voicehistorysettings.preSendEditRate")} {formatPercentage(usage.modificationRate)}
          {" · "}
		  {uiText("settings.voicehistorysettings.countMeasured", { count: usage.measuredCount })}
        </span>
      ) : (
		<span className="text-foreground">{uiText("settings.voicehistorysettings.noMeasurablePreSendEditRateYet")}</span>
      )}
      <span>
		{uiText("settings.voicehistorysettings.microAveragedAcrossUnicodeCharacterCountsForAllMeasurable")}
      </span>
      {usage.unmeasuredCount > 0 && (
		<span>{uiText("settings.voicehistorysettings.countUncertainRecordsWereExcludedFromTheEditRate", { count: usage.unmeasuredCount })}</span>
      )}
    </div>
  );
}

export function VoiceUserEditDetails({
  userEdit,
}: {
  userEdit: VoiceHistoryUserEdit;
}) {
  if (userEdit.outcome === "unmeasured") {
    return (
      <details
        className="text-[0.76rem] text-muted-foreground"
        data-testid="voice-history-user-edit"
      >
        <summary className="cursor-pointer select-none">
		  {uiText("settings.voicehistorysettings.preSendEditRateExcluded")}
        </summary>
        <div className="mt-1 grid gap-1 rounded-[0.4rem] border border-border px-2 py-1.5 text-[0.72rem]">
          <span>{userEditUnmeasuredReasonLabel(userEdit.reason)}</span>
		  <span>{uiText("settings.voicehistorysettings.sentAfterTime", { time: formatElapsedSeconds(userEdit.elapsedMs) })}</span>
		  <span>{uiText("settings.voicehistorysettings.noCopyOfSentTextWasSavedAndUncertain")}</span>
        </div>
      </details>
    );
  }
  return (
    <details
      className="text-[0.76rem] text-muted-foreground"
      data-testid="voice-history-user-edit"
    >
      <summary className="cursor-pointer select-none">
		{uiText("settings.voicehistorysettings.preSendEdit")} {formatPercentage(userEdit.modificationRate)}
      </summary>
      <div className="mt-1 grid gap-1 rounded-[0.4rem] border border-border px-2 py-1.5 text-[0.72rem]">
        <span>
		  {uiText("settings.voicehistorysettings.changedTotalUnicodeCharactersChanged", { changed: userEdit.editDistance, total: userEdit.originalCharacterCount })}
        </span>
		<span>{uiText("settings.voicehistorysettings.sentTimeAfterTheTranscriptWasInserted", { time: formatElapsedSeconds(userEdit.elapsedMs) })}</span>
		<span>{uiText("settings.voicehistorysettings.onlyCharacterCountsAndEditDistanceAreSavedNot")}</span>
      </div>
    </details>
  );
}

function userEditUnmeasuredReasonLabel(
  reason: Extract<VoiceHistoryUserEdit, { outcome: "unmeasured" }>["reason"],
): string {
  switch (reason) {
    case "multiple_voice_inputs":
	  return uiText("settings.voicehistorysettings.theSameMessageContainsMultipleVoiceInputsSoEdits");
    case "composer_context_changed":
	  return uiText("settings.voicehistorysettings.editingContextOutsideTheVoiceSegmentChangedSoThe");
    case "text_too_long":
	  return uiText("settings.voicehistorysettings.theTextExceedsTheLocalEditDistanceLimit");
  }
}

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}


function formatTimestamp(value: string, timeOnly = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDate(date, {
    ...(timeOnly ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
  }, currentUiLocale());
}
