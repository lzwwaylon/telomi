import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCcw } from "lucide-react";
import { DownloadIcon as Download } from "@/shared/ui/icons";
import type { ConnectionCapability } from "@shared/connections.js";
import type { CustomProviderCapability, CustomProviderSummary } from "@shared/types.js";
import { OLLAMA_DEFAULT_BASE_URL } from "@shared/ollama.js";
import { apiClient } from "@/shared/lib/api-client";
import { formatBytes } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";
import { CAPABILITY_LABEL } from "./ConnectionBadges";
import { BTN_PRIMARY } from "./settings-styles";

interface OllamaModel { id: string; capabilities: ConnectionCapability[]; size: number; family?: string }
interface PullJob { job: string; status: "pulling" | "done" | "failed"; detail: string; completed: number; total: number; error?: string }
interface LibraryModel { name: string; description: string; sizes: string[] }

const PIN: Partial<Record<ConnectionCapability, CustomProviderCapability>> = { embedding: "embedding" };
const INPUT = "rounded-[0.5rem] border border-border bg-popover px-3 py-1.5 text-[0.85rem] font-mono text-foreground focus-visible:outline-none focus-visible:border-[var(--input)] disabled:opacity-60";

/**
 * A local Ollama as a model source for one capability. Detection lists what is installed, by
 * purpose, through Ollama's own API; a model that is not installed yet is pulled from here. Saving
 * writes an ordinary custom connection pinned to the capability, so nothing downstream is special.
 */
export function OllamaConnectionForm({ capability, initial, onCancel, onSaved }: {
  capability: ConnectionCapability;
  initial: CustomProviderSummary | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL);
  const [models, setModels] = useState<OllamaModel[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial?.models.map((m) => m.id) ?? []));
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pullName, setPullName] = useState("");
  const [pull, setPull] = useState<PullJob | null>(null);
  const [saving, setSaving] = useState(false);
  const [library, setLibrary] = useState<LibraryModel[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const capabilityLabel = uiText(CAPABILITY_LABEL[capability]);

  // What ollama.com offers for this capability; the download field picks from it or takes a typed name.
  useEffect(() => {
    let active = true;
    apiClient.get<{ models: LibraryModel[] }>(`/api/ollama/library?capability=${capability}`)
      .then((data) => { if (active) setLibrary(data.models); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [capability]);

  const detect = useCallback(async (url: string) => {
    setDetecting(true);
    setError(null);
    try {
      const data = await apiClient.post<{ models: OllamaModel[] }>("/api/ollama/models", { baseUrl: url });
      setModels(data.models);
    } catch (err) {
      setModels(null);
      setError(uiText("settings.ollama.unreachable", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setDetecting(false);
    }
  }, []);
  // Detect once for the initial address; later detections are explicit.
  useEffect(() => { void detect(initial?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL); }, [detect, initial?.baseUrl]);

  // A pull is a job on the server; the page only watches it, so leaving and coming back resumes.
  useEffect(() => {
    if (pull?.status !== "pulling") return;
    const timer = window.setInterval(() => {
      apiClient.get<PullJob>(`/api/ollama/pull?job=${encodeURIComponent(pull.job)}`)
        .then((next) => {
          setPull(next);
          if (next.status === "done") {
            setSelected((current) => new Set([...current, pullName.trim().includes(":") ? pullName.trim() : `${pullName.trim()}:latest`]));
            void detect(baseUrl);
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pull, baseUrl, detect, pullName]);

  const startPull = async () => {
    const model = pullName.trim();
    if (!model) return;
    setError(null);
    try {
      setPull(await apiClient.post<PullJob>("/api/ollama/pull", { baseUrl, model }));
    } catch (err) {
      setError(uiText("settings.ollama.pullFailed", { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const offered = (models ?? []).filter((model) => model.capabilities.includes(capability));
  const chosen = offered.filter((model) => selected.has(model.id));
  const save = async () => {
    if (chosen.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await apiClient.put(`/api/custom-providers/${encodeURIComponent(initial?.id ?? "ollama")}`, {
        baseUrl,
        api: "openai-completions",
        ...(PIN[capability] ? { capability: PIN[capability] } : {}),
        models: chosen.map((model) => ({ id: model.id, capabilities: [capability] })),
        // Only the ticked models; the daily sync must not add the other installed ones.
        userSelectedModels: true,
        mode: "apply",
        ...(capability === "chat" ? { modelId: chosen[0]!.id } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const percent = pull && pull.total > 0 ? Math.round((pull.completed / pull.total) * 100) : 0;
  const installedNames = new Set((models ?? []).map((model) => model.id.split(":")[0]));
  const typedName = pullName.trim().toLowerCase().split(":")[0] ?? "";
  const matches = library.filter((model) => !typedName || model.name.includes(typedName));
  const choose = (name: string) => { setPullName(name); setPickerOpen(false); };

  return (
    <div className="grid gap-3 rounded-[0.55rem] border border-border bg-card px-3 pb-3 pt-3" data-testid="ollama-connection-form">
      <div className="grid gap-1">
        <div className="text-[0.9rem] font-medium text-foreground">{uiText("settings.ollama.title")}</div>
        <p className="m-0 text-[0.8rem] text-muted-foreground">{uiText("settings.ollama.hint", { capability: capabilityLabel })}</p>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
        <label className="grid gap-1 text-[0.78rem] text-muted-foreground">{uiText("settings.ollama.baseUrl")}
          <input className={INPUT} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={detecting || saving} data-testid="ollama-base-url" />
        </label>
        <button type="button" className={BTN_PRIMARY} onClick={() => void detect(baseUrl)} disabled={detecting || saving} data-testid="ollama-detect">
          {detecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
          {uiText(detecting ? "settings.ollama.detecting" : "settings.ollama.detect")}
        </button>
      </div>

      {models && (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[0.78rem] text-muted-foreground">
            <span>{uiText("settings.ollama.installed", { capability: capabilityLabel })}</span>
            {offered.length > 0 && chosen.length === 0 && <span className="text-[var(--warm)]" data-testid="ollama-pick-one">{uiText("settings.ollama.pickOneHint")}</span>}
          </div>
          {offered.length === 0 ? (
            <div className="text-[0.82rem] text-muted-foreground">{uiText("settings.ollama.noModels", { capability: capabilityLabel })}</div>
          ) : (
            <ul className="m-0 grid list-none gap-1 p-0" data-testid="ollama-models">
              {offered.map((model) => (
                <li key={model.id}>
                  <label className={cn("flex items-center gap-3 rounded-[0.4rem] border border-border px-2 py-1.5 text-[0.82rem] cursor-pointer hover:bg-[var(--foreground-5)]", selected.has(model.id) && "bg-[var(--foreground-3)]")}>
                    <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={selected.has(model.id)} disabled={saving}
                      onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(model.id); else next.delete(model.id); return next; })} />
                    <span className="font-mono text-foreground">{model.id}</span>
                    <span className="ml-auto text-[0.74rem] text-muted-foreground">{model.family ? `${model.family} · ` : ""}{formatBytes(model.size)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-1.5">
        <label className="text-[0.78rem] text-muted-foreground" htmlFor="ollama-pull-name">{uiText("settings.ollama.pullLabel")}</label>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div className="relative min-w-0">
            <input id="ollama-pull-name" className={`${INPUT} w-full`} value={pullName} placeholder={uiText("settings.ollama.pullPlaceholder")} disabled={pull?.status === "pulling" || saving} autoComplete="off"
              onFocus={() => setPickerOpen(true)} onClick={() => setPickerOpen(true)} onBlur={() => setPickerOpen(false)} onChange={(event) => { setPullName(event.target.value); setPickerOpen(true); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setPickerOpen(false); void startPull(); } if (event.key === "Escape") setPickerOpen(false); }} data-testid="ollama-pull-name" />
            {/* The library list sits right under the field in normal flow, so it follows the page wherever it scrolls. */}
            {pickerOpen && matches.length > 0 && (
              <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-[300px] overflow-y-auto rounded-[0.5rem] border border-border bg-popover p-1 shadow-md" data-testid="ollama-library"
                onMouseDown={(event) => event.preventDefault()}>
                {matches.map((model) => (
                  <div key={model.name} className="grid gap-1 rounded-[0.45rem] px-2.5 py-2 hover:bg-[var(--foreground-3)]">
                    <button type="button" className="grid min-w-0 gap-0.5 text-left" onClick={() => choose(model.name)} data-testid={`ollama-library-${model.name}`}>
                      <span className="flex items-center gap-2 text-[0.84rem] text-foreground"><span className="font-mono">{model.name}</span>
                        {installedNames.has(model.name) && <span className="rounded border border-emerald-600/30 px-1.5 py-0.5 text-[0.68rem] text-emerald-600 dark:text-emerald-400">{uiText("settings.ollama.installedTag")}</span>}
                      </span>
                      {model.description && <span className="block truncate text-[0.74rem] text-muted-foreground">{model.description}</span>}
                    </button>
                    {model.sizes.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {model.sizes.map((size) => (
                          <button key={size} type="button" className="rounded border border-border px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground hover:border-[var(--input)] hover:text-foreground" onClick={() => choose(`${model.name}:${size}`)}>{size}</button>
                        ))}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button type="button" className={BTN_PRIMARY} onClick={() => void startPull()} disabled={!pullName.trim() || pull?.status === "pulling" || saving} data-testid="ollama-pull">
            {pull?.status === "pulling" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
            {uiText("settings.ollama.pull")}
          </button>
        </div>
        {pull?.status === "pulling" && (
          <div className="grid gap-1" data-testid="ollama-pull-progress">
            <div className="h-1.5 overflow-hidden rounded bg-[var(--foreground-10)]"><div className="h-full bg-[var(--warm)] transition-[width]" style={{ width: `${percent}%` }} /></div>
            <span className="text-[0.76rem] text-muted-foreground">{uiText("settings.ollama.pulling", { detail: pull.detail, percent })}</span>
          </div>
        )}
        {pull?.status === "done" && <span className="text-[0.78rem] text-[var(--success-text)]">{uiText("settings.ollama.pulled", { model: pullName })}</span>}
        {pull?.status === "failed" && <span className="text-[0.78rem] text-destructive">{uiText("settings.ollama.pullFailed", { error: pull.error ?? "" })}</span>}
      </div>

      {error && <div className="text-[0.78rem] text-destructive">{error}</div>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={onCancel} disabled={saving}>{uiText("common.cancel")}</button>
        <button type="button" className={BTN_PRIMARY} onClick={() => void save()} disabled={saving || !models || chosen.length === 0} title={models && chosen.length === 0 ? uiText("settings.ollama.pickOneHint") : undefined} data-testid="ollama-save">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {uiText("settings.ollama.save")}
        </button>
      </div>
    </div>
  );
}
