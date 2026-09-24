import { useCallback, useEffect, useMemo, useState } from "react";
import { PlusIcon as Plus } from "@/shared/ui/icons";
import type { ConnectionCapability, ConnectionsResponse, ConnectionSummary } from "@shared/connections.js";
import { pinnedCapability, type CustomProviderCapability, type CustomProviderSummary } from "@shared/types.js";
import { apiClient } from "@/shared/lib/api-client";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";
import { type OAuthProviderInfo } from "./OAuthLoginDialog";
import { CloudProviderAddForm, CloudProviderRow } from "./CloudProviderRow";
import { CustomProviderForm, CustomProviderRow, PendingCustomProviderRow } from "./CustomProviderRow";
import { OllamaConnectionForm } from "./OllamaConnectionForm";
import { BTN_PRIMARY } from "./settings-styles";
import type { CloudProvidersResponse } from "./provider-config";

/** The custom-connection pin that lists models for one capability page. */
const PIN: Record<ConnectionCapability, CustomProviderCapability | undefined> = {
  chat: undefined,
  embedding: "embedding",
  tts: "audio-generation",
  stt: "audio-recognition",
};

/**
 * Every connection that serves one capability, with its credential, on the page that uses it.
 * Built-in cloud providers show only where they hold a credential or have one prepared; a
 * connection added here is pinned to this capability so it lists only these models.
 */
export function ConnectionsSection({ capability, onChanged, reloadToken = 0 }: { capability: ConnectionCapability; onChanged?: () => void; reloadToken?: number }) {
  const [cloud, setCloud] = useState<CloudProvidersResponse | null>(null);
  const [custom, setCustom] = useState<{ providers: CustomProviderSummary[]; pending: CustomProviderSummary[] } | null>(null);
  const [summaries, setSummaries] = useState<Map<string, ConnectionSummary>>(new Map());
  const [oauthById, setOauthById] = useState<Map<string, OAuthProviderInfo>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"cloud" | "custom" | "ollama" | null>(null);

  const reload = useCallback(() => {
    void Promise.all([
      apiClient.get<ConnectionsResponse>("/api/connections"),
      apiClient.get<{ providers: CustomProviderSummary[]; pending?: CustomProviderSummary[] }>("/api/custom-providers"),
      apiClient.get<CloudProvidersResponse>("/api/auth"),
    ]).then(([connections, customProviders, cloudProviders]) => {
      setSummaries(new Map(connections.connections.map((item) => [item.id, item])));
      setCustom({ providers: customProviders.providers, pending: customProviders.pending ?? [] });
      setCloud(cloudProviders);
      setError(null);
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [capability]);

  // `reloadToken` lets the page re-read usage after it changes who uses which connection.
  useEffect(() => { reload(); }, [reload, reloadToken]);
  useEffect(() => {
    if (capability !== "chat") return;
    apiClient.get<{ providers: OAuthProviderInfo[] }>("/api/auth/oauth/providers")
      .then((data) => setOauthById(new Map((data?.providers ?? []).map((p) => [p.id, p]))))
      .catch((err) => console.warn("[Settings] oauth providers fetch failed:", err));
  }, [capability]);

  const changed = useCallback(() => { reload(); onChanged?.(); }, [reload, onChanged]);

  const serves = useCallback((id: string) => summaries.get(id)?.capabilities.includes(capability) ?? false, [summaries, capability]);
  const cloudEntries = useMemo(() => (cloud?.providers ?? []).filter((entry) =>
    summaries.get(entry.id)?.kind === "cloud" && serves(entry.id) && (entry.envSet || entry.authEntry.configured || entry.pendingEntry.configured)), [cloud, summaries, serves]);
  const addableCloudIds = useMemo(() => (cloud?.providers ?? []).filter((entry) => !cloudEntries.includes(entry) && summaries.get(entry.id)?.kind !== "custom").map((entry) => entry.id).sort(), [cloud, cloudEntries, summaries]);
  const customEntries = useMemo(() => (custom?.providers ?? []).filter((entry) => serves(entry.id)), [custom, serves]);
  const pendingEntries = useMemo(() => (custom?.pending ?? []).filter((entry) => (pinnedCapability(entry.capability) ?? "chat") === capability), [custom, capability]);
  const loaded = custom !== null && summaries.size > 0;
  const empty = loaded && cloudEntries.length === 0 && customEntries.length === 0 && pendingEntries.length === 0;

  return (
    <div className="grid gap-3" data-testid={`connections-${capability}`}>
      {/* Narrow screens stack: side by side, the add buttons leave the copy a few characters wide. */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="grid gap-1">
          <h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.connections.title")}</h3>
          <p className="m-0 text-[0.85rem] text-muted-foreground">{uiText("settings.connections.hint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {capability === "chat" && addableCloudIds.length > 0 && (
            <button type="button" className={cn(BTN_PRIMARY, adding === "cloud" && "bg-[var(--foreground-5)]")} onClick={() => setAdding((v) => v === "cloud" ? null : "cloud")} data-testid="add-connection-cloud">
              <Plus className="h-3.5 w-3.5" aria-hidden /> {uiText("settings.connections.addCloud")}
            </button>
          )}
          {(capability === "chat" || capability === "embedding") && (
            <button type="button" className={cn(BTN_PRIMARY, adding === "ollama" && "bg-[var(--foreground-5)]")} onClick={() => setAdding((v) => v === "ollama" ? null : "ollama")} data-testid="add-connection-ollama">
              <Plus className="h-3.5 w-3.5" aria-hidden /> {uiText("settings.ollama.addButton")}
            </button>
          )}
          <button type="button" className={cn(BTN_PRIMARY, adding === "custom" && "bg-[var(--foreground-5)]")} onClick={() => setAdding((v) => v === "custom" ? null : "custom")} data-testid={`add-connection-${capability}`}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> {capability === "chat" ? uiText("settings.connections.addCustom") : uiText("settings.connections.addConnection")}
          </button>
        </div>
      </div>

      {adding === "cloud" && (
        <CloudProviderAddForm providerIds={addableCloudIds} oauthById={oauthById} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); changed(); }} />
      )}
      {adding === "ollama" && (
        <OllamaConnectionForm capability={capability} initial={null} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); changed(); }} />
      )}
      {adding === "custom" && (
        <CustomProviderForm mode="create" initial={null} lockedCapability={PIN[capability]} viewCapability={capability} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); changed(); }} />
      )}

      {error && (
        <div className="rounded-[0.55rem] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[0.85rem] text-destructive">{error}</div>
      )}
      {!loaded && !error && <div className="text-[0.85rem] text-muted-foreground">{uiText("common.loading")}</div>}
      {empty && !adding && <div className="text-[0.85rem] text-muted-foreground">{uiText("settings.connections.none")}</div>}

      {loaded && (cloudEntries.length > 0 || customEntries.length > 0 || pendingEntries.length > 0) && (
        <ul className="grid gap-2 list-none m-0 p-0">
          {cloudEntries.map((entry) => {
            const summary = summaries.get(entry.id);
            return (
              <CloudProviderRow key={entry.id} id={entry.id} entry={entry} oauthInfo={oauthById.get(entry.id)} summary={summary} capability={capability} onChanged={changed}
                provider={summary ? { id: entry.id, models: summary.models[capability].map((model) => ({ id: model.id, name: model.name ?? model.id })) } : undefined} />
            );
          })}
          {pendingEntries.map((entry) => <PendingCustomProviderRow key={`pending-${entry.id}`} provider={entry} onChanged={changed} />)}
          {customEntries.map((entry) => <CustomProviderRow key={entry.id} provider={entry} summary={summaries.get(entry.id)} capability={capability} onChanged={changed} />)}
        </ul>
      )}
    </div>
  );
}
