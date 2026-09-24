import { ApiError } from "@/shared/lib/api-client";
import { audioConfigApi } from "@/features/voice/api";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import { PlayIcon as Play } from "@/shared/ui/icons";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";
import type { VoiceVadStatusValue } from "./VoiceVadSettings";

const KNOWN_RUNTIME_DETAIL_IDS: Record<string, MessageId> = {
  "local audio runtime is stopped": "common.localAudioRuntimeIsStopped",
  "checking local audio runtime": "common.checkingLocalAudioRuntime",
  "starting local audio runtime": "common.startingLocalAudioRuntime",
  "local audio runtime is ready": "common.localAudioRuntimeIsReady",
  "local audio runtime startup timed out": "common.localAudioRuntimeStartupTimedOut",
};

/** The install steps telomi-audio-local reports for each pinned model, in its own English wording. */
const MODEL_INSTALL_DETAILS: [RegExp, MessageId][] = [
  [/^fetching pinned local (ASR|TTS) model asset (\d+)\/(\d+)$/, "settings.voicelocalruntimesettings.fetchingModelFile"],
  [/^validating pinned local (ASR|TTS) model$/, "settings.voicelocalruntimesettings.verifyingModel"],
  [/^local (ASR|TTS) model is installed and verified$/, "settings.voicelocalruntimesettings.modelReady"],
  [/^local (ASR|TTS) model installation failed validation or download$/, "settings.voicelocalruntimesettings.modelInstallFailed"],
];

export function localRuntimeDetail(detail: string): string {
  const id = KNOWN_RUNTIME_DETAIL_IDS[detail];
  if (id) return uiText(id);
  for (const [pattern, messageId] of MODEL_INSTALL_DETAILS) {
    const match = pattern.exec(detail);
    if (!match) continue;
    const model = uiText(match[1] === "TTS" ? "settings.voicelocalruntimesettings.ttsModel" : "settings.voicelocalruntimesettings.asrModel");
    return uiText(messageId, { model, current: match[2] ?? "", total: match[3] ?? "" });
  }
  return detail;
}

export type VoiceLocalRuntimeStage =
  "stopped" | "checking" | "installing" | "starting" | "ready" | "failed";

export interface VoiceLocalRuntimeStatus {
  schemaVersion: 1;
  stage: VoiceLocalRuntimeStage;
  baseUrl: string;
  managed: boolean;
  owned: boolean;
  detail: string;
  installStage: string | null;
  completedFiles: number;
  totalFiles: number;
  pid: number | null;
  error: string | null;
  updatedAt: string;
  vad: VoiceVadStatusValue | null;
}

export function VoiceLocalRuntimeSettings({
  initialStatus,
  onReady,
  onStatus,
}: {
  initialStatus: VoiceLocalRuntimeStatus;
  onReady?: () => void;
  /** Every status the panel learns, so siblings can read what the service reports. */
  onStatus?: (status: VoiceLocalRuntimeStatus) => void;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [starting, setStarting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const readyNotified = useRef(initialStatus.stage === "ready");

  useEffect(() => {
    setStatus(initialStatus);
    readyNotified.current = initialStatus.stage === "ready";
  }, [initialStatus]);

  const commitStatus = useCallback(
    (next: VoiceLocalRuntimeStatus) => {
      setStatus(next);
      onStatus?.(next);
      if (next.stage !== "ready") {
        readyNotified.current = false;
        return;
      }
      if (!readyNotified.current) {
        readyNotified.current = true;
        onReady?.();
      }
    },
    [onReady, onStatus],
  );

  const refresh = useCallback(async () => {
    try {
      commitStatus(await audioConfigApi.localRuntime.load<VoiceLocalRuntimeStatus>());
      setRequestError(null);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  }, [commitStatus]);

  // A preview, a podcast or a voice conversation can start or lose the runtime without this panel,
  // so a settled status is re-read too, only less often and only while the page is visible.
  useEffect(() => {
    const transitional = isTransitional(status.stage);
    const interval = window.setInterval(() => {
      if (transitional || document.visibilityState === "visible") void refresh();
    }, transitional ? 1_000 : 5_000);
    return () => window.clearInterval(interval);
  }, [refresh, status.stage]);

  const start = useCallback(async () => {
    setStarting(true);
    setRequestError(null);
    readyNotified.current = false;
    setStatus((current) => ({
      ...current,
      stage: "checking",
      detail: uiText("settings.voicelocalruntimesettings.checkingLocalVoiceRuntime"),
      error: null,
    }));
    try {
      commitStatus(await audioConfigApi.localRuntime.start<VoiceLocalRuntimeStatus>());
    } catch (error) {
      const next = error instanceof ApiError ? readNestedStatus(error.data) : null;
      if (next) commitStatus(next);
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [commitStatus]);

  const progress =
    status.totalFiles > 0
      ? Math.min(
          100,
          Math.round((status.completedFiles / status.totalFiles) * 100),
        )
      : 0;
  const showProgress = status.stage === "installing" && status.totalFiles > 0;
  const canStart =
    status.managed && (status.stage === "stopped" || status.stage === "failed");
  const StatusIcon =
    status.stage === "ready"
      ? CheckCircle2
      : status.stage === "failed"
        ? AlertTriangle
        : isTransitional(status.stage)
          ? Loader2
          : Play;

  return (
    <section
      id="voice-local-runtime-settings"
      tabIndex={-1}
      className="scroll-mt-4 grid gap-3 rounded-[0.55rem] border border-border bg-card px-3 py-3 outline-none focus:ring-2 focus:ring-[var(--input)]"
      data-testid="voice-local-runtime"
    >
      <div className="grid grid-cols-[1fr_auto] items-start gap-3 max-[560px]:grid-cols-1">
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.voicelocalruntimesettings.localVoiceRuntime")}</h3>
            <span
              className={statusBadgeClass(status.stage)}
              data-testid="voice-local-runtime-stage"
            >
              <StatusIcon
                className={`h-3.5 w-3.5 ${isTransitional(status.stage) ? "animate-spin" : ""}`}
                aria-hidden
              />
              {stageLabel(status.stage)}
            </span>
          </div>
          <p className="m-0 text-[0.8rem] text-muted-foreground">
            {uiText("settings.voicelocalruntimesettings.telomiRuntimeManagesTheLocalSpeechServicePinnedModels")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON_CLASS}
            onClick={() => void refresh()}
            disabled={starting}
            aria-label={uiText("settings.voicelocalruntimesettings.refreshLocalVoiceRuntime")}
          >
            <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
            {uiText("common.refresh")}
          </button>
          {canStart && (
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => void start()}
              disabled={starting}
              data-testid="voice-local-runtime-start"
            >
              {starting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden />
              )}
              {uiText("settings.voicelocalruntimesettings.installAndStart")}
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-1.5 rounded-[0.5rem] border border-border bg-popover px-3 py-2">
        <div className="text-[0.82rem] text-foreground">{localRuntimeDetail(status.detail)}</div>
        {showProgress && (
          <>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-[var(--foreground-10)]"
              role="progressbar"
              aria-label={uiText("settings.voicelocalruntimesettings.localVoiceModelInstallationProgress")}
              aria-valuemin={0}
              aria-valuemax={status.totalFiles}
              aria-valuenow={status.completedFiles}
            >
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-[0.75rem] text-muted-foreground">
              {uiText("settings.voicelocalruntimesettings.completedTotalPinnedAssets", { completed: status.completedFiles, total: status.totalFiles })}
            </div>
          </>
        )}
        <div className="break-all font-mono text-[0.72rem] text-muted-foreground">
          {status.baseUrl}
          {status.pid ? ` · PID ${status.pid}` : ""}
        </div>
      </div>

      {!status.managed && (
        <div className="text-[0.78rem] text-muted-foreground">
          {uiText("settings.voicelocalruntimesettings.thisAddressIsNotAManagedLocalAddressTelomi")}
        </div>
      )}
      {(requestError || status.error) && (
        <div className="rounded-[0.5rem] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[0.78rem] text-destructive">
          {requestError || status.error}
        </div>
      )}
    </section>
  );
}

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-[0.5rem] border border-border bg-popover px-3 py-1.5 text-[0.8rem] font-medium text-foreground transition-colors hover:bg-[var(--foreground-5)] disabled:cursor-not-allowed disabled:opacity-50";

function isTransitional(stage: VoiceLocalRuntimeStage): boolean {
  return stage === "checking" || stage === "installing" || stage === "starting";
}

function stageLabel(stage: VoiceLocalRuntimeStage): string {
  switch (stage) {
    case "checking":
      return uiText("settings.voicelocalruntimesettings.checking");
    case "installing":
      return uiText("settings.voicelocalruntimesettings.installing");
    case "starting":
      return uiText("common.starting");
    case "ready":
      return uiText("settings.voicelocalruntimesettings.ready");
    case "failed":
      return uiText("settings.voicelocalruntimesettings.failedToStart");
    default:
      return uiText("settings.voicelocalruntimesettings.stopped");
  }
}

function statusBadgeClass(stage: VoiceLocalRuntimeStage): string {
  const base =
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.72rem]";
  if (stage === "ready")
    return `${base} border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300`;
  if (stage === "failed")
    return `${base} border-destructive/40 bg-destructive/5 text-destructive`;
  return `${base} border-border bg-popover text-muted-foreground`;
}

function readNestedStatus(payload: unknown): VoiceLocalRuntimeStatus | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const status = (payload as { status?: unknown }).status;
  if (!status || typeof status !== "object" || Array.isArray(status))
    return null;
  return status as VoiceLocalRuntimeStatus;
}
