import { audioConfigApi } from "@/features/voice/api";
import { useCallback, useMemo, useState } from "react";
import type { SpeechConfiguration, SpeechConfigurationResponse } from "@shared/speech-configuration.js";
import { uiText } from "@/app/ui-text";
import { AssignmentBoard, type BoardRow, type BoardSelection } from "./AssignmentBoard";
import { ConnectionsSection } from "./ConnectionsSection";
import { PendingConfigNotice } from "./PendingConfigNotice";
import { SettingsLoading, SettingsPanel } from "./SettingsPanel";
import { useAppliedConfig } from "./use-applied-config";
import { useAudioConfig } from "./use-audio-config";
import { useConnections } from "./use-connections";
import { Volume2 } from "lucide-react";
import { VoiceCleanupSettings } from "./VoiceCleanupSettings";
import { VoiceGlossarySettings } from "./VoiceGlossarySettings";
import { VoiceHistorySettings } from "./VoiceHistorySettings";
import { VoiceMicrophoneSettings } from "./VoiceMicrophoneSettings";
import { VoiceToggleSettings } from "./VoiceToggleSettings";
import { VoiceLanguageSettings } from "./VoiceLanguageSettings";
import { VoiceLocalRuntimeSettings, type VoiceLocalRuntimeStatus } from "./VoiceLocalRuntimeSettings";
import { VoiceVadSettings } from "./VoiceVadSettings";

const splitRef = (ref: string | null | undefined): { connection: string; model: string } | null => {
  const slash = ref?.indexOf("/") ?? -1;
  return ref && slash > 0 ? { connection: ref.slice(0, slash), model: ref.slice(slash + 1) } : null;
};

const listener = (selection: { connection: string; model: string } | undefined) => selection ? { connection: selection.connection, model: selection.model } : null;

/** Rows for the recognition board: the default, the two listeners, and the optional backup. Selections show the saved draft when one is kept. */
export function sttBoardRows(state: SpeechConfigurationResponse): BoardRow[] {
  const own = state.pending ?? state.active;
  const statusOf = (id: "recognition" | "local") => {
    const status = state.consumers.find((item) => item.id === id)?.status;
    return status === "unconfigured" ? { text: uiText("settings.board.noModelChosen"), tone: "pending" as const }
      : status === "pending" ? { text: uiText("settings.board.nextRecording"), tone: "pending" as const }
      : status === "unavailable" ? { text: uiText("settings.board.unavailable"), tone: "error" as const }
      : status === "active" ? { text: uiText("settings.board.active"), tone: "ok" as const } : undefined;
  };
  return [
    { id: "default", label: uiText("settings.speech.default"), hint: uiText("settings.board.defaultHint"), own: own.default ?? null, resolved: state.active.default ?? null },
    { id: "recognition", label: uiText("settings.speech.recognition"), own: own.recognition ?? null, resolved: listener(state.effective.recognition), status: statusOf("recognition") },
    { id: "local", label: uiText("settings.speech.local"), own: own.local ?? null, resolved: listener(state.effective.local), status: statusOf("local") },
    { id: "fallback", label: uiText("settings.speech.fallback"), hint: uiText("settings.speech.enableBackup"), own: own.fallback ?? null, resolved: null, optional: true },
  ];
}

/** Everything about turning speech into text: which connection listens, how text is cleaned up, the vocabulary, this machine's microphone, segmentation and history. */
export function SttSettings() {
  const { data, loading, loadError, saving, saveError, patch, reload } = useAudioConfig();
  const { connections, refresh } = useConnections();
  // The local runtime lists itself as a connection once it is healthy; both connection lists re-read that.
  const [listed, setListed] = useState(0);
  const speech = useAppliedConfig<SpeechConfigurationResponse>(audioConfigApi.recognitionPath);
  // The latest runtime status the local-runtime panel learned; the VAD panel reads the service's model status from it.
  const [runtime, setRuntime] = useState<VoiceLocalRuntimeStatus | null>(null);

  const rows = useMemo(() => (speech.state ? sttBoardRows(speech.state) : []), [speech.state]);
  const cleanupRows = useMemo((): BoardRow[] => {
    const state = speech.state;
    if (!state) return [];
    const status = state.consumers.find((item) => item.id === "cleanupModel")?.status;
    return [{
      id: "cleanupModel",
      inherits: true,
      label: uiText("settings.speech.cleanup"),
      hint: uiText("settings.speech.inheritLlm"),
      own: splitRef((state.pending ?? state.active).cleanupModel),
      resolved: splitRef(state.effective.cleanupModel),
      status: status === "unavailable" ? { text: uiText("settings.speech.unavailable"), tone: "error" }
        : status === "pending" ? { text: uiText("settings.board.nextRecording"), tone: "pending" }
        : status === "active" ? { text: uiText("settings.board.active"), tone: "ok" } : undefined,
    }];
  }, [speech.state]);

  // Each edit is built when it is sent, on what the server holds by then, so an edit made while another applies keeps both.
  // A kept draft is the base, so a rejected change is corrected rather than started over.
  const applySpeech = useCallback((edit: (active: SpeechConfiguration) => SpeechConfiguration) => {
    // Applying changes which connections are in use; the connection cards re-read that.
    void speech.apply((current: SpeechConfigurationResponse) => edit(current.pending ?? current.active)).then(() => { void reload(); setListed((count) => count + 1); });
  }, [speech, reload]);

  const onRowChange = useCallback((rowId: string, next: BoardSelection | null) => {
    const selection = next ? { connection: next.connection, model: next.model } : undefined;
    applySpeech((active) => {
      const config: SpeechConfiguration = { ...active };
      if (rowId === "cleanupModel") config.cleanupModel = next ? `${next.connection}/${next.model}` : undefined;
      else if (rowId === "default") { if (selection) config.default = selection; }
      else if (selection) config[rowId as "recognition" | "local" | "fallback"] = selection;
      else delete config[rowId as "recognition" | "local" | "fallback"];
      return config;
    });
  }, [applySpeech]);

  if (loading || loadError || !data || (!speech.state && !speech.error)) {
    return <SettingsLoading id="stt" error={loadError ?? speech.error ?? null} />;
  }
  const active = speech.state?.pending ?? speech.state?.active;
  const disabled = saving || speech.busy;

  return (
    <SettingsPanel id="stt" heading="settings.section.stt" description="settings.section.sttDescription">
      <VoiceLocalRuntimeSettings initialStatus={data.telomiAudio.runtime} onStatus={setRuntime} onReady={() => { refresh(); setListed((count) => count + 1); void reload(); void speech.reload(); }} />
      <ConnectionsSection capability="stt" reloadToken={listed} onChanged={() => { refresh(); void reload(); }} />

      <div className="grid gap-3" aria-label={uiText("settings.speech.title")} data-testid="speech-settings">
        <div className="grid gap-1">
          <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.board.assignments")}</h3>
          <p className="m-0 text-[0.85rem] text-muted-foreground">{uiText("settings.speech.boundary")}</p>
        </div>
        {(speech.error || speech.state?.error) && <p role="alert" className="m-0 text-[0.85rem] text-destructive">{speech.error || speech.state?.error}</p>}
        {speech.state && active && (
          <>
            {speech.state.pending && <PendingConfigNotice busy={speech.busy} onApply={() => { void speech.apply().then(() => { void reload(); setListed((count) => count + 1); }); }} onDiscard={() => { void speech.discard(); }} testId="stt-pending" />}
            <AssignmentBoard capability="stt" rows={rows} connections={connections} busy={saving} saving={speech.busy} testId="stt-board" onChange={onRowChange} />
            <AssignmentBoard capability="chat" rows={cleanupRows} connections={connections} busy={saving} saving={speech.busy} testId="cleanup-board" onChange={onRowChange} />
            <VoiceCleanupSettings enabled={active.cleanupEnabled} instructions={active.cleanupInstructions} disabled={disabled}
              onPatch={(next) => applySpeech((current) => ({
                ...current,
                ...(typeof next.sttCleanupEnabled === "boolean" ? { cleanupEnabled: next.sttCleanupEnabled } : {}),
                ...(typeof next.sttCleanupInstructions === "string" ? { cleanupInstructions: next.sttCleanupInstructions } : {}),
              }))} />
          </>
        )}
      </div>

      <VoiceLanguageSettings value={data.config.sttLanguage} disabled={saving} onChange={(sttLanguage) => void patch({ sttLanguage })} />
      <VoiceGlossarySettings />
      <VoiceMicrophoneSettings />
      <VoiceToggleSettings
        icon={Volume2}
        heading="settings.voicerecordingcuesettings.recordingCues"
        description="settings.voicerecordingcuesettings.playASoundWhenRecordingStartsAndStopsOn"
        toggleLabel="settings.voicerecordingcuesettings.playRecordingCues"
        field="audioCuesEnabled"
        testId="voice-recording-cues"
        enabled={data.config.audioCuesEnabled}
        disabled={saving}
        onPatch={(next) => void patch(next)}
      />
      <VoiceVadSettings provider={speech.state?.effective.recognition?.connection ?? ""} value={data.config.sttVad} status={(runtime ?? data.telomiAudio.runtime).vad} disabled={saving} onChange={(sttVad) => void patch({ sttVad })} />
      <VoiceHistorySettings />
      {saveError && <div className="rounded-[0.55rem] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[0.85rem] text-destructive">{saveError}</div>}
    </SettingsPanel>
  );
}
