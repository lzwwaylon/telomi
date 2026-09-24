import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { PlusIcon as Plus } from "@/shared/ui/icons";
import { apiClient } from "@/shared/lib/api-client";
import { setStoredDefaultModel } from "@/shared/lib/theme";
import { uiText } from "@/app/ui-text";
import { SELECT_CLS, BTN_PRIMARY } from "./settings-styles";
import { type ProviderConfig, type TaskModelRole } from "./provider-config";
import { AssignmentBoard, type BoardRow, type BoardSelection } from "./AssignmentBoard";
import { ConnectionTestButton } from "./ConnectionModelFields";
import { ConnectionsSection } from "./ConnectionsSection";
import { MEMORY_MODELS_ANCHOR } from "./MemoryEmbeddingSettings";
import { EnabledProviderGroup } from "./ProviderModelSections";
import { SettingsLoading, SettingsPanel } from "./SettingsPanel";
import { useConnections } from "./use-connections";
import { useProviderConfig } from "./use-provider-config";

const splitRef = (ref: string | undefined | null): { connection: string; model: string } | null => {
  const slash = ref?.indexOf("/") ?? -1;
  return ref && slash > 0 ? { connection: ref.slice(0, slash), model: ref.slice(slash + 1) } : null;
};

/** Rows for the assignment board: the global default first, then every task role with its Run Stages. */
export function chatBoardRows(config: ProviderConfig): BoardRow[] {
  const globalDepth = config.defaultThinkingLevel || "off";
  const global = config.defaultProvider && config.defaultModel
    ? { connection: config.defaultProvider, model: config.defaultModel, depth: globalDepth }
    : null;
  const mainAgent = config.consumers?.find((consumer) => consumer.id === "mainAgent");
  const memory = config.memoryConfiguration;
  const rows: BoardRow[] = [{
    id: "default",
    label: uiText("settings.board.default"),
    hint: uiText("settings.board.defaultHint"),
    own: global,
    resolved: global,
    // Memory follows this row and restarts its service to adopt it; that outage is stated here.
    status: memory?.status === "validating" || memory?.status === "applying"
      ? { text: uiText("settings.board.memoryApplying"), tone: "busy" }
      // Without a global default there is nothing for Memory to adopt yet; that is not a failure the user caused.
      : memory?.status === "failed" && !global
        ? { text: uiText("settings.board.memoryNeedsDefault"), tone: "pending" }
      : memory?.status === "failed" && memory.embeddingSelected === false
        ? { text: uiText("settings.board.memoryNeedsEmbedding"), tone: "pending", link: { label: uiText("settings.board.memoryChooseEmbedding"), href: "/settings?section=embedding" } }
      // The reason and the fix both live on the User Memory models page.
      : memory?.status === "failed"
        ? { text: uiText("settings.board.memoryFailed"), tone: "error", link: { label: uiText("settings.board.memoryFix"), href: `/settings?section=embedding#${MEMORY_MODELS_ANCHOR}` } }
        : mainAgent?.status === "failed"
          ? { text: uiText("settings.board.modelRejected", { error: mainAgent.error ?? "" }), tone: "error" }
          : mainAgent?.status === "pending"
            ? { text: uiText("settings.board.pendingGoals", { count: mainAgent.pendingCount }), tone: "pending" }
            // Nothing is chosen for the user: without a default, chats and tasks cannot start.
            : global ? { text: uiText("settings.board.active"), tone: "ok" } : { text: uiText("settings.board.noDefault"), tone: "error" },
  }];
  for (const role of config.taskModelRoles) {
    const consumer = config.consumers?.find((entry) => entry.id === role.id);
    const stages = (consumer?.stages ?? Object.entries(role.stages).map(([stage, info]) => ({ key: `${role.id}.${stage}`, label: info.label, thinkingLevel: globalDepth })))
      .map((stage) => ({ key: stage.key, label: stage.label, own: config.stageThinkingLevels[stage.key] ?? null, resolved: stage.thinkingLevel }));
    const ownDepths = new Set(stages.map((stage) => stage.own));
    // The role's depth cell sets every Stage at once; it shows the shared value, else the default.
    const roleDepth = ownDepths.size === 1 && stages[0]?.own ? stages[0].own : globalDepth;
    const own = splitRef(config.taskModels[role.id]);
    rows.push({
      id: role.id,
      label: role.label,
      hint: role.description,
      own: own ? { ...own, depth: roleDepth } : null,
      resolved: global ? { ...(own ?? global), depth: roleDepth } : own ? { ...own, depth: roleDepth } : null,
      stages,
      status: consumer?.status === "pending"
        ? { text: uiText("settings.board.pendingRuns", { count: consumer.pendingCount }), tone: "pending" }
        : consumer?.effectiveModel ? { text: uiText("settings.board.active"), tone: "ok" } : undefined,
    });
  }
  return rows;
}

/** Which connection and model each chat and task role runs, and the credentials that serve them. */
export function ChatModelSettings() {
  const { config, setConfig, loading, loadError, saving, saveError, patch, reload: reloadProviderConfig } = useProviderConfig();
  const { connections, refresh: refreshConnections } = useConnections();

  const onConnectionsChanged = useCallback(() => { reloadProviderConfig(); refreshConnections(); }, [reloadProviderConfig, refreshConnections]);
  // Assigning a model changes which connections are in use; the connection cards re-read that.
  const [usageVersion, setUsageVersion] = useState(0);

  const syncLocalStorageDefault = useCallback((next: ProviderConfig) => {
    setStoredDefaultModel(next.defaultProvider && next.defaultModel ? `${next.defaultProvider}/${next.defaultModel}` : null);
  }, []);

  // A selection applies as soon as it is made. The Runtime validates it and reports the active
  // configuration; a rejected selection leaves the active one unchanged.
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const applyDefaults = useCallback(async (next: BoardSelection | null) => {
    setApplying(true);
    setApplyError(null);
    try {
      const applied = await apiClient.post<ProviderConfig>("/api/provider-config/apply", {
        defaultProvider: next?.connection || null,
        defaultModel: next?.model || null,
        defaultThinkingLevel: next?.depth && next.depth !== "off" ? next.depth : null,
      });
      setConfig(applied);
      syncLocalStorageDefault(applied);
      setUsageVersion((value) => value + 1);
      window.dispatchEvent(new Event("mom:models-invalidate"));
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
      reloadProviderConfig();
    } finally {
      setApplying(false);
    }
  }, [reloadProviderConfig, setConfig, syncLocalStorageDefault]);

  const rows = useMemo(() => (config ? chatBoardRows(config) : []), [config]);

  // The Memory service adopts a new default in the background; keep asking until it settles.
  const memoryBusy = config?.memoryConfiguration?.status === "validating" || config?.memoryConfiguration?.status === "applying";
  useEffect(() => {
    if (!memoryBusy) return;
    const timer = window.setInterval(reloadProviderConfig, 3000);
    return () => window.clearInterval(timer);
  }, [memoryBusy, reloadProviderConfig]);

  const setStageDepths = useCallback((updates: Record<string, string | null>) => {
    const next = { ...(config?.stageThinkingLevels ?? {}) };
    for (const [key, level] of Object.entries(updates)) {
      if (level) next[key] = level;
      else delete next[key];
    }
    return patch({ stageThinkingLevels: next }).catch(() => { /* surfaced */ });
  }, [config?.stageThinkingLevels, patch]);

  const onRowChange = useCallback(async (rowId: string, next: BoardSelection | null) => {
    if (rowId === "default") { await applyDefaults(next); return; }
    const role = rowId as TaskModelRole;
    const row = rows.find((entry) => entry.id === role);
    const modelRef = next ? `${next.connection}/${next.model}` : undefined;
    if (modelRef !== config?.taskModels[role]) {
      const taskModels = { ...(config?.taskModels ?? {}) };
      if (modelRef) taskModels[role] = modelRef;
      else delete taskModels[role];
      try { await patch({ taskModels }); setUsageVersion((value) => value + 1); } catch { /* surfaced */ }
    }
    if (next?.depth && next.depth !== row?.resolved?.depth) {
      await setStageDepths(Object.fromEntries((row?.stages ?? []).map((stage) => [stage.key, next.depth ?? null])));
    }
  }, [applyDefaults, config?.taskModels, patch, rows, setStageDepths]);

  const enabledSet = useMemo(() => new Set(config?.enabledModels ?? []), [config?.enabledModels]);
  const primaryModelId = config?.defaultProvider && config.defaultModel ? `${config.defaultProvider}/${config.defaultModel}` : null;
  const fallbackOptions = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    for (const connection of connections) {
      if (!connection.capabilities.includes("chat") || connection.status === "unconfigured") continue;
      for (const model of connection.models.chat) {
        const id = `${connection.id}/${model.id}`;
        if (id === primaryModelId) continue;
        out.push({ id, label: `${model.name ?? model.id} (${connection.id})` });
      }
    }
    return out;
  }, [connections, primaryModelId]);
  const fallbackModelSet = useMemo(() => new Set(config?.providerFallbackModels ?? []), [config]);
  const addableFallbackOptions = useMemo(() => fallbackOptions.filter((m) => !fallbackModelSet.has(m.id)), [fallbackOptions, fallbackModelSet]);
  const [fallbackToAdd, setFallbackToAdd] = useState("");
  useEffect(() => {
    if (addableFallbackOptions.length === 0) {
      if (fallbackToAdd) setFallbackToAdd("");
      return;
    }
    if (!addableFallbackOptions.some((m) => m.id === fallbackToAdd)) setFallbackToAdd(addableFallbackOptions[0].id);
  }, [addableFallbackOptions, fallbackToAdd]);

  const onToggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    const current = new Set(config?.enabledModels ?? []);
    if (enabled) current.add(id);
    else current.delete(id);
    try { await patch({ enabledModels: Array.from(current) }); } catch { /* surfaced */ }
  }, [config, patch]);

  const setFallbackModels = useCallback(async (next: string[]) => {
    try { await patch({ providerFallbackModels: next }); } catch { /* surfaced */ }
  }, [patch]);
  const onAddFallbackModel = useCallback(() => {
    const current = config?.providerFallbackModels ?? [];
    if (!fallbackToAdd || current.includes(fallbackToAdd)) return;
    void setFallbackModels([...current, fallbackToAdd]);
  }, [config, fallbackToAdd, setFallbackModels]);
  const onMoveFallbackModel = useCallback((id: string, direction: -1 | 1) => {
    const current = [...(config?.providerFallbackModels ?? [])];
    const index = current.indexOf(id);
    const nextIndex = index + direction;
    if (index === -1 || nextIndex < 0 || nextIndex >= current.length) return;
    [current[index], current[nextIndex]] = [current[nextIndex], current[index]];
    void setFallbackModels(current);
  }, [config, setFallbackModels]);

  if (loading || loadError || !config) {
    return <SettingsLoading id="chat" error={loadError ?? (loading ? null : uiText("settings.page.noData"))} />;
  }

  const inputDisabled = saving || applying;
  // The Runtime keeps the probe's verdict; the row's status column shows it once the config is re-read.
  const boardTest = (row: BoardRow, shown: BoardSelection) => (
    <ConnectionTestButton capability="chat" connection={shown.connection} model={shown.model} disabled={inputDisabled} testId={`chat-board-test-${row.id}`} onSettled={reloadProviderConfig} />
  );
  const configuredChat = connections.filter((connection) => connection.capabilities.includes("chat") && connection.status !== "unconfigured");

  return (
    <SettingsPanel id="chat" heading="settings.section.chat" description="settings.section.chatDescription">
      <ConnectionsSection capability="chat" onChanged={onConnectionsChanged} reloadToken={usageVersion} />

      <div className="grid gap-3" data-testid="provider-model-defaults">
        <div className="grid gap-1">
          <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.board.assignments")}</h3>
          <p className="m-0 text-[0.85rem] text-muted-foreground">{uiText("settings.board.assignmentsHint")} {uiText("settings.page.defaultModelAppliesAtExecutionBoundaries")}</p>
        </div>
        <AssignmentBoard capability="chat" rows={rows} connections={connections} columns={["depth"]} depthLevels={config.thinkingLevels} busy={inputDisabled} testId="chat-board"
          onChange={(rowId, next) => void onRowChange(rowId, next)} onStageDepthChange={(key, level) => void setStageDepths({ [key]: level })} action={boardTest} />
        {(applyError || saveError) && (
          <div className="rounded-[0.55rem] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[0.85rem] text-destructive" data-testid="provider-defaults-error">
            {applyError ?? saveError}
          </div>
        )}
      </div>

      <div className="grid gap-3">
        <div className="grid gap-1">
          <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.page.modelFallbackOrder")}</h3>
          <p className="m-0 text-[0.85rem] text-muted-foreground">{uiText("settings.page.theRuntimeStartsWithTheDefaultModelIfAuthentication")}</p>
        </div>
        <div className="rounded-[0.55rem] border border-border bg-card">
          <div className="grid gap-2 p-3">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 max-[520px]:grid-cols-1">
              <select value={fallbackToAdd} onChange={(e) => setFallbackToAdd(e.target.value)} disabled={inputDisabled || addableFallbackOptions.length === 0} className={SELECT_CLS} data-testid="provider-fallback-add-model" aria-label={uiText("settings.page.addFallbackModel")}>
                {addableFallbackOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                {addableFallbackOptions.length === 0 && <option value="">{uiText("settings.page.noFallbackModelsAvailable")}</option>}
              </select>
              <button type="button" onClick={onAddFallbackModel} disabled={inputDisabled || !fallbackToAdd} className={BTN_PRIMARY} data-testid="provider-fallback-add">
                <Plus className="h-3.5 w-3.5" aria-hidden />{uiText("settings.page.add")}
              </button>
            </div>
            <div className="text-[0.78rem] text-muted-foreground">{uiText("settings.page.primary")} {primaryModelId ?? uiText("common.notSet")}</div>
          </div>
          {(config.providerFallbackModels ?? []).length === 0 ? (
            <div className="border-t border-border px-3 py-3 text-[0.85rem] text-muted-foreground">{uiText("settings.page.noFallbackModelsConfigured")}</div>
          ) : (
            <ol className="list-none m-0 p-0 border-t border-border" data-testid="provider-fallback-list">
              {config.providerFallbackModels.map((id, index) => (
                <li key={id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-border first:border-t-0 px-3 py-2">
                  <span className="text-[0.78rem] font-mono text-muted-foreground">{index + 2}</span>
                  <div className="min-w-0">
                    <div className="truncate text-[0.88rem] text-foreground">{fallbackOptions.find((m) => m.id === id)?.label ?? id}</div>
                    <div className="truncate text-[0.74rem] font-mono text-muted-foreground">{id}</div>
                  </div>
                  <div className="inline-flex items-center gap-1">
                    <button type="button" onClick={() => onMoveFallbackModel(id, -1)} disabled={inputDisabled || index === 0} className="inline-flex h-7 w-7 items-center justify-center rounded-[0.45rem] border border-border text-muted-foreground hover:bg-[var(--foreground-5)] disabled:opacity-40" aria-label={uiText("settings.page.moveIdUp", { id })} title={uiText("common.moveUp")}>
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button type="button" onClick={() => onMoveFallbackModel(id, 1)} disabled={inputDisabled || index === config.providerFallbackModels.length - 1} className="inline-flex h-7 w-7 items-center justify-center rounded-[0.45rem] border border-border text-muted-foreground hover:bg-[var(--foreground-5)] disabled:opacity-40" aria-label={uiText("settings.page.moveIdDown", { id })} title={uiText("common.moveDown")}>
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button type="button" onClick={() => void setFallbackModels(config.providerFallbackModels.filter((x) => x !== id))} disabled={inputDisabled} className="inline-flex h-7 w-7 items-center justify-center rounded-[0.45rem] border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-40" aria-label={uiText("settings.page.deleteFallbackId", { id })} title={uiText("common.delete")}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="grid gap-3">
        <div className="grid gap-1">
          <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.page.enabledModels")}</h3>
          <p className="m-0 text-[0.85rem] text-muted-foreground">
            {uiText("settings.page.modelsAvailableInGoalToolbarSelectorsStoredInSettings")} <code className="font-mono text-[0.78rem]">enabledModels</code>。
          </p>
        </div>
        <div className="grid gap-3" data-testid="provider-enabled-models">
          {config.providers.filter((p) => configuredChat.some((connection) => connection.id === p.id)).map((p) => (
            <EnabledProviderGroup key={p.id} provider={p} enabledSet={enabledSet} disabled={inputDisabled} onToggle={onToggleEnabled} />
          ))}
          {configuredChat.length === 0 && (
            <div className="text-[0.85rem] text-muted-foreground">{uiText("settings.connections.none")}</div>
          )}
        </div>
      </div>
    </SettingsPanel>
  );
}
