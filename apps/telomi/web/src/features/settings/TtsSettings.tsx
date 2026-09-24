import { audioConfigApi } from "@/features/voice/api";
import type { AudioGenerationConfiguration, AudioGenerationConsumer, AudioGenerationResponse, AudioGenerationSelection } from "@shared/audio-generation.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { uiText } from "@/app/ui-text";
import { AssignmentBoard, type BoardRow, type BoardSelection } from "./AssignmentBoard";
import { ConnectionsSection } from "./ConnectionsSection";
import { PendingConfigNotice, UnsavedChangesNotice } from "./PendingConfigNotice";
import { SettingsLoading, SettingsPanel } from "./SettingsPanel";
import { useAppliedConfig } from "./use-applied-config";
import { useAudioConfig } from "./use-audio-config";
import { useConnections } from "./use-connections";
import { VoiceLocalRuntimeSettings } from "./VoiceLocalRuntimeSettings";
import { VoicePreviewButton } from "./VoicePreviewButton";

const CONSUMERS: AudioGenerationConsumer[] = ["playback", "local", "podcast"];
const ROWS = ["default", ...CONSUMERS];

/** What a row speaks with under one configuration: its own selection, or the default it follows. */
function selectionFor(config: AudioGenerationConfiguration, rowId: string): AudioGenerationSelection | null {
  return (rowId === "default" ? config.default : config[rowId as AudioGenerationConsumer] ?? config.default) ?? null;
}

const same = (a: AudioGenerationSelection | null, b: AudioGenerationSelection | null) =>
  a?.connection === b?.connection && a?.model === b?.model && a?.voice === b?.voice && a?.rate === b?.rate;

/**
 * The configuration one row edit produces, on top of the edits already made. A row with no
 * selection follows the default again, which is a change of its own even where both speak alike.
 */
export function generationDraft(base: AudioGenerationConfiguration, rowId: string, next: BoardSelection | null): AudioGenerationConfiguration {
  const config: AudioGenerationConfiguration = { ...base };
  const selection = next ? { connection: next.connection, model: next.model, voice: next.voice ?? "", rate: next.rate ?? 1 } : undefined;
  if (rowId === "default") { if (selection) config.default = selection; }
  else if (selection) config[rowId as AudioGenerationConsumer] = selection;
  else delete config[rowId as AudioGenerationConsumer];
  return config;
}

/** Which rows `draft` changes against `base`: one that starts or stops following the default, and one that would speak differently. */
export function generationChanges(base: AudioGenerationConfiguration, draft: AudioGenerationConfiguration): string[] {
  return ROWS.filter((id) => {
    if (id !== "default" && Boolean(draft[id as AudioGenerationConsumer]) !== Boolean(base[id as AudioGenerationConsumer])) return true;
    return !same(selectionFor(draft, id), selectionFor(base, id));
  });
}

/**
 * Rows for the speech board: the default, then each speaking consumer with what serves it now.
 * Selections come from `draft` while the user is still editing, so every row, inherited ones
 * included, previews what it would speak with. The status column says whether a row is an unsaved
 * edit, one of the `unfinished` rows still waiting for a model, or a draft saved for later, before
 * it repeats what the Runtime reports about the active one.
 */
export function ttsBoardRows(state: AudioGenerationResponse, draft?: AudioGenerationConfiguration, unfinished: string[] = []): BoardRow[] {
  const saved = state.pending ?? state.active;
  const own = draft ?? saved;
  const unsaved = draft ? generationChanges(saved, draft) : [];
  const notApplied = generationChanges(state.active, own);
  const stateOf = (id: string, runtime?: BoardRow["status"]): BoardRow["status"] =>
    unsaved.includes(id) || unfinished.includes(id) ? { text: uiText("settings.board.unsaved"), tone: "pending" }
      : notApplied.includes(id) ? { text: uiText("settings.board.savedNotApplied"), tone: "pending" }
      : runtime;
  return [
    { id: "default", label: uiText("settings.audioGeneration.default"), hint: uiText("settings.board.defaultHint"), own: own.default ?? null, resolved: own.default ?? null, status: stateOf("default") },
    ...CONSUMERS.map((id): BoardRow => {
      const status = state.consumers.find((item) => item.id === id)?.status;
      return {
        id,
        label: uiText(`settings.audioGeneration.${id}`),
        own: own[id] ?? null,
        resolved: selectionFor(own, id),
        // Each consumer names its own boundary: playback speaks, the local Worker converses, the
        // Narrator generates. One shared "next playback" would be wrong for two of the three.
        status: stateOf(id, status === "unconfigured" ? { text: uiText("settings.board.noModelChosen"), tone: "pending" }
          : status === "pending" ? { text: uiText(`settings.board.nextUse.${id}`), tone: "pending" }
          : status === "unavailable" ? { text: uiText("settings.board.unavailable"), tone: "error" }
          : status === "active" ? { text: uiText("settings.board.active"), tone: "ok" } : undefined),
      };
    }),
  ];
}

/** Which connection, model and voice speak for each consumer, the local runtime and credentials that serve them, and a preview of every row. */
export function TtsSettings() {
  const { connections, refresh } = useConnections();
  // The local runtime lists itself as a connection once it is healthy; both connection lists re-read that.
  const [listed, setListed] = useState(0);
  const audio = useAudioConfig();
  const generation = useAppliedConfig<AudioGenerationResponse>(audioConfigApi.generationPath);
  const [previewText, setPreviewText] = useState("");
  // Speech edits are staged: one mis-picked voice would otherwise change what every podcast
  // speaks with, so nothing reaches the Runtime until the user saves the draft or applies it.
  const [draft, setDraft] = useState<AudioGenerationConfiguration | null>(null);
  // Rows whose selection is half finished, a connection without a model so far. They are part of
  // the unsaved edits, but nothing can be saved while one is open.
  const [unfinished, setUnfinished] = useState<string[]>([]);
  // A discarded edit leaves the board itself holding half-chosen cells and half-typed model ids, so it starts over.
  const [boardKey, setBoardKey] = useState(0);

  // The draft is edited on top of a saved one when the server kept one, so a refused change is corrected rather than started over.
  const saved = generation.state ? generation.state.pending ?? generation.state.active : undefined;
  const staged = draft && saved && generationChanges(saved, draft).length > 0 ? draft : null;
  const rows = useMemo(() => (generation.state ? ttsBoardRows(generation.state, staged ?? undefined, unfinished) : []), [generation.state, staged, unfinished]);

  // A draft the server took, applied or saved for later, is no longer this page's: the next edit starts from the answer.
  useEffect(() => {
    setDraft((current) => (current && saved && generationChanges(saved, current).length === 0 ? null : current));
  }, [saved]);

  // The edit stays in this page's draft, so it keeps the edits already made to its siblings and sends nothing.
  const onRowChange = useCallback((rowId: string, next: BoardSelection | null) => {
    if (saved) setDraft(generationDraft(draft ?? saved, rowId, next));
  }, [draft, saved]);

  const onHalfEdit = useCallback((rowId: string, half: Partial<BoardSelection> | null) => {
    setUnfinished((current) => half ? current.includes(rowId) ? current : [...current, rowId] : current.filter((id) => id !== rowId));
  }, []);

  const discard = useCallback(() => { setDraft(null); setUnfinished([]); setBoardKey((count) => count + 1); }, []);
  // Applying changes which connections are in use; the connection cards re-read that.
  const apply = (edit?: AudioGenerationConfiguration) => { void generation.apply(edit).then(() => setListed((count) => count + 1)); };

  if (!generation.state || !audio.data) return <SettingsLoading id="tts" error={generation.error || audio.loadError || null} />;

  const spoken = previewText.trim() || uiText("settings.tts.previewTextDefault");
  const error = generation.error || generation.state.error;

  return (
    <SettingsPanel id="tts" heading="settings.section.tts" description="settings.section.ttsDescription">
      <VoiceLocalRuntimeSettings initialStatus={audio.data.telomiAudio.runtime} onReady={() => { refresh(); setListed((count) => count + 1); void audio.reload(); void generation.reload(); }} />
      <ConnectionsSection capability="tts" reloadToken={listed} onChanged={() => { refresh(); void generation.reload(); }} />

      <div className="grid gap-3" data-testid="audio-generation-settings">
        <div className="grid gap-1">
          <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.board.assignments")}</h3>
          <p className="m-0 text-[0.85rem] text-muted-foreground">{uiText("settings.audioGeneration.boundary")}</p>
        </div>
        {staged || unfinished.length > 0 ? (
          <UnsavedChangesNotice busy={generation.busy} incomplete={!staged || unfinished.length > 0} testId="tts-draft" onDiscard={discard}
            onSave={() => { if (staged) void generation.savePending(staged); }} onApply={() => { if (staged) apply(staged); }} />
        ) : generation.state.pending && (
          <PendingConfigNotice busy={generation.busy} onApply={() => apply()} onDiscard={() => { discard(); void generation.discard(); }} testId="tts-pending"
            hint={generation.state.status === "failed" ? undefined : uiText("settings.board.savedPending")} />
        )}
        <AssignmentBoard key={boardKey} capability="tts" rows={rows} connections={connections} columns={["voice", "rate"]} busy={generation.busy} testId="tts-board" onChange={onRowChange} onHalfEdit={onHalfEdit}
          action={(row, selection) => <VoicePreviewButton selection={selection} text={spoken} testId={`tts-board-preview-${row.id}`} />} />
        {error && <p role="alert" className="m-0 text-[0.85rem] text-destructive">{error}</p>}
        <div className="grid gap-1.5">
          <label className="text-[0.82rem] text-muted-foreground" htmlFor="tts-preview-text">{uiText("settings.page.previewText")}</label>
          <textarea
            id="tts-preview-text"
            value={previewText}
            placeholder={uiText("settings.tts.previewTextDefault")}
            maxLength={500}
            rows={3}
            onChange={(event) => setPreviewText(event.target.value)}
            className="min-h-[4.75rem] resize-y rounded-[0.5rem] border border-border bg-popover px-3 py-2 text-[0.85rem] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-[var(--input)]"
            data-testid="tts-preview-text"
          />
          <span className="text-[0.76rem] text-muted-foreground">{uiText("settings.tts.previewTextHint")}</span>
        </div>
      </div>
    </SettingsPanel>
  );
}
