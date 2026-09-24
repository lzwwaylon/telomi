import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMBEDDING_CONSUMERS, HINDSIGHT_LOCAL_CONNECTION, type EmbeddingConfiguration, type EmbeddingConsumer, type EmbeddingResponse, type EmbeddingSelection } from "@shared/embedding-configuration.js";
import { uiText } from "@/app/ui-text";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { AssignmentBoard, type BoardRow, type BoardSelection } from "./AssignmentBoard";
import { ConnectionsSection } from "./ConnectionsSection";
import { PendingConfigNotice } from "./PendingConfigNotice";
import { SettingsLoading, SettingsPanel } from "./SettingsPanel";
import { BTN_PRIMARY } from "./settings-styles";
import { useAppliedConfig } from "./use-applied-config";
import { useConnections } from "./use-connections";
import { useProviderConfig } from "./use-provider-config";

const MEMORY_ROLES = ["llm", "retain", "reflect", "consolidation"] as const;
/** Where other settings pages send the user to fix a User Memory failure. */
export const MEMORY_MODELS_ANCHOR = "memory-models";
type MemoryRole = typeof MEMORY_ROLES[number];
type MemorySettings = Record<MemoryRole, { model?: string; reasoningEffort?: string }>;
interface MemoryView {
  settings: MemorySettings;
  pending: MemorySettings | null;
  active: Record<MemoryRole, { model: string | null; reasoningEffort: string }> | null;
  target: Record<MemoryRole, { model: string | null; source: string; reasoningEffort: string }>;
  status: "active" | "pending" | "validating" | "applying" | "failed";
  error: string | null;
  embeddingSelected: boolean;
}

const splitRef = (ref: string | null | undefined): { connection: string; model: string } | null => {
  const slash = ref?.indexOf("/") ?? -1;
  return ref && slash > 0 ? { connection: ref.slice(0, slash), model: ref.slice(slash + 1) } : null;
};

const same = (a: EmbeddingSelection | undefined, b: EmbeddingSelection | undefined) => a?.connection === b?.connection && a?.model === b?.model;

/** What each index would run under `draft`, and which ones that changes; a change means a rebuild. */
export function embeddingChanges(active: EmbeddingConfiguration, draft: EmbeddingConfiguration): EmbeddingConsumer[] {
  return EMBEDDING_CONSUMERS.filter((id) => !same(active[id] ?? active.default, draft[id] ?? draft.default));
}

/** `base` with one row changed; an index without its own selection follows the default. */
export function embeddingDraft(base: EmbeddingConfiguration, rowId: string, selection: EmbeddingSelection | null): EmbeddingConfiguration {
  const config: EmbeddingConfiguration = { ...base };
  if (rowId === "default") { if (selection) config.default = selection; }
  else if (selection) config[rowId as EmbeddingConsumer] = selection;
  else delete config[rowId as EmbeddingConsumer];
  return config;
}

/**
 * Rows for the embedding board: the default, then each index with what serves it now. Selections
 * come from `draft` when the user is still editing; status always states the server's side.
 */
export function embeddingBoardRows(state: EmbeddingResponse, draft: EmbeddingConfiguration = state.active): BoardRow[] {
  return [
    { id: "default", label: uiText("settings.embedding.default"), hint: uiText("settings.board.defaultHint"), own: draft.default ?? null, resolved: draft.default ?? null },
    ...EMBEDDING_CONSUMERS.map((id): BoardRow => {
      const consumer = state.consumers.find((item) => item.id === id);
      const effective = state.effective[id];
      const progress = consumer?.progress ? ` · ${uiText("settings.embedding.progress", { done: consumer.progress.done, total: consumer.progress.total })}` : "";
      return {
        id,
        label: uiText(`settings.embedding.${id}`),
        own: draft[id] ?? null,
        resolved: draft === state.active ? effective && { connection: effective.connection, model: effective.model } : draft.default ?? null,
        status: !consumer ? undefined
          : consumer.status === "unconfigured" ? { text: uiText("settings.embedding.status.unconfigured"), tone: "pending" }
          : consumer.status === "rebuilding" ? { text: `${uiText("settings.board.rebuilding")}${progress}`, tone: "busy" }
          : consumer.status === "failed" ? { text: consumer.error ?? uiText("settings.embedding.status.failed"), tone: "error" }
          : consumer.status === "unavailable" ? { text: uiText("settings.board.unavailable"), tone: "error" }
          : { text: uiText("settings.board.active"), tone: "ok" },
      };
    }),
  ];
}

/** Which connection and model produce vectors, and the credentials that serve them. */
export function MemoryEmbeddingSettings() {
  const { config } = useProviderConfig();
  const { connections, refresh } = useConnections();
  // Applying a selection changes which connections are in use; the connection cards re-read that.
  const [usageVersion, setUsageVersion] = useState(0);
  const usageChanged = useCallback(() => { refresh(); setUsageVersion((value) => value + 1); }, [refresh]);
  const embedding = useAppliedConfig<EmbeddingResponse>("/api/embedding-config", 5000);
  const memory = useAppliedConfig<MemoryView>("/api/provider-config/memory", 5000);

  // Embedding edits are staged: switching a model rebuilds an index, which costs time and API
  // usage, so nothing is sent until the user asks for the rebuild and confirms it. A rebuild that
  // was rejected or failed comes back as the server's saved draft, to retry or discard.
  const [draft, setDraft] = useState<EmbeddingConfiguration | null>(null);
  const [confirming, setConfirming] = useState(false);
  const active = embedding.state?.active;
  const running = embedding.state?.status === "validating" || embedding.state?.status === "rebuilding";
  const edited = draft ?? (running ? null : embedding.state?.pending ?? null);
  const staged = edited && active && embeddingChanges(active, edited).length > 0 ? edited : null;
  const changes = useMemo(() => (staged && active ? embeddingChanges(active, staged) : []), [staged, active]);

  // A rebuild commits its selection in the background, after the apply has answered: only then do
  // the connections it uses change, and User Memory starts or restarts with it.
  const reloadMemory = memory.reload;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) { usageChanged(); void reloadMemory(); }
    wasRunning.current = running;
  }, [running, usageChanged, reloadMemory]);

  const embeddingRows = useMemo(() => {
    if (!embedding.state) return [];
    // The local sentence-transformers connection only serves Memory.
    const shared = connections.filter((item) => item.id !== HINDSIGHT_LOCAL_CONNECTION);
    return embeddingBoardRows(embedding.state, staged ?? undefined).map((row) => row.id === "memory" ? row : { ...row, connections: shared });
  }, [embedding.state, staged, connections]);

  const onEmbeddingChange = useCallback((rowId: string, next: BoardSelection | null) => {
    if (!embedding.state || !active) return;
    setDraft(embeddingDraft(staged ?? active, rowId, next ? { connection: next.connection, model: next.model } : null));
  }, [embedding.state, active, staged]);

  const discardDraft = useCallback(() => {
    setDraft(null);
    if (embedding.state?.pending) void embedding.discard();
  }, [embedding]);

  const confirmRebuild = useCallback(async () => {
    if (!staged) return;
    setConfirming(false);
    await embedding.apply(staged);
    setDraft(null);
    usageChanged();
  }, [embedding, staged, usageChanged]);

  const memoryRows = useMemo((): BoardRow[] => {
    const view = memory.state;
    if (!view) return [];
    const draft = view.pending ?? view.settings;
    return MEMORY_ROLES.map((role) => {
      const own = draft[role];
      const target = view.target[role];
      const resolved = splitRef(target.model);
      const ownRef = splitRef(own.model);
      return {
        id: role,
        inherits: true,
        label: uiText(`settings.memory.${role}`),
        hint: role === "llm" ? uiText("settings.memory.inheritGlobal") : uiText("settings.memory.inheritMemory"),
        own: ownRef || own.reasoningEffort ? { ...(ownRef ?? resolved ?? {}), depth: own.reasoningEffort ?? target.reasoningEffort } : null,
        resolved: resolved ? { ...resolved, depth: target.reasoningEffort } : null,
        // Nothing to adopt yet without a global default or an own model; that is not a failure the user caused.
        status: view.status === "failed" && !target.model ? { text: uiText("settings.board.memoryNeedsDefault"), tone: "pending" }
          : view.status === "failed" && !view.embeddingSelected ? { text: uiText("settings.memory.needsEmbedding"), tone: "pending" }
          : view.status === "failed" ? { text: uiText("settings.memory.failed"), tone: "error" }
          : view.status === "validating" || view.status === "applying" ? { text: uiText(`settings.memory.${view.status}`), tone: "busy" }
          : view.active?.[role].model ? { text: uiText("settings.board.active"), tone: "ok" } : undefined,
      };
    });
  }, [memory.state]);

  const applyMemory = useCallback((settings: MemorySettings) => { void memory.apply(settings).then(usageChanged); }, [memory, usageChanged]);

  const onMemoryChange = useCallback((rowId: string, next: BoardSelection | null) => {
    const view = memory.state;
    if (!view) return;
    const role = rowId as MemoryRole;
    const base = view.pending ?? view.settings;
    const settings: MemorySettings = { ...base, [role]: {} };
    if (next) {
      const inherited = base[role].model ? null : splitRef(view.target[role].model);
      // Changing only the depth keeps the model inherited.
      const modelKept = inherited && inherited.connection === next.connection && inherited.model === next.model;
      settings[role] = {
        ...(modelKept ? {} : { model: `${next.connection}/${next.model}` }),
        ...(next.depth ? { reasoningEffort: next.depth } : {}),
      };
    }
    applyMemory(settings);
  }, [memory.state, applyMemory]);

  // A link from another settings page lands on the User Memory models. The sections above them
  // load on their own, so the jump repeats while the page grows, until the user takes over.
  const rendered = Boolean(config && embedding.state && memory.state);
  useEffect(() => {
    const target = rendered && window.location.hash === `#${MEMORY_MODELS_ANCHOR}` ? document.getElementById(MEMORY_MODELS_ANCHOR) : null;
    if (!target?.parentElement) return;
    const observer = new ResizeObserver(() => target.scrollIntoView({ block: "start" }));
    observer.observe(target.parentElement);
    const stop = () => observer.disconnect();
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const name of events) window.addEventListener(name, stop, { once: true });
    return () => { stop(); for (const name of events) window.removeEventListener(name, stop); };
  }, [rendered]);

  if (!config || (!embedding.state && !embedding.error) || (!memory.state && !memory.error)) {
    return <SettingsLoading id="embedding" error={embedding.error || memory.error || null} />;
  }
  const view = memory.state;

  return (
    <SettingsPanel id="embedding" heading="settings.section.embedding" description="settings.section.embeddingDescription">
      <ConnectionsSection capability="embedding" onChanged={refresh} reloadToken={usageVersion} />

      <div className="grid gap-3" data-testid="embedding-settings">
        <div className="grid gap-1">
          <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.embedding.title")}</h3>
          <p className="m-0 text-[0.85rem] text-muted-foreground">{uiText("settings.embedding.boundary")}</p>
        </div>
        {embedding.state && (
          <AssignmentBoard capability="embedding" rows={embeddingRows} connections={connections} busy={embedding.busy} disabled={embedding.state.status === "rebuilding"} testId="embedding-board" onChange={onEmbeddingChange} />
        )}
        {staged && (
          <div className="flex flex-wrap items-center gap-2 rounded-[0.55rem] border border-[var(--warm-line)] bg-[var(--warm-soft)] px-3 py-2 text-[0.85rem]" data-testid="embedding-staged">
            <span className="flex-1 min-w-[200px]">{uiText("settings.embedding.stagedHint", { consumers: changes.map((id) => uiText(`settings.embedding.${id}`)).join("、") || uiText("settings.embedding.default") })}</span>
            <button type="button" className={BTN_PRIMARY} onClick={discardDraft} disabled={embedding.busy} data-testid="embedding-discard">{uiText("settings.embedding.discard")}</button>
            <button type="button" className={`${BTN_PRIMARY} border-[var(--warm-line)]`} onClick={() => setConfirming(true)} disabled={embedding.busy || changes.length === 0} data-testid="embedding-apply">{uiText("settings.embedding.applyRebuild")}</button>
          </div>
        )}
        {(embedding.error || embedding.state?.error) && <p role="alert" className="m-0 text-[0.85rem] text-destructive">{embedding.error || embedding.state?.error}</p>}
        <Dialog open={confirming} onOpenChange={(open) => { if (!open) setConfirming(false); }}>
          <DialogContent className="border-border bg-card" data-testid="embedding-confirm-dialog">
            <DialogHeader>
              <DialogTitle>{uiText("settings.embedding.confirmTitle")}</DialogTitle>
              <DialogDescription className="pt-1">
                {uiText("settings.embedding.confirmBody", { consumers: changes.map((id) => uiText(`settings.embedding.${id}`)).join("、") })}
              </DialogDescription>
            </DialogHeader>
            <ul className="m-0 list-none p-0 grid gap-1 text-[0.85rem]">
              {changes.map((id) => {
                const target = staged?.[id] ?? staged?.default;
                return <li key={id} className="flex flex-wrap gap-x-2"><span className="text-muted-foreground">{uiText(`settings.embedding.${id}`)}</span><span className="font-mono text-[0.8rem]">{embedding.state?.effective[id] ? `${embedding.state.effective[id].connection} / ${embedding.state.effective[id].model}` : uiText("settings.embedding.status.unconfigured")}</span><span className="text-muted-foreground">→</span><span className="font-mono text-[0.8rem]">{target?.connection} / {target?.model}</span></li>;
              })}
            </ul>
            <DialogFooter className="gap-2">
              <button type="button" className={BTN_PRIMARY} onClick={() => setConfirming(false)}>{uiText("common.cancel")}</button>
              <button type="button" className={`${BTN_PRIMARY} border-[var(--warm-line)] text-[var(--warm)]`} onClick={() => void confirmRebuild()} data-testid="embedding-confirm">{uiText("settings.embedding.confirmYes")}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3 scroll-mt-4" id={MEMORY_MODELS_ANCHOR} aria-label={uiText("settings.memory.title")}>
        <div className="grid gap-1">
          <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.memory.title")}</h3>
          <p className="m-0 text-[0.85rem] text-muted-foreground">{uiText("settings.memory.description")}</p>
        </div>
        {view && (
          <>
            {view.pending && <PendingConfigNotice busy={memory.busy} onApply={() => { void memory.apply(); }} onDiscard={() => { void memory.discard(); }} testId="memory-pending" />}
            <AssignmentBoard capability="chat" rows={memoryRows} connections={connections} columns={["depth"]} depthLevels={config.thinkingLevels} busy={memory.busy || view.status === "validating" || view.status === "applying"} testId="memory-board" onChange={onMemoryChange} />
          </>
        )}
        {(memory.error || (view?.error && view.target.llm.model && view.embeddingSelected)) && <p role="alert" className="m-0 text-[0.85rem] text-destructive">{memory.error || view?.error}</p>}
      </div>
    </SettingsPanel>
  );
}
