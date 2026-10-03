import { useCallback, useEffect, useRef, useState } from "react";
import type { NetworkEgressConfiguration, NetworkEgressRequestErrorCode, NetworkEgressSnapshot } from "@shared/network-egress.js";
import type { MessageId } from "@/app/locales/zh-CN";
import { ApiError, apiClient } from "@/shared/lib/api-client";

const PATH = "/api/network/egress";
export const networkEgressApi = {
  load: (signal?: AbortSignal) => apiClient.get<NetworkEgressSnapshot>(PATH, { signal }),
  save: (configuration: NetworkEgressConfiguration, signal?: AbortSignal) => apiClient.put<NetworkEgressSnapshot>(PATH, configuration, { signal }),
  refresh: (signal?: AbortSignal) => apiClient.post<NetworkEgressSnapshot>(`${PATH}/refresh`, undefined, { signal }),
  login: (signal?: AbortSignal) => apiClient.post<NetworkEgressSnapshot>(`${PATH}/login`, undefined, { signal }),
};

const REQUEST_ERRORS: Record<NetworkEgressRequestErrorCode, MessageId> = {
  invalid_configuration: "settings.network.error.invalidConfiguration",
  tailscale_unavailable: "settings.network.error.tailscaleUnavailable",
  tailscale_login_failed: "settings.network.error.loginFailed",
  apply_failed: "settings.network.error.applyFailed",
  request_not_allowed: "settings.network.error.requestNotAllowed",
};

export function networkEgressErrorMessage(error: unknown, fallback: MessageId): MessageId {
  const data = error instanceof ApiError ? error.data : null;
  const code = data && typeof data === "object" && "errorCode" in data ? data.errorCode : null;
  return typeof code === "string" && Object.hasOwn(REQUEST_ERRORS, code)
    ? REQUEST_ERRORS[code as NetworkEgressRequestErrorCode] : fallback;
}

export function trustedTailscaleLoginUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://login.tailscale.com" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function sameNetworkConfiguration(a: NetworkEgressConfiguration | null | undefined, b: NetworkEgressConfiguration | null | undefined): boolean {
  const key = (config: NetworkEgressConfiguration) => JSON.stringify({ enabled: config.enabled,
    nodes: [...config.nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map(({ nodeId, sshUser, sshPort }) => ({ nodeId, sshUser, sshPort })) });
  return Boolean(a && b && key(a) === key(b));
}

/** Health polling follows server state; only a clean draft follows externally saved configuration. */
export function reconcileNetworkDraft(draft: NetworkEgressConfiguration | null, previous: NetworkEgressConfiguration | undefined, next: NetworkEgressConfiguration): NetworkEgressConfiguration {
  return draft === null || sameNetworkConfiguration(draft, previous) ? next : draft;
}

export function validNetworkConfiguration(config: NetworkEgressConfiguration): boolean {
  return config.nodes.every((node) => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(node.sshUser.trim())
    && Number.isInteger(node.sshPort) && node.sshPort >= 1 && node.sshPort <= 65_535);
}

export function useNetworkEgress() {
  const [snapshot, setSnapshot] = useState<NetworkEgressSnapshot | null>(null);
  const [draft, setDraft] = useState<NetworkEgressConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MessageId | null>(null);
  const [busy, setBusy] = useState<"save" | "refresh" | "login" | null>(null);
  const [saved, setSaved] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const latest = useRef<NetworkEgressSnapshot | null>(null);
  const read = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);

  const accept = useCallback((next: NetworkEgressSnapshot, replaceDraft = false) => {
    const previous = latest.current?.configuration;
    latest.current = next;
    setSnapshot(next);
    setDraft((current) => replaceDraft ? next.configuration : reconcileNetworkDraft(current, previous, next.configuration));
    setError(null);
  }, []);

  const reload = useCallback(async () => {
    if (read.current || mutation.current) return;
    const controller = new AbortController();
    const request = ++generation.current;
    read.current = controller;
    if (!latest.current) setLoading(true);
    try {
      const next = await networkEgressApi.load(controller.signal);
      if (mounted.current && generation.current === request) accept(next);
    } catch (cause) {
      if (mounted.current && generation.current === request && !controller.signal.aborted)
        setError(networkEgressErrorMessage(cause, "settings.network.error.loadFailed"));
    } finally {
      if (read.current === controller) read.current = null;
      if (mounted.current && generation.current === request) setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      generation.current += 1;
      read.current?.abort(); mutation.current?.abort();
      read.current = null; mutation.current = null;
    };
  }, [reload]);

  const connecting = snapshot?.nodes.some((node) => node.state === "connecting");
  useEffect(() => {
    if (snapshot?.tailscale.state !== "running" && !trustedTailscaleLoginUrl(snapshot?.tailscale.authUrl)) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, connecting ? 2_000 : 5_000);
    return () => window.clearInterval(timer);
  }, [reload, connecting, snapshot?.tailscale.state, snapshot?.tailscale.authUrl]);

  const act = useCallback(async (action: "save" | "refresh" | "login") => {
    if (mutation.current || (action === "login" && latest.current?.tailscale.state === "running")) return;
    if (action === "save" && (!draft || !validNetworkConfiguration(draft))) return;
    const controller = new AbortController();
    const request = ++generation.current;
    read.current?.abort(); read.current = null;
    mutation.current = controller;
    setBusy(action); setError(null); setSaved(false);
    try {
      const next = action === "save" ? await networkEgressApi.save({ ...draft!, nodes: draft!.nodes.map((node) => ({ ...node, sshUser: node.sshUser.trim() })) }, controller.signal)
        : await networkEgressApi[action](controller.signal);
      if (mounted.current && generation.current === request) {
        accept(next, action === "save");
        setSaved(action === "save");
      }
    } catch (cause) {
      if (mounted.current && generation.current === request && !controller.signal.aborted)
        setError(networkEgressErrorMessage(cause, action === "save" ? "settings.network.error.saveFailed"
          : action === "login" ? "settings.network.error.loginFailed" : "settings.network.error.refreshFailed"));
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (mounted.current && generation.current === request) { setBusy(null); setLoading(false); }
    }
  }, [accept, draft]);

  return { snapshot, draft, loading, error, busy, saved,
    dirty: Boolean(draft && snapshot && !sameNetworkConfiguration(draft, snapshot.configuration)),
    onChange: (next: NetworkEgressConfiguration) => { setDraft(next); setSaved(false); },
    onSave: () => act("save"), onRefresh: () => act("refresh"), onLogin: () => act("login"), onReload: reload };
}
