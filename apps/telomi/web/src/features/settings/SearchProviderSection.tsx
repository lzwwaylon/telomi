import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, LogIn, RefreshCw, Trash2 } from "lucide-react";
import { sourceUnavailable, type SourceAuth, type SourceStatus, type SourceSummary, type SourcesResponse } from "@shared/sources.js";
import { apiClient } from "@/shared/lib/api-client";
import { formatRelativeTime } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";
import { BTN_PRIMARY as BTN_BASE, BTN_DANGER as BTN_DANGER_BASE } from "./settings-styles";
import { BrowserLoginDialog } from "./BrowserLoginDialog";

/** Every control in a source row shares one height, so text buttons, icon buttons and the switch line up. */
const BTN_PRIMARY = `${BTN_BASE} h-8`;
const BTN_DANGER = `${BTN_DANGER_BASE} h-8`;
const BTN_ICON = `${BTN_PRIMARY} w-8 px-0`;
import type { SearchCredentialFieldStatus, SearchCredentialProviderStatus } from "./provider-config";

export type SourceEntry = SourceSummary<SearchCredentialProviderStatus>;
type SourcesPayload = SourcesResponse<SearchCredentialProviderStatus>;

const GROUPS: SourceAuth[] = ["browser_session", "api_key", "none"];

/**
 * Every external source Telomi integrates, with the state the Runtime last verified it in.
 *
 * The panel states what the Runtime reports: whether the source works, needs a login in the
 * browser, or failed, and for API-key sources which credential is in use. It never computes that
 * itself and never receives a secret.
 */
export function SearchProviderSection() {
  const [data, setData] = useState<SourcesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    apiClient
      .get<SourcesPayload>("/api/sources")
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const verifyAll = useCallback(async () => {
    setVerifying(true);
    try {
      setData(await apiClient.post<SourcesPayload>("/api/sources/verify"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }, []);

  return (
    <div className="grid gap-4" data-testid="search-providers">
      {loading && !data && (
        <div className="text-[0.85rem] text-muted-foreground">{uiText("common.loading")}</div>
      )}

      {error && (
        <div className="rounded-[0.55rem] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[0.85rem] text-destructive">
          {uiText("settings.page.apiSourcesFailed")} {error}
        </div>
      )}

      {data && (
        <>
          <SourcesSummary sources={data.sources} verifying={verifying || data.verifying} onVerifyAll={verifyAll} />
          {GROUPS.map((auth) => {
            const sources = data.sources.filter((source) => source.auth === auth);
            if (sources.length === 0) return null;
            return (
              <div key={auth} className="grid gap-2" data-testid={`source-group-${auth}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="grid gap-0.5">
                    <h3 className="m-0 text-[0.95rem] font-medium">{uiText(`settings.source.group.${auth}` as MessageId)}</h3>
                    <p className="m-0 text-[0.8rem] text-muted-foreground">
                      {uiText(`settings.source.group.${auth}Description` as MessageId)}
                    </p>
                  </div>
                  {auth === "browser_session" && (
                    <button
                      type="button"
                      className={`${BTN_PRIMARY} shrink-0`}
                      onClick={() => setLoginOpen(true)}
                      title={uiText("settings.source.loginBrowserHint")}
                      data-testid="sources-browser-login"
                    >
                      <LogIn className="h-3.5 w-3.5" aria-hidden />
                      {uiText("settings.source.loginBrowser")}
                    </button>
                  )}
                </div>
                <SourceList sources={sources.filter((source) => !isGeneralWeb(source))} onChanged={reload} onVerified={setData} />
                {auth === "api_key" && (
                  <GeneralWebGroup
                    sources={sources.filter(isGeneralWeb)}
                    preferred={data.generalWebBackend}
                    onChanged={reload}
                    onVerified={setData}
                  />
                )}
              </div>
            );
          })}
          <BrowserLoginDialog
            open={loginOpen}
            sources={data.sources.filter((source) => source.auth === "browser_session").map((source) => ({
              id: source.id,
              name: uiText(`settings.source.name.${source.id}` as MessageId),
            }))}
            onClose={() => setLoginOpen(false)}
            onVerified={setData}
          />
        </>
      )}
    </div>
  );
}

/** The general web backends serve one `general_web` Provider together, so the page lists them as one. */
function isGeneralWeb(source: SourceEntry): boolean {
  return source.sourceIds.some((id) => id.startsWith("general_web_"));
}

function SourceList({ sources, onChanged, onVerified }: {
  sources: SourceEntry[];
  onChanged: () => void;
  onVerified: (next: SourcesPayload) => void;
}) {
  if (sources.length === 0) return null;
  return (
    <ul className="grid gap-2 list-none m-0 p-0">
      {sources.map((source) => (
        <SourceRow key={source.id} source={source} onChanged={onChanged} onVerified={onVerified} />
      ))}
    </ul>
  );
}

function GeneralWebGroup({ sources, preferred, onChanged, onVerified }: {
  sources: SourceEntry[];
  preferred: string;
  onChanged: () => void;
  onVerified: (next: SourcesPayload) => void;
}) {
  if (sources.length === 0) return null;
  const name = uiText(`settings.source.name.${preferred}` as MessageId);
  return (
    <div className="grid gap-2 border-l-2 border-border pl-3" data-testid="source-group-general-web">
      <div className="grid gap-0.5">
        <h4 className="m-0 text-[0.875rem] font-medium">{uiText("settings.source.generalWeb")}</h4>
        <p className="m-0 text-[0.8rem] text-muted-foreground">{uiText("settings.source.generalWebDescription", { name })}</p>
      </div>
      <SourceList sources={sources} onChanged={onChanged} onVerified={onVerified} />
    </div>
  );
}

function SourcesSummary({
  sources,
  verifying,
  onVerifyAll,
}: {
  sources: SourceEntry[];
  verifying: boolean;
  onVerifyAll: () => void;
}) {
  const enabled = sources.filter((source) => source.enabled);
  const ok = enabled.filter((source) => source.status?.state === "ok").length;
  const attention = enabled.filter((source) => sourceUnavailable(source.status)).length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-testid="sources-summary">
      <span className="text-[0.85rem] text-muted-foreground">
        {uiText("settings.source.summary", { total: enabled.length, ok })}
        {attention > 0 && ` · ${uiText("settings.source.summaryAttention", { count: attention })}`}
      </span>
      <button
        type="button"
        className={BTN_PRIMARY}
        onClick={onVerifyAll}
        disabled={verifying}
        data-testid="sources-verify-all"
      >
        {verifying ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        )}
        {uiText(verifying ? "settings.source.verifying" : "settings.source.recheckAll")}
      </button>
    </div>
  );
}

const DOT_CLASS: Record<SourceStatus["state"] | "unchecked", string> = {
  ok: "bg-emerald-500",
  needs_login: "bg-amber-500",
  error: "bg-destructive",
  unconfigured: "bg-muted-foreground/40",
  unchecked: "bg-muted-foreground/40",
};

/** The last verification, or nothing while the source is switched off. */

function StatusDot({ status }: { status: SourceStatus | null }) {
  const state = status?.state ?? "unchecked";
  return (
    <span
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", DOT_CLASS[state])}
      data-testid="source-status-dot"
      data-state={state}
      aria-hidden
    />
  );
}

function statusLine(status: SourceStatus | null): string {
  if (!status) return uiText("settings.source.state.unchecked");
  const when = formatRelativeTime(status.checkedAt);
  return `${uiText(`settings.source.state.${status.state}` as MessageId)} · ${uiText("settings.source.checkedAt", { when })}`;
}

/** The Runtime's own explanation in the user's language, with Provider detail after it. */
function reasonLine(status: SourceStatus): string {
  if (!status.code) return status.reason ?? "";
  const explained = uiText(`settings.source.reason.${status.code}` as MessageId);
  return status.reason && status.code !== "no_login" ? `${explained} · ${status.reason}` : explained;
}

function fieldSummary(field: SearchCredentialFieldStatus): string {
  if (!field.configured) return uiText("settings.page.notConfigured");
  const hint = field.keyHint ? ` · ${field.keyHint}` : "";
  if (field.provenance === "browser") return uiText("settings.page.searchCredentialFromBrowser");
  return field.provenance === "imported"
    ? `${uiText("settings.page.searchCredentialImported")}${hint}`
    : `${uiText("settings.page.keyConfigured")}${hint}`;
}

export function SourceRow({
  source,
  onChanged,
  onVerified,
}: {
  source: SourceEntry;
  onChanged: () => void;
  onVerified?: (next: SourcesPayload) => void;
}) {
  const [verifying, setVerifying] = useState(false);
  const [busy, setBusy] = useState<"toggle" | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const status = source.status;
  const name = uiText(`settings.source.name.${source.id}` as MessageId);
  const tone =
    !source.enabled ? "text-muted-foreground"
      : status?.state === "needs_login" ? "text-amber-600 dark:text-amber-400"
        : status?.state === "error" ? "text-destructive"
          : "text-muted-foreground";

  const apply = useCallback(async (kind: "toggle", request: () => Promise<SourcesPayload>) => {
    setBusy(kind);
    setVerifyError(null);
    try {
      const next = await request();
      if (onVerified) onVerified(next);
      else onChanged();
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [onChanged, onVerified]);

  const verify = useCallback(async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      const next = await apiClient.post<SourcesPayload>(`/api/sources/${encodeURIComponent(source.id)}/verify`);
      if (onVerified) onVerified(next);
      else onChanged();
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }, [onChanged, onVerified, source.id]);

  return (
    <li
      className={cn("rounded-[0.65rem] border border-border bg-card/60", !source.enabled && "opacity-60")}
      data-testid={`source-${source.id}`}
      data-state={source.enabled ? status?.state ?? "unchecked" : "disabled"}
      data-enabled={source.enabled ? "true" : "false"}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <div className="pt-[0.45rem]">
          <StatusDot status={source.enabled ? status : null} />
        </div>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.9rem] font-medium">{name}</span>
            <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.72rem] text-muted-foreground">
              {source.sourceIds.join(", ")}
            </span>
          </div>
          <div className={cn("text-[0.8rem]", tone)} data-testid={`source-status-${source.id}`}>
            {source.enabled ? statusLine(status) : uiText("settings.source.state.disabled")}
          </div>
          {source.enabled && status && (status.code || status.reason) && (
            <div className={cn("text-[0.78rem]", tone)} data-testid={`source-reason-${source.id}`}>
              {reasonLine(status)}
            </div>
          )}
          {verifyError && (
            <div className="text-[0.78rem] text-destructive">{verifyError}</div>
          )}
        </div>
        <div className="flex h-8 items-center gap-1.5">
          {source.enabled && source.auth !== "none" && (
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={verify}
              disabled={verifying || busy !== null}
              title={uiText("settings.source.recheck")}
              aria-label={uiText("settings.source.recheck")}
              data-testid={`source-verify-${source.id}`}
            >
              {verifying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          )}
          <input
            type="checkbox"
            role="switch"
            checked={source.enabled}
            disabled={busy !== null}
            aria-checked={source.enabled}
            aria-label={uiText(source.enabled ? "settings.source.switchOff" : "settings.source.switchOn")}
            title={uiText(source.enabled ? "settings.source.switchOff" : "settings.source.switchOn")}
            onChange={(event) => {
              const enabled = event.target.checked;
              void apply("toggle", () =>
                apiClient.put<SourcesPayload>(`/api/sources/${encodeURIComponent(source.id)}/enabled`, { enabled }));
            }}
            data-testid={`source-enabled-${source.id}`}
            className="relative ml-1 h-[1.125rem] w-8 shrink-0 cursor-pointer appearance-none rounded-full bg-muted-foreground/30 transition-colors before:absolute before:left-0.5 before:top-0.5 before:h-3.5 before:w-3.5 before:rounded-full before:bg-background before:shadow-sm before:transition-transform checked:bg-foreground checked:before:translate-x-3.5 disabled:cursor-default"
          />
        </div>
      </div>
      {source.credential && source.auth === "browser_session" && (
        <BrowserSessionCredentialNote provider={source.credential} />
      )}
      {source.credential && source.auth !== "browser_session" && (
        <SearchCredentialControls provider={source.credential} onChanged={onChanged} />
      )}
    </li>
  );
}

/**
 * A browser-backed source is not configured here: the login lives in the browser. The only thing
 * worth stating is an explicit environment override, because then the browser login is not what
 * the source authenticates with.
 */
function BrowserSessionCredentialNote({ provider }: { provider: SearchCredentialProviderStatus }) {
  const overrides = provider.fields.filter(
    (field) => field.configured && field.provenance !== "browser" && !field.optional,
  );
  const files = provider.fields.filter((field) => field.locationEnv);
  if (overrides.length === 0 && files.length === 0) return null;
  return (
    <div className="border-t border-border px-3 py-2 text-[0.78rem] text-muted-foreground" data-testid={`source-override-${provider.id}`}>
      {overrides.map((field) => (
        <div key={field.id}>{uiText("settings.source.envOverride", { name: field.env })}</div>
      ))}
      {files.map((field) => (
        <div key={field.id}>
          {field.locationError
            ? uiText("settings.page.searchCredentialFileUnreadable", { reason: field.locationError })
            : uiText("settings.page.searchCredentialReadFromFile", { name: field.locationEnv ?? "" })}
        </div>
      ))}
    </div>
  );
}

function SearchCredentialControls({
  provider,
  onChanged,
}: {
  provider: SearchCredentialProviderStatus;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const configured = provider.fields.some((field) => !field.optional && field.configured);
  const staged = provider.fields.some((field) => field.pendingConfigured);
  const legacyEnv = [...new Set(provider.fields.flatMap((field) => field.legacyEnvSet))];

  const submit = useCallback(
    async (mode: "pending" | "apply") => {
      const values = Object.fromEntries(
        Object.entries(drafts).flatMap(([id, value]) => (value.trim() ? [[id, value.trim()]] : [])),
      );
      // Applying with nothing typed activates a credential already saved for later; preparing one
      // needs a value to prepare.
      if (mode === "pending" && Object.keys(values).length === 0) {
        setFeedback({ kind: "err", text: uiText("settings.page.keyIsRequired") });
        return;
      }
      setBusy("save");
      setFeedback(null);
      try {
        await apiClient.put(`/api/search-credentials/${encodeURIComponent(provider.id)}`, {
          mode,
          values,
        });
        setDrafts({});
        setEditing(false);
        setShow(false);
        setFeedback({
          kind: "ok",
          text: uiText(mode === "pending" ? "settings.page.savedForLater" : "settings.page.saved"),
        });
        onChanged();
      } catch (err) {
        setFeedback({ kind: "err", text: err instanceof Error ? err.message : String(err) });
        // Activation failed, so the credential in use is unchanged; show what still runs.
        onChanged();
      } finally {
        setBusy(null);
      }
    },
    [drafts, onChanged, provider.id],
  );

  const clear = useCallback(async () => {
    setBusy("delete");
    setFeedback(null);
    try {
      await apiClient.delete(`/api/search-credentials/${encodeURIComponent(provider.id)}`);
      setEditing(false);
      setDrafts({});
      setFeedback({ kind: "ok", text: uiText("settings.page.cleared") });
      onChanged();
    } catch (err) {
      setFeedback({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [onChanged, provider.id]);

  return (
    <div className="border-t border-border" data-testid={`search-provider-${provider.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
        <div className="grid min-w-0 gap-1">
          <div className="text-[0.8rem] text-muted-foreground">
            {provider.fields
              .filter((field) => field.configured || !field.optional)
              .map(fieldSummary)
              .join(" · ")}
          </div>
          <div className="flex flex-wrap gap-1">
            {provider.fields.map((field) => (
              <span
                key={field.id}
                className={cn(
                  "rounded-md border px-1.5 py-0.5 font-mono text-[0.72rem]",
                  field.provenance === "imported"
                    ? "border-emerald-600/40 text-emerald-700 dark:text-emerald-400"
                    : "border-border text-muted-foreground",
                )}
              >
                {field.env}
                {field.optional ? ` · ${uiText("settings.page.credentialFieldOptional")}` : ""}
              </span>
            ))}
          </div>
          {staged && (
            <div
              className="flex flex-wrap items-center gap-2 text-[0.78rem] text-amber-700 dark:text-amber-400"
              data-testid={`search-provider-pending-${provider.id}`}
            >
              <span>{uiText("settings.page.credentialSavedForLaterNotActive")}</span>
              <button
                type="button"
                className={BTN_PRIMARY}
                onClick={() => submit("apply")}
                disabled={busy !== null}
                data-testid={`search-provider-apply-pending-${provider.id}`}
              >
                {uiText("settings.page.activate")}
              </button>
            </div>
          )}
          {provider.status === "pending" && (
            <div
              className="text-[0.78rem] text-destructive"
              data-testid={`search-provider-not-adopted-${provider.id}`}
            >
              {uiText("settings.page.searchCredentialSourceServicePending", {
                reason: provider.pendingReason ?? "",
              })}
            </div>
          )}
          {legacyEnv.length > 0 && (
            <div className="text-[0.78rem] text-muted-foreground">
              {uiText("settings.page.searchCredentialLegacyEnvIgnored", { names: legacyEnv.join(", ") })}
            </div>
          )}
          {provider.fields.map((field) =>
            field.locationError ? (
              <div
                key={`${field.id}-location-error`}
                className="text-[0.78rem] text-destructive"
                data-testid={`search-provider-location-error-${field.id}`}
              >
                {uiText("settings.page.searchCredentialFileUnreadable", { reason: field.locationError })}
              </div>
            ) : field.locationEnv ? (
              <div key={`${field.id}-location`} className="text-[0.78rem] text-muted-foreground">
                {uiText("settings.page.searchCredentialReadFromFile", { name: field.locationEnv })}
              </div>
            ) : null,
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:justify-end">
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => {
              setEditing((value) => !value);
              setShow(false);
              setDrafts({});
            }}
            disabled={busy !== null}
            data-testid={`search-provider-edit-${provider.id}`}
          >
            {editing
              ? uiText("common.cancel")
              : configured
                ? uiText("settings.page.replace")
                : uiText("settings.page.setKey")}
          </button>
          {(configured || staged) && (
            <button
              type="button"
              className={`${BTN_DANGER} w-8 px-0`}
              onClick={clear}
              disabled={busy !== null}
              aria-label={uiText("settings.page.clearTheIdApiKey", { id: provider.id })}
              title={uiText("settings.page.clearApiKey")}
              data-testid={`search-provider-delete-${provider.id}`}
            >
              {busy === "delete" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="grid gap-2 px-3 pb-3 border-t border-border pt-3">
          {provider.fields.map((field) => (
            <div key={field.id} className="grid grid-cols-[1fr_auto] gap-2">
              <input
                type={show ? "text" : "password"}
                value={drafts[field.id] ?? ""}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [field.id]: event.target.value }))
                }
                placeholder={`${field.env}${field.optional ? ` (${uiText("settings.page.credentialFieldOptional")})` : ""}`}
                aria-label={field.env}
                className="rounded-[0.5rem] border border-border bg-popover px-3 py-1.5 text-[0.85rem] font-mono text-foreground focus-visible:outline-none focus-visible:border-[var(--input)]"
                data-testid={`search-provider-input-${field.id}`}
                autoFocus={field === provider.fields[0]}
              />
              <button
                type="button"
                onClick={() => setShow((value) => !value)}
                className={BTN_ICON}
                aria-label={show ? uiText("settings.page.hideApiKey") : uiText("settings.page.showApiKey")}
              >
                {show ? (
                  <EyeOff className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Eye className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => submit("pending")}
              className={BTN_PRIMARY}
              disabled={busy !== null}
              data-testid={`search-provider-save-pending-${provider.id}`}
            >
              {uiText("settings.page.saveForLater")}
            </button>
            <button
              type="button"
              onClick={() => submit("apply")}
              className={BTN_PRIMARY}
              disabled={busy !== null}
              data-testid={`search-provider-apply-${provider.id}`}
            >
              {busy === "save" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              {uiText("settings.page.saveAndApply")}
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div
          className={cn(
            "px-3 pb-2 text-[0.78rem]",
            feedback.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
          )}
          data-testid={`search-provider-feedback-${provider.id}`}
        >
          {feedback.text}
        </div>
      )}
    </div>
  );
}
