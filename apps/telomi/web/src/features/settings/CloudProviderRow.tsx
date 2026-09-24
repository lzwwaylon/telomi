import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2, LogIn, Trash2 } from "lucide-react";
import { apiClient } from "@/shared/lib/api-client";
import { cn } from "@/shared/lib/utils";
import { ProviderAccountsInline } from "@/features/settings/ProviderAccountsInline";
import {
  OAuthLoginDialog,
  type OAuthDialogMode,
  type OAuthProviderInfo,
} from "@/features/settings/OAuthLoginDialog";
import { uiText } from "@/app/ui-text";
import type { ConnectionCapability, ConnectionSummary } from "@shared/connections.js";
import { ConnectionBadges } from "./ConnectionBadges";
import { BTN_PRIMARY, BTN_DANGER } from "./settings-styles";
import { type ProviderInfo, type CloudProviderEntry } from "./provider-config";
import { connectionTestFailureText, connectionTestFeedback } from "./use-test-model";


export function CloudProviderAddForm({
  providerIds,
  oauthById,
  onCancel,
  onSaved,
}: {
  providerIds: string[];
  oauthById: Map<string, OAuthProviderInfo>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [providerId, setProviderId] = useState<string>(
    () => providerIds[0] ?? "",
  );
  const [keyDraft, setKeyDraft] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthMode, setOauthMode] = useState<OAuthDialogMode | null>(null);

  useEffect(() => {
    if (!providerIds.includes(providerId)) {
      setProviderId(providerIds[0] ?? "");
    }
  }, [providerIds, providerId]);

  const oauthInfo = oauthById.get(providerId);

  const save = useCallback(async () => {
    const trimmed = keyDraft.trim();
    if (!providerId) {
      setError(uiText("settings.page.pickAProvider"));
      return;
    }
    if (!trimmed) {
      setError(uiText("settings.page.keyIsRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiClient.put(`/api/auth/${encodeURIComponent(providerId)}`, {
        key: trimmed,
        mode: "pending",
      });
      setKeyDraft("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [providerId, keyDraft, onSaved]);

  if (providerIds.length === 0) return null;

  return (
    <div
      className="grid gap-2 rounded-[0.55rem] border border-border bg-card px-3 py-3"
      data-testid="cloud-provider-add-form"
    >
      <div className="grid gap-2 sm:grid-cols-[160px_1fr_auto] items-center">
        <select
          className="h-8 rounded border border-border bg-card px-2 text-[0.85rem] text-foreground"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          disabled={busy}
          data-testid="cloud-provider-add-id"
        >
          {providerIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <input
            type={show ? "text" : "password"}
            className="h-8 flex-1 rounded border border-border bg-card px-2 text-[0.85rem] text-foreground"
            placeholder={uiText("settings.page.apiKey")}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            disabled={busy}
            data-testid="cloud-provider-add-key"
            autoFocus
          />
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded border border-border bg-card text-foreground hover:bg-[var(--foreground-5)]"
            onClick={() => setShow((v) => !v)}
            disabled={busy}
            aria-label={
              show ? uiText("settings.page.hideApiKey") : uiText("settings.page.showApiKey")
            }
            title={show ? uiText("settings.page.hide") : uiText("settings.page.show")}
          >
            {show ? (
              <EyeOff className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Eye className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={save}
            disabled={busy}
            data-testid="cloud-provider-add-save"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            {uiText("common.save")}
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={onCancel}
            disabled={busy}
          >
            {uiText("common.cancel")}
          </button>
        </div>
      </div>
      {oauthInfo && (
        <div className="flex items-center gap-2 pt-1 border-t border-border mt-1 -mx-3 px-3 pt-3">
          <span className="text-[0.78rem] text-muted-foreground">
			{uiText("settings.page.orSignInWith")}{" "}
            <span className="text-foreground">{oauthInfo.name}</span>:
          </span>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => setOauthMode("browser")}
            disabled={busy}
            data-testid={`cloud-provider-add-oauth-${providerId}`}
          >
			<LogIn className="h-3.5 w-3.5" aria-hidden /> {uiText("settings.page.oauthSignIn")}
          </button>
          {oauthInfo.supportsDeviceCode && (
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => setOauthMode("device")}
              disabled={busy}
              title={uiText("settings.page.signInWithADeviceCodeWithoutALocal")}
              data-testid={`cloud-provider-add-oauth-device-${providerId}`}
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden /> {uiText("settings.page.deviceCode")}
            </button>
          )}
        </div>
      )}
      {error && <div className="text-[0.78rem] text-destructive">{error}</div>}
      {oauthInfo && (
        <OAuthLoginDialog
          open={oauthMode !== null}
          providerId={providerId}
          providerName={oauthInfo.name}
          mode={oauthMode ?? "browser"}
          onClose={() => setOauthMode(null)}
          onSuccess={() => {
            setOauthMode(null);
            onSaved();
          }}
        />
      )}
    </div>
  );
}

export function CloudProviderRow({
  id,
  entry,
  provider,
  oauthInfo,
  summary,
  capability = "chat",
  onChanged,
}: {
  id: string;
  entry: CloudProviderEntry | undefined;
  /** The models offered for the probe; the caller lists those serving `capability`. */
  provider: ProviderInfo | undefined;
  oauthInfo: OAuthProviderInfo | undefined;
  summary?: ConnectionSummary;
  /** The page's capability; the probe runs through it. */
  capability?: ConnectionCapability;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | "test" | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  // The user picks the model a probe speaks; nothing is chosen for them, so a retired model can
  // never be tested or validated behind their back.
  const [testModel, setTestModel] = useState("");
  const [oauthMode, setOauthMode] = useState<OAuthDialogMode | null>(null);

  const configured = entry?.authEntry.configured ?? false;
  const envSet = entry?.envSet ?? false;
  const envName = entry?.envName ?? null;
  const type = entry?.authEntry.type ?? null;
  const keyHint = entry?.authEntry.keyHint ?? null;
  const pendingConfigured = entry?.pendingEntry?.configured ?? false;

  // Save for later keeps the credential ready without replacing the one in use; applying checks
  // the candidate against the Provider first, so a failure leaves the working credential alone.
  const submitKey = useCallback(async (mode: "pending" | "apply", options: { staged?: boolean } = {}) => {
    const trimmed = keyDraft.trim();
    if (!trimmed && !options.staged) {
      setFeedback({ kind: "err", text: uiText("settings.page.keyIsRequired") });
      return;
    }
    // Applying checks the candidate against the Provider before it replaces the credential in
    // use, which needs the model the user picked to ask with.
    const modelId = testModel;
    if (mode === "apply" && !modelId) {
      setFeedback({
        kind: "err",
        text: uiText(provider?.models?.length ? "settings.page.pickTestModelFirst" : "settings.page.noModelRegisteredForThisProvider"),
      });
      return;
    }
    setBusy("save");
    setFeedback(null);
    try {
      await apiClient.put(`/api/auth/${encodeURIComponent(id)}`, {
        ...(trimmed ? { key: trimmed } : {}),
        mode,
        ...(mode === "apply" ? { modelId } : {}),
      });
      setKeyDraft("");
      setEditing(false);
      setShow(false);
      setFeedback({
        kind: "ok",
        text: uiText(mode === "pending" ? "settings.page.keySavedPending" : "settings.page.saved"),
      });
      onChanged();
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }, [id, keyDraft, onChanged, provider, testModel]);

  const clearKey = useCallback(async () => {
    setBusy("delete");
    setFeedback(null);
    try {
      await apiClient.delete(`/api/auth/${encodeURIComponent(id)}`);
      setFeedback({ kind: "ok", text: uiText("settings.page.cleared") });
      onChanged();
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }, [id, onChanged]);

  const testConn = useCallback(async () => {
    const modelId = testModel;
    if (!modelId) {
      setFeedback({
        kind: "err",
        text: uiText(provider?.models?.length ? "settings.page.pickTestModelFirst" : "settings.page.noModelRegisteredForThisProvider"),
      });
      return;
    }
    setBusy("test");
    setFeedback(null);
    try {
      const data = capability === "chat"
        ? await apiClient.post<{ ok?: boolean; error?: string; durationMs?: number }>(`/api/auth/${encodeURIComponent(id)}/test`, { modelId })
        : await apiClient.post<{ ok?: boolean; error?: string; durationMs?: number }>(`/api/connections/${encodeURIComponent(id)}/test`, { capability, model: modelId });
      setFeedback(connectionTestFeedback(data, modelId));
    } catch (err) {
      setFeedback({
        kind: "err",
        text: connectionTestFailureText(err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setBusy(null);
    }
  }, [id, provider, testModel, capability]);

  return (
    <li
      className="rounded-[0.55rem] border border-border bg-card"
      data-testid={`cloud-provider-${id}`}
    >
      <div className="grid grid-cols-1 items-center gap-3 px-3 py-2 lg:grid-cols-[minmax(12rem,1fr)_auto]">
        <div className="grid gap-0.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[0.92rem] font-medium text-foreground">
              {id}
            </span>
            {type === "oauth" && (
              <span className="text-[0.7rem] font-normal text-muted-foreground border border-border rounded px-1.5 py-0.5">
                oauth
              </span>
            )}
            {envSet && envName && (
              <span
                className="text-[0.7rem] font-mono text-emerald-600 dark:text-emerald-400 border border-emerald-600/30 rounded px-1.5 py-0.5"
                title={uiText("settings.page.environmentVariableNameIsSetOverridesAuthJson", { name: envName })}
              >
                {envName}
              </span>
            )}
          </div>
          <div className="text-[0.78rem] text-muted-foreground">
            {configured ? (
              type === "api_key" ? (
                <>
                  {uiText("settings.page.keyConfigured")}
                  {keyHint ? ` · ${keyHint}` : ""}
                </>
              ) : type === "oauth" ? (
                <>{uiText("settings.page.oauthSessionEstablished")}</>
              ) : (
                <>{uiText("settings.page.configured")}</>
              )
            ) : envSet ? (
              <>{uiText("settings.page.usingEnvironmentVariable")}</>
            ) : pendingConfigured ? (
              <>{uiText("settings.page.credentialPending")}</>
            ) : (
              <>{uiText("settings.page.notConfigured")}</>
            )}
          </div>
          <ConnectionBadges summary={summary} />
          {pendingConfigured && (
            <div
              className="mt-1 flex w-fit max-w-full items-center gap-2 rounded-[0.5rem] border border-[var(--warm-line)] bg-[var(--warm-soft)] px-2.5 py-1.5 text-[0.78rem] text-foreground"
              data-testid={`cloud-provider-pending-${id}`}
            >
              {/* Activating checks the credential with the model the user picked; nothing is picked for them. */}
              <span className="min-w-0 text-pretty">{uiText("settings.page.credentialSavedPickTestModel")}</span>
              <button
                type="button"
                className={`${BTN_PRIMARY} shrink-0 border-[var(--warm-line)]`}
                disabled={busy !== null || !testModel}
                title={testModel ? undefined : uiText(provider?.models?.length ? "settings.page.pickTestModelFirst" : "settings.page.noModelRegisteredForThisProvider")}
                onClick={() => submitKey("apply", { staged: true })}
                data-testid={`cloud-provider-apply-pending-${id}`}
              >
                {uiText("settings.page.activate")}
              </button>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 lg:justify-end">
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => {
              setEditing((v) => !v);
              setShow(false);
              setKeyDraft("");
            }}
            disabled={busy !== null}
          >
            {editing
              ? uiText("common.cancel")
              : configured
                ? uiText("settings.page.addAccount")
                : uiText("settings.page.setKey")}
          </button>
          {oauthInfo && (
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => setOauthMode("browser")}
              disabled={busy !== null}
              title={
                configured && type === "oauth"
                  ? uiText("settings.page.signInToProviderAgain", {
                      provider: oauthInfo.name,
                    })
                  : uiText("common.signInToProvider", {
                      provider: oauthInfo.name,
                    })
              }
              data-testid={`cloud-provider-${id}-oauth`}
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden />
              {configured && type === "oauth"
                ? uiText("settings.page.signInAgain")
                : uiText("settings.page.oauthSignIn")}
            </button>
          )}
          {oauthInfo?.supportsDeviceCode && (
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => setOauthMode("device")}
              disabled={busy !== null}
              title={uiText("settings.page.signInWithADeviceCodeWithoutALocal")}
              data-testid={`cloud-provider-${id}-oauth-device`}
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden />
              {uiText("settings.page.deviceCode")}
            </button>
          )}
          {(provider?.models?.length ?? 0) > 0 && (
            <select
              className="h-7 min-w-[140px] max-w-[20rem] flex-1 rounded border border-border bg-card px-1.5 text-[0.78rem] font-mono text-foreground"
              value={testModel}
              onChange={(e) => setTestModel(e.target.value)}
              disabled={busy !== null}
              aria-label={uiText("settings.page.modelUsedToTestId", { id })}
              title={uiText("settings.page.modelUsedForTesting")}
              data-testid={`cloud-provider-${id}-test-model`}
            >
              <option value="">{uiText("settings.page.pickTestModel")}</option>
              {provider!.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={testConn}
            disabled={
              busy !== null ||
              (!configured && !envSet) ||
              !testModel
            }
            title={
              !provider?.models?.length
                ? uiText("settings.page.unregisteredModel")
                : !testModel
                  ? uiText("settings.page.pickTestModelFirst")
                  : uiText("settings.page.sendASmallHealthCheck")
            }
          >
            {busy === "test" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            {uiText("settings.page.test")}
          </button>
          {configured && (type === "api_key" || type === "oauth") && (
            <button
              type="button"
              className={BTN_DANGER}
              onClick={clearKey}
              disabled={busy !== null}
              aria-label={
                type === "oauth"
                  ? uiText("settings.page.signOutOfIdOauth", { id })
                  : uiText("settings.page.clearTheIdApiKey", { id })
              }
              title={type === "oauth" ? uiText("settings.page.signOutOfOauth") : uiText("settings.page.clearApiKey")}
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
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2">
            <input
              type={show ? "text" : "password"}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={
                envName
                  ? `e.g. ${envName.startsWith("OPENAI") ? "sk-..." : uiText("settings.page.yourKey")}`
                  : uiText("settings.page.apiKey")
              }
              className="rounded-[0.5rem] border border-border bg-popover px-3 py-1.5 text-[0.85rem] font-mono text-foreground focus-visible:outline-none focus-visible:border-[var(--input)]"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className={BTN_PRIMARY}
              aria-label={show ? uiText("settings.page.hide") : uiText("settings.page.show")}
            >
              {show ? (
                <EyeOff className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Eye className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
            <button
              type="button"
              onClick={() => submitKey("pending")}
              className={BTN_PRIMARY}
              disabled={busy !== null || !keyDraft.trim()}
              data-testid={`cloud-provider-save-pending-${id}`}
            >
              {uiText("settings.page.saveForLater")}
            </button>
            <button
              type="button"
              onClick={() => submitKey("apply")}
              className={BTN_PRIMARY}
              disabled={busy !== null || !keyDraft.trim()}
              data-testid={`cloud-provider-apply-${id}`}
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
            feedback.kind === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-destructive",
          )}
        >
          {feedback.text}
        </div>
      )}
      {configured && <ProviderAccountsInline providerId={id} onChanged={onChanged} />}
      {oauthInfo && (
        <OAuthLoginDialog
          open={oauthMode !== null}
          providerId={id}
          providerName={oauthInfo.name}
          mode={oauthMode ?? "browser"}
          onClose={() => setOauthMode(null)}
          onSuccess={() => {
            setOauthMode(null);
            // The login prepared an authorization; it is in use only once the user applies it.
            setFeedback({ kind: "ok", text: uiText("settings.page.oauthSavedPending") });
            onChanged();
          }}
        />
      )}
    </li>
  );
}
