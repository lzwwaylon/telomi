import { CheckCircle2, ExternalLink, Loader2, RefreshCw, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NetworkEgressErrorCode, NetworkEgressNodeState } from "@shared/network-egress.js";
import type { MessageId } from "@/app/locales/zh-CN";
import { Input } from "@/shared/ui/input";
import { cn } from "@/shared/lib/utils";
import { SettingsPanel } from "./SettingsPanel";
import { BTN_PRIMARY } from "./settings-styles";
import { sameNetworkConfiguration, trustedTailscaleLoginUrl, useNetworkEgress, validNetworkConfiguration } from "./use-network-egress";

const STATE_LABELS: Record<NetworkEgressNodeState, MessageId> = {
  disabled: "settings.network.node.disabled", unsupported: "settings.network.node.unsupported",
  offline: "settings.network.node.offline", needs_configuration: "settings.network.node.needsConfiguration",
  connecting: "settings.network.node.connecting", ready: "settings.network.node.ready", error: "settings.network.node.error",
};
const NODE_ERRORS: Record<NetworkEgressErrorCode, MessageId> = {
  ssh_unavailable: "settings.network.error.sshUnavailable", ssh_connection_failed: "settings.network.error.sshConnectionFailed",
  ssh_authentication_failed: "settings.network.error.sshAuthenticationFailed", ssh_host_untrusted: "settings.network.error.sshHostUntrusted",
  forwarding_unavailable: "settings.network.error.forwardingUnavailable", source_service_unavailable: "settings.network.error.sourceServiceUnavailable",
};
const TAILSCALE_LABELS: Record<string, MessageId> = {
  not_installed: "settings.network.tailscale.notInstalled", needs_login: "settings.network.tailscale.needsLogin",
  running: "settings.network.tailscale.running", unavailable: "settings.network.tailscale.unavailable",
};
const PLATFORM_NAMES: Record<string, string> = { linux: "Linux", darwin: "macOS", macos: "macOS", ios: "iOS", android: "Android", windows: "Windows" };

export function NetworkEgressSettings() {
  return <NetworkEgressSettingsView {...useNetworkEgress()} />;
}

/** Server health and the editable configuration stay distinct while a user selects exits. */
export function NetworkEgressSettingsView({ snapshot, draft, loading, error, busy, saved, dirty, onChange, onSave, onRefresh, onLogin, onReload }: ReturnType<typeof useNetworkEgress>) {
  const { t } = useTranslation();
  const disabled = Boolean(busy);
  const loginUrl = snapshot?.tailscale.state === "needs_login" ? trustedTailscaleLoginUrl(snapshot.tailscale.authUrl) : null;
  const nodes = [...(snapshot?.nodes ?? [])];
  const missing = (draft?.nodes ?? []).filter((choice) => !nodes.some((node) => node.id === choice.nodeId));

  return (
    <SettingsPanel id="network" heading="settings.section.network" description="settings.network.description">
      {error && <div role="alert" className="rounded-[0.55rem] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[0.85rem] text-destructive">
        {t(error)}
        {!snapshot && <button type="button" className={`${BTN_PRIMARY} ml-3`} onClick={() => void onReload()} disabled={loading}>{t("settings.network.retry")}</button>}
      </div>}
      {loading && !snapshot && <div role="status" aria-busy="true" className="grid gap-3" data-testid="network-egress-loading">
        <span className="text-[0.85rem] text-muted-foreground">{t("common.loading")}</span>
        <div aria-hidden className="grid gap-3 motion-safe:animate-pulse">
          <div className="h-8 w-48 rounded-[0.5rem] bg-[var(--foreground-5)]" />
          <div className="h-20 rounded-[0.5rem] bg-[var(--foreground-5)]" />
        </div>
      </div>}
      {snapshot && draft && <>
        <section className="grid gap-3 border-b border-border pb-5" aria-label={t("settings.network.connection")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="status" className="flex min-w-0 items-center gap-2 text-[0.9rem]" data-testid="network-egress-tailscale">
              {snapshot.tailscale.state === "running" ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> : <Server className="h-4 w-4 shrink-0" aria-hidden />}
              <span>{t(TAILSCALE_LABELS[snapshot.tailscale.state]!)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {snapshot.tailscale.state === "not_installed" && <a href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer" className={BTN_PRIMARY}>
                {t("settings.network.install")}<ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>}
              {snapshot.tailscale.state === "needs_login" && !loginUrl && <button type="button" className={BTN_PRIMARY} disabled={disabled} onClick={() => void onLogin()}>
                {busy === "login" && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />}
                {t("settings.network.login")}
              </button>}
              {loginUrl && <a href={loginUrl} target="_blank" rel="noopener noreferrer" className={BTN_PRIMARY} data-testid="network-egress-login-link">
                {t("settings.network.loginLink")}<ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>}
              <button type="button" className={BTN_PRIMARY} disabled={disabled} onClick={() => void onRefresh()} data-testid="network-egress-refresh">
                <RefreshCw className={cn("h-3.5 w-3.5", busy === "refresh" && "motion-safe:animate-spin")} aria-hidden />
                {t("settings.network.refreshNodes")}
              </button>
            </div>
          </div>
          {snapshot.tailscale.state === "needs_login" && <p className="m-0 text-[0.82rem] text-muted-foreground">{t("settings.network.loginHint")}</p>}
          {snapshot.tailscale.state === "unavailable" && <p className="m-0 text-[0.82rem] text-muted-foreground">{t("settings.network.tailscaleUnavailableHint")}</p>}
        </section>

        <form className="grid gap-6" onSubmit={(event) => { event.preventDefault(); void onSave(); }}>
          <div className="flex items-start justify-between gap-5">
            <div className="grid gap-1">
              <label htmlFor="network-egress-enabled" className="text-[0.95rem] font-medium">{t("settings.network.enabled")}</label>
              <p className="m-0 max-w-[70ch] text-[0.82rem] leading-relaxed text-muted-foreground" id="network-egress-enabled-description">{t("settings.network.enabledDescription")}</p>
            </div>
            <input id="network-egress-enabled" type="checkbox" checked={draft.enabled} disabled={disabled} aria-describedby="network-egress-enabled-description"
              className="mt-1 h-4 w-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} data-testid="network-egress-enabled" />
          </div>

          <section className="grid gap-2" aria-labelledby="network-egress-nodes-heading">
            <div className="grid gap-1 pb-2">
              <h3 id="network-egress-nodes-heading" className="m-0 text-[0.95rem] font-medium">{t("settings.network.nodes")}</h3>
              <p className="m-0 text-[0.82rem] text-muted-foreground">{t("settings.network.nodesDescription")}</p>
            </div>
            {nodes.length === 0 && missing.length === 0 && <div className="border-y border-border py-6 text-[0.85rem] text-muted-foreground" data-testid="network-egress-empty">
              {t(snapshot.tailscale.state === "running" ? "settings.network.empty" : "settings.network.connectFirst")}
            </div>}
            <ul className="m-0 grid list-none divide-y divide-border p-0">
              {nodes.map((node) => {
                const choice = draft.nodes.find((entry) => entry.nodeId === node.id);
                const existing = snapshot.configuration.nodes.find((entry) => entry.nodeId === node.id);
                const nodeDirty = !sameNetworkConfiguration({ schemaVersion: 1, enabled: Boolean(choice), nodes: choice ? [choice] : [] },
                  { schemaVersion: 1, enabled: Boolean(existing), nodes: existing ? [existing] : [] })
                  || (draft.enabled !== snapshot.configuration.enabled && Boolean(choice || existing));
                const label = nodeDirty ? t("settings.network.node.pendingSave") : t(STATE_LABELS[node.state]);
                const update = (patch: Partial<NonNullable<typeof choice>>) => onChange({ ...draft, nodes: draft.nodes.map((entry) => entry.nodeId === node.id ? { ...entry, ...patch } : entry) });
                const fieldId = `network-egress-${encodeURIComponent(node.id)}`;
                return <li key={node.id} className="grid gap-3 py-4" data-testid={`network-egress-node-${node.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <label className="flex min-w-0 items-start gap-3">
                      <input type="checkbox" checked={Boolean(choice)} disabled={disabled || (!node.supported && !choice)}
                        aria-label={t("settings.network.selectNode", { name: node.name })} className="mt-1 h-4 w-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                        onChange={(event) => onChange({ ...draft, nodes: event.target.checked
                          ? [...draft.nodes, { nodeId: node.id, sshUser: node.sshUser ?? "", sshPort: node.sshPort ?? 22 }]
                          : draft.nodes.filter((entry) => entry.nodeId !== node.id) })} />
                      <span className="grid min-w-0 gap-1">
                        <span className="break-all text-[0.9rem] font-medium">{node.name}</span>
                        <span className="text-[0.78rem] text-muted-foreground">
                          {PLATFORM_NAMES[node.os.toLowerCase()] ?? (node.os || t("settings.network.unknownSystem"))}
                          {" · "}{t(node.online ? "settings.network.node.online" : "settings.network.node.offline")}
                        </span>
                      </span>
                    </label>
                    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-[0.78rem]", !nodeDirty && node.state === "error" ? "text-destructive" : "text-muted-foreground")} role="status">
                      {!nodeDirty && node.state === "connecting" && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />}
                      {!nodeDirty && node.state === "ready" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                      {label}
                    </span>
                  </div>
                  {!node.supported && <p className="m-0 pl-7 text-[0.8rem] text-muted-foreground">{t("settings.network.unsupportedHint")}</p>}
                  {choice && <fieldset className="m-0 grid min-w-0 gap-3 border-0 p-0 pl-7 sm:grid-cols-[minmax(0,1fr)_130px]" disabled={disabled}>
                    <legend className="sr-only">{t("settings.network.sshForNode", { name: node.name })}</legend>
                    <div className="grid content-start gap-1.5">
                      <label htmlFor={`${fieldId}-user`} className="text-[0.8rem]">{t("settings.network.sshUser")}</label>
                      <Input id={`${fieldId}-user`} value={choice.sshUser} required maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false}
                        placeholder={t("settings.network.sshUserPlaceholder")} aria-describedby={`${fieldId}-user-description`}
                        onChange={(event) => update({ sshUser: event.target.value })} />
                      <p id={`${fieldId}-user-description`} className="m-0 text-[0.75rem] leading-relaxed text-muted-foreground">{t("settings.network.sshUserHint")}</p>
                    </div>
                    <div className="grid content-start gap-1.5">
                      <label htmlFor={`${fieldId}-port`} className="text-[0.8rem]">{t("settings.network.sshPort")}</label>
                      <Input id={`${fieldId}-port`} type="number" min={1} max={65535} step={1} required value={Number.isFinite(choice.sshPort) ? choice.sshPort : ""}
                        onChange={(event) => update({ sshPort: event.target.valueAsNumber })} />
                    </div>
                  </fieldset>}
                  {node.errorCode && <p role="status" className="m-0 pl-7 text-[0.8rem] text-destructive">{t(NODE_ERRORS[node.errorCode] ?? "settings.network.node.error")}</p>}
                </li>;
              })}
              {missing.map((choice) => <li key={choice.nodeId} className="flex items-start justify-between gap-3 py-4 text-[0.85rem]">
                <label className="flex min-w-0 items-start gap-3">
                  <input type="checkbox" checked disabled={disabled} aria-label={t("settings.network.removeMissingNode", { name: choice.nodeId })}
                    className="mt-1 h-4 w-4 shrink-0 accent-primary" onChange={() => onChange({ ...draft, nodes: draft.nodes.filter((entry) => entry.nodeId !== choice.nodeId) })} />
                  <span className="break-all">{choice.nodeId}</span>
                </label>
                <span className="shrink-0 text-muted-foreground">{t("settings.network.node.notDiscovered")}</span>
              </li>)}
            </ul>
          </section>

          <div className="grid gap-3 border-t border-border pt-4">
            <p className="m-0 max-w-[70ch] text-[0.8rem] leading-relaxed text-muted-foreground">{t("settings.network.sshHint")}</p>
            {snapshot.sourceServiceState === "unavailable" && <p role="status" className="m-0 text-[0.82rem] text-destructive">{t("settings.network.error.sourceServiceUnavailable")}</p>}
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className={BTN_PRIMARY} disabled={disabled || !validNetworkConfiguration(draft) || (!dirty && error !== "settings.network.error.applyFailed")}
                data-testid="network-egress-save">
                {busy === "save" && <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />}
                {t(busy === "save" ? "common.saving" : "common.save")}
              </button>
              <span role="status" className="text-[0.8rem] text-muted-foreground">
                {dirty ? t(validNetworkConfiguration(draft) ? "settings.network.unsaved" : "settings.network.completeFields") : saved ? t("settings.network.saved") : ""}
              </span>
            </div>
          </div>
        </form>
      </>}
    </SettingsPanel>
  );
}
