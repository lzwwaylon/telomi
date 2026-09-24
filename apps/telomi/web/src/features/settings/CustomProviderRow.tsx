import { useCallback, useMemo, useState } from "react";
import { Eye, EyeOff, Loader2, RefreshCcw, Trash2 } from "lucide-react";
import { PlusIcon as Plus } from "@/shared/ui/icons";
import { apiClient } from "@/shared/lib/api-client";
import { cn } from "@/shared/lib/utils";
import {
  pinnedCapability,
  type CustomProviderCapability,
  type CustomProviderModel,
  type CustomProviderSummary as CustomProviderEntry,
} from "@shared/types.js";
import { uiText } from "@/app/ui-text";
import type { ConnectionCapability, ConnectionSummary } from "@shared/connections.js";
import { capabilitiesFor } from "@shared/model-capabilities.js";
import { CAPABILITY_LABEL, ConnectionBadges } from "./ConnectionBadges";
import { SELECT_CLS, BTN_PRIMARY, BTN_DANGER } from "./settings-styles";
import { connectionTestFailureText, connectionTestFeedback } from "./use-test-model";
import { OllamaConnectionForm } from "./OllamaConnectionForm";
import { looksLikeOllama } from "@shared/ollama.js";

/** A connection definition that is prepared but not in use until the user applies it. */
export function PendingCustomProviderRow({
  provider,
  onChanged,
}: {
  provider: CustomProviderEntry;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(async (intent: "apply" | "discard") => {
    setBusy(true);
    setError(null);
    try {
      const path = `/api/custom-providers/${encodeURIComponent(provider.id)}`;
      // Discarding removes the prepared definition only; the connection in use stays.
      if (intent === "apply") await apiClient.put(path, {});
      else await apiClient.delete(`${path}/pending`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [provider.id, onChanged]);

  return (
    <li className="rounded-[0.55rem] border border-border bg-card px-3 py-2" data-testid={`custom-provider-pending-${provider.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[0.9rem] font-medium text-foreground">{provider.id}</div>
          <div className="truncate text-[0.78rem] text-muted-foreground">
            {uiText("settings.page.connectionSavedForLaterNotActive")}
          </div>
        </div>
        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy}
            onClick={() => act("apply")}
            data-testid={`custom-provider-apply-${provider.id}`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {uiText("settings.page.saveAndApply")}
          </button>
          {busy && (
            <span className="text-[0.78rem] text-muted-foreground">
              {uiText("settings.page.applyStateValidating")}
            </span>
          )}
          <button
            type="button"
            className={BTN_DANGER}
            disabled={busy}
            onClick={() => act("discard")}
          >
            {uiText("common.delete")}
          </button>
        </div>
      </div>
      {error && (
        <div className="pt-2 text-[0.78rem] text-destructive">
          {uiText("settings.page.applyStateFailed")}: {error}
        </div>
      )}
    </li>
  );
}

export function CustomProviderRow({
  provider,
  summary,
  capability,
  onChanged,
}: {
  provider: CustomProviderEntry;
  summary?: ConnectionSummary;
  /** The page's capability: only its models are offered for the probe, which runs through it. */
  capability?: ConnectionCapability;
  onChanged: () => void;
}) {
  const probeCapability = capability ?? pinnedCapability(provider.capability) ?? "chat";
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"delete" | "test" | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  // The probe speaks the page's capability, so only models serving it are offered.
  const testable = useMemo(() => {
    const listed = summary?.models[probeCapability] ?? [];
    return listed.length ? listed : provider.models.filter((m) => !m.capabilities || m.capabilities.includes(probeCapability));
  }, [provider, summary, probeCapability]);
  // The header counts every model the connection serves, the same ones its capability badges count,
  // not only this page's; like the probe list, it falls back to the saved list before discovery.
  const modelCount = new Set(Object.values(summary?.models ?? {}).flat().map((model) => model.id)).size || provider.models.length;
  // The user picks the model a probe speaks; nothing is chosen for them.
  const [testModel, setTestModel] = useState("");

  const remove = useCallback(async () => {
    if (!confirm(`Delete custom provider "${provider.id}"?`)) return;
    setBusy("delete");
    setFeedback(null);
    try {
      await apiClient.delete(
        `/api/custom-providers/${encodeURIComponent(provider.id)}`,
      );
      onChanged();
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }, [provider.id, onChanged]);

  const test = useCallback(async () => {
    const modelId = testModel;
    if (!modelId) {
      setFeedback({ kind: "err", text: uiText(testable.length ? "settings.page.pickTestModelFirst" : "settings.page.noModelsInThisProvider") });
      return;
    }
    setBusy("test");
    setFeedback(null);
    try {
      const data = probeCapability === "chat"
        ? await apiClient.post<{ ok?: boolean; error?: string; durationMs?: number }>(`/api/custom-providers/${encodeURIComponent(provider.id)}/test`, { modelId })
        : await apiClient.post<{ ok?: boolean; error?: string; durationMs?: number }>(`/api/connections/${encodeURIComponent(provider.id)}/test`, { capability: probeCapability, model: modelId });
      setFeedback(connectionTestFeedback(data, modelId));
    } catch (err) {
      setFeedback({
        kind: "err",
        text: connectionTestFailureText(err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setBusy(null);
    }
  }, [provider, testModel, testable, probeCapability]);

  return (
    <li
      className="rounded-[0.55rem] border border-border bg-card"
      data-testid={`custom-provider-${provider.id}`}
    >
      <div className="grid grid-cols-1 items-center gap-3 px-3 py-2 lg:grid-cols-[minmax(12rem,1fr)_auto]">
        <div className="grid gap-0.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[0.92rem] font-medium text-foreground">
              {provider.id}
            </span>
            <span className="text-[0.7rem] font-normal text-muted-foreground border border-border rounded px-1.5 py-0.5 font-mono">
              {provider.api}
            </span>
          </div>
          <div
            className="text-[0.78rem] text-muted-foreground truncate"
            title={provider.baseUrl}
          >
            {provider.baseUrl} · {uiText("settings.page.countModels", { count: modelCount })}
            {provider.hasApiKey
              ? ` · ${uiText("settings.page.keyHint", { hint: provider.apiKeyHint ?? uiText("settings.page.set") })}`
              : ` · ${uiText("settings.page.noKey")}`}
          </div>
          <ConnectionBadges summary={summary} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 lg:justify-end">
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => setEditing((v) => !v)}
            disabled={busy !== null}
          >
            {editing ? uiText("common.close") : uiText("common.edit")}
          </button>
          {testable.length > 0 && (
            <select
              className="h-7 min-w-[140px] max-w-[20rem] flex-1 rounded border border-border bg-card px-1.5 text-[0.78rem] font-mono text-foreground"
              value={testModel}
              onChange={(e) => setTestModel(e.target.value)}
              disabled={busy !== null}
              aria-label={uiText("settings.page.modelUsedToTestId", { id: provider.id })}
              title={uiText("settings.page.modelUsedForTesting")}
              data-testid={`custom-provider-${provider.id}-test-model`}
            >
              <option value="">{uiText("settings.page.pickTestModel")}</option>
              {testable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={test}
            disabled={busy !== null || !testModel}
            title={testable.length === 0 ? uiText("settings.page.noModelsInThisProvider") : !testModel ? uiText("settings.page.pickTestModelFirst") : uiText("settings.page.sendASmallHealthCheck")}
          >
            {busy === "test" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            {uiText("settings.page.test")}
          </button>
          <button
            type="button"
            className={BTN_DANGER}
            onClick={remove}
            disabled={busy !== null}
            aria-label={uiText("settings.page.deleteCustomProviderId", {
              id: provider.id,
            })}
            title={uiText("settings.page.deleteId", { id: provider.id })}
          >
            {busy === "delete" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        </div>
      </div>

      {editing && (looksLikeOllama(provider.baseUrl) && (probeCapability === "chat" || probeCapability === "embedding") ? (
        <div className="border-t border-border pt-3 px-3 pb-3">
          <OllamaConnectionForm capability={probeCapability} initial={provider} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />
        </div>
      ) : (
        <CustomProviderForm
          mode="edit"
          initial={provider}
          viewCapability={probeCapability}
          validationModel={testModel || undefined}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ))}

      {feedback && (
        <div
          className={cn(
            "px-3 pb-2 text-[0.78rem]",
            feedback.kind === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-destructive",
          )}
        >
          {feedback.text}
        </div>
      )}
    </li>
  );
}

export function CustomProviderForm({
  mode,
  initial,
  validationModel,
  lockedCapability,
  viewCapability,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  initial: CustomProviderEntry | null;
  /** The row's test model; applying runs one completion through it. Absent, the listing check applies. */
  validationModel?: string;
  /** Opened from a capability page: the pin is fixed there. */
  lockedCapability?: CustomProviderCapability;
  /**
   * The capability page the form is opened from: only its models are shown and added. The
   * connection's other models stay as they are, since the other pages select from them.
   */
  viewCapability?: ConnectionCapability;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [api, setApi] = useState<"openai-completions" | "openai-responses">(
    initial?.api ?? "openai-completions",
  );
  const [capability, setCapability] = useState<CustomProviderCapability | "">(initial?.capability ?? lockedCapability ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<CustomProviderModel[]>(
    initial?.models ?? [],
  );
  const [busy, setBusy] = useState<"save" | "discover" | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "ok" | "note" | "err";
    text: string;
  } | null>(null);
  const [newModelId, setNewModelId] = useState("");
  // Applying sends one completion through this model; catalogs mix in models an account cannot
  // route, so the user picks which one proves the connection.
  const [probeModel, setProbeModel] = useState(validationModel ?? "");
  // The apply probe is one chat completion, so it is offered only where chat models are shown.
  const chatModels = useMemo(() => capability || (viewCapability && viewCapability !== "chat") ? [] : models.filter((m) => !m.capabilities || m.capabilities.includes("chat")), [models, capability, viewCapability]);
  // Discovery is only useful if the user can see what each model is for, so the list is grouped by
  // capability, with a last group for models this endpoint offers that Telomi selects for nothing.
  // A capability page shows its own group only.
  const modelGroups = useMemo(() => {
    const order: ConnectionCapability[] = viewCapability ? [viewCapability] : ["chat", "embedding", "tts", "stt"];
    const groups: Array<readonly [ConnectionCapability | "other", CustomProviderModel[]]> = [
      ...order.map((capability) => [capability, models.filter((model) => capabilitiesFor(model).includes(capability))] as const),
      ...(viewCapability ? [] : [["other", models.filter((model) => capabilitiesFor(model).length === 0)] as const]),
    ];
    return groups.filter(([, listed]) => listed.length > 0);
  }, [models, viewCapability]);
  const shownCount = modelGroups.reduce((sum, [, listed]) => sum + listed.length, 0);
  // Only a model the user picked validates the save; without one the endpoint's listing is the check.
  const effectiveProbeModel = chatModels.some((m) => m.id === probeModel) ? probeModel : "";

  const idDisabled = mode === "edit";

  const submit = useCallback(async (intent: "pending" | "apply") => {
    if (!id.trim()) {
      setFeedback({ kind: "err", text: uiText("settings.page.providerIdIsRequired") });
      return;
    }
    if (!baseUrl.trim()) {
      setFeedback({ kind: "err", text: uiText("settings.page.baseUrlIsRequired") });
      return;
    }
    if (models.length === 0) {
      setFeedback({ kind: "err", text: uiText("settings.page.addOrDiscoverAtLeastOneModel") });
      return;
    }
    setBusy("save");
    setFeedback(
      intent === "apply"
        ? { kind: "ok", text: uiText("settings.page.applyStateValidating") }
        : null,
    );
    try {
      const body: Record<string, unknown> = {
        baseUrl: baseUrl.trim(),
        ...(capability ? { capability } : {}),
        api,
        models,
        mode: intent,
        ...(effectiveProbeModel ? { modelId: effectiveProbeModel } : {}),
      };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      await apiClient.put(
        `/api/custom-providers/${encodeURIComponent(id.trim())}`,
        body,
      );
      setFeedback({
        kind: "ok",
        text: uiText(intent === "pending" ? "settings.page.savedForLater" : "settings.page.saved"),
      });
      onSaved();
    } catch (err) {
      setFeedback({
        kind: "err",
        text: `${uiText("settings.page.applyStateFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(null);
    }
  }, [id, baseUrl, api, apiKey, models, capability, effectiveProbeModel, onSaved]);

  const discover = useCallback(async () => {
    if (!baseUrl.trim()) {
      setFeedback({ kind: "err", text: uiText("settings.page.baseUrlIsRequiredToDiscover") });
      return;
    }
    setBusy("discover");
    setFeedback(null);
    try {
      const body: Record<string, unknown> = {
        baseUrl: baseUrl.trim(),
        ...(capability ? { capability } : {}),
        // The stored key cannot be shown here; the server authenticates discovery with it.
        ...(mode === "edit" ? { id } : {}),
      };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const data = await apiClient.post<{
        models?: CustomProviderModel[];
        error?: string;
      }>("/api/custom-providers/discover", body);
      const all = Array.isArray(data.models) ? data.models : [];
      // Every discovered model is kept for the pages that select it; this page reports its own.
      const found = viewCapability ? all.filter((m) => capabilitiesFor(m).includes(viewCapability)) : all;
      if (found.length === 0) {
        // A server without listing endpoints is not a broken one; its models are typed by hand.
        setFeedback({ kind: "note", text: uiText("settings.page.noModelsReturned") });
      } else {
        // What the endpoint says now replaces what was stored; ids only the user added stay.
        const byId = new Map(all.map((m) => [m.id, m]));
        const known = new Set(models.map((m) => m.id));
        const merged = [...models.map((m) => byId.has(m.id) ? { ...m, ...byId.get(m.id)! } : m), ...all.filter((m) => !known.has(m.id))];
        setModels(merged);
        setFeedback({
          kind: "ok",
          text: uiText("settings.page.foundCountModelsNewcountNew", { count: found.length, newCount: found.filter((m) => !known.has(m.id)).length }),
        });
      }
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }, [baseUrl, apiKey, models, capability, id, mode, viewCapability]);

  const addModel = useCallback(() => {
    const trimmed = newModelId.trim();
    if (!trimmed) return;
    if (models.some((m) => m.id === trimmed)) {
      setNewModelId("");
      return;
    }
    // Typed on a capability page, the model serves that capability whatever its id suggests, unless the id
    // names something no capability page selects (a reranker); that stays unpinned so the reranker can find it.
    const pin = viewCapability && capabilitiesFor({ id: trimmed }).length > 0 ? { capabilities: [viewCapability] } : {};
    setModels([...models, { id: trimmed, ...pin }]);
    setNewModelId("");
  }, [newModelId, models, viewCapability]);

  const removeModel = useCallback(
    (modelId: string) => setModels(models.filter((m) => m.id !== modelId)),
    [models],
  );

  return (
    <div
      className={cn(
        "grid gap-3 px-3 pb-3",
        mode === "edit"
          ? "border-t border-border pt-3"
          : "rounded-[0.55rem] border border-border bg-card pt-3",
      )}
    >
      <div className="grid grid-cols-2 gap-2 max-[480px]:grid-cols-1">
        <div className="grid gap-1">
          <label className="text-[0.78rem] text-muted-foreground">
			{uiText("settings.page.providerId")}
          </label>
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
		  placeholder={uiText("settings.page.eGLocalProvider")}
            disabled={idDisabled}
            className="rounded-[0.5rem] border border-border bg-popover px-3 py-1.5 text-[0.85rem] text-foreground disabled:opacity-60 focus-visible:outline-none focus-visible:border-[var(--input)]"
          />
        </div>
        <div className="grid gap-1">
          <label className="text-[0.78rem] text-muted-foreground">
			{uiText("settings.page.apiStyle")}
          </label>
          <select
            value={api}
            onChange={(e) =>
              setApi(
                e.target.value as "openai-completions" | "openai-responses",
              )
            }
            className={SELECT_CLS}
          >
            <option value="openai-completions">
              openai-completions (chat/completions)
            </option>
            <option value="openai-responses">
              openai-responses (/responses)
            </option>
          </select>
        </div>
      </div>

      <label className="grid gap-1 text-[0.78rem] text-muted-foreground">{uiText("settings.audioGeneration.capability")}
        <select className={SELECT_CLS} value={capability} disabled={Boolean(lockedCapability)} data-testid="custom-provider-form-capability" onChange={event => setCapability(event.target.value as CustomProviderCapability | "")}>
          <option value="">{uiText("settings.audioGeneration.llm")}</option><option value="embedding">{uiText("settings.embedding.title")}</option><option value="audio-recognition">{uiText("settings.speech.connectionCapability")}</option><option value="audio-generation">{uiText("settings.audioGeneration.title")}</option>
        </select>
      </label>
      <div className="grid gap-1">
		<label className="text-[0.78rem] text-muted-foreground">{uiText("settings.page.baseUrl")}</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://provider.example/v1"
          className="rounded-[0.5rem] border border-border bg-popover px-3 py-1.5 text-[0.85rem] font-mono text-foreground focus-visible:outline-none focus-visible:border-[var(--input)]"
        />
      </div>

      <div className="grid gap-1">
        <label className="text-[0.78rem] text-muted-foreground">
		  {uiText("settings.page.apiKeyOptional")}
          {mode === "edit" && initial?.hasApiKey && !apiKey && (
            <span className="ml-2 text-emerald-600 dark:text-emerald-400">
			  {uiText("settings.page.existingKeyKept")} · {initial.apiKeyHint}
            </span>
          )}
        </label>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              mode === "edit" && initial?.hasApiKey
				? uiText("settings.page.leaveBlankToKeepExisting")
				: uiText("settings.page.apiKeyOptional")
            }
            className="rounded-[0.5rem] border border-border bg-popover px-3 py-1.5 text-[0.85rem] font-mono text-foreground focus-visible:outline-none focus-visible:border-[var(--input)]"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className={BTN_PRIMARY}
            aria-label={
              showKey ? uiText("settings.page.hideApiKey") : uiText("settings.page.showApiKey")
            }
            title={showKey ? uiText("settings.page.hide") : uiText("settings.page.show")}
          >
            {showKey ? (
              <EyeOff className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Eye className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        </div>
      </div>

      <div className="grid gap-2 rounded-[0.5rem] border border-border bg-popover/50 p-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-[0.85rem] text-foreground font-medium">
			{uiText("settings.page.modelsCount", { count: shownCount })}
          </span>
          <button
            type="button"
            onClick={discover}
            className={BTN_PRIMARY}
            disabled={busy !== null}
          >
            {busy === "discover" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
            )}
			{uiText("settings.page.discover")}
          </button>
        </div>

        {shownCount === 0 && (
          <div className="text-[0.78rem] text-muted-foreground">
			{uiText("settings.page.noModelsYetDiscoverOrAddOneManuallyBelow")}
          </div>
        )}

        {modelGroups.map(([capability, listed]) => (
          <div key={capability} className="grid gap-1" data-testid={`custom-provider-models-${capability}`}>
            <span className="text-[0.72rem] text-muted-foreground">
              {capability === "other" ? uiText("settings.page.otherModels") : uiText(CAPABILITY_LABEL[capability])}
            </span>
            <ul className="list-none m-0 p-0 grid gap-1">
              {listed.map((m) => (
                <li
                  key={m.id}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-[0.4rem] border border-border bg-card px-2 py-1"
                >
                  <span
                    className="text-[0.78rem] font-mono text-foreground truncate"
                    title={m.id}
                  >
                    {m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id}
                  </span>
                  <span className="text-[0.7rem] text-muted-foreground">
                    {m.supportedVoices?.length ? uiText("settings.page.countVoices", { count: m.supportedVoices.length }) : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeModel(m.id)}
                    className="text-destructive hover:bg-destructive/10 rounded p-1"
                    aria-label={uiText("settings.page.removeId", { id: m.id })}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {chatModels.length > 0 && (
          <label className="grid gap-1 text-[0.78rem] text-muted-foreground">
            {uiText("settings.page.modelUsedForTesting")}
            <select
              className={SELECT_CLS}
              value={effectiveProbeModel}
              onChange={(e) => setProbeModel(e.target.value)}
              data-testid="custom-provider-form-probe-model"
            >
              <option value="">{uiText("settings.page.pickTestModel")}</option>
              {chatModels.map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
            </select>
          </label>
        )}

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <input
            type="text"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addModel();
              }
            }}
            placeholder={uiText("settings.page.addAModelIdManuallyPressEnter")}
            className="rounded-[0.5rem] border border-border bg-card px-3 py-1.5 text-[0.82rem] font-mono text-foreground focus-visible:outline-none focus-visible:border-[var(--input)]"
          />
          <button
            type="button"
            onClick={addModel}
            className={BTN_PRIMARY}
            disabled={!newModelId.trim()}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> {uiText("settings.page.add")}
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={cn(
            "text-[0.78rem]",
            feedback.kind === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : feedback.kind === "note"
                ? "text-muted-foreground"
                : "text-destructive",
          )}
        >
          {feedback.text}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={BTN_PRIMARY}
          disabled={busy !== null}
        >
          {uiText("common.cancel")}
        </button>
        <button
          type="button"
          onClick={() => submit("pending")}
          className={BTN_PRIMARY}
          disabled={busy !== null}
          data-testid="custom-provider-save-pending"
        >
          {uiText("settings.page.saveForLater")}
        </button>
        <button
          type="button"
          onClick={() => submit("apply")}
          className={BTN_PRIMARY}
          disabled={busy !== null}
          data-testid="custom-provider-apply"
        >
          {busy === "save" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : null}
          {uiText("settings.page.saveAndApply")}
        </button>
      </div>
    </div>
  );
}
