import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NetworkEgressConfiguration, NetworkEgressNodeState, NetworkEgressSnapshot } from "../../shared/network-egress.js";
import { NetworkEgressSettingsView } from "../../web/src/features/settings/NetworkEgressSettings.js";
import { networkEgressApi, networkEgressErrorMessage, reconcileNetworkDraft, sameNetworkConfiguration, trustedTailscaleLoginUrl, validNetworkConfiguration } from "../../web/src/features/settings/use-network-egress.js";
import { ApiError } from "../../web/src/shared/lib/api-client.js";
import i18n from "../../web/src/app/i18n.js";

const configuration: NetworkEgressConfiguration = { schemaVersion: 1, enabled: true,
  nodes: [{ nodeId: "lzw", sshUser: "lzw", sshPort: 22 }] };
const snapshot: NetworkEgressSnapshot = { schemaVersion: 1, tailscale: { state: "running" }, configuration,
  nodes: [
    { id: "lzw", name: "lzw", os: "linux", online: true, supported: true, enabled: true, state: "ready", sshUser: "lzw", sshPort: 22 },
    { id: "phone", name: "iPhone", os: "ios", online: true, supported: false, enabled: false, state: "unsupported" },
  ], sourceServiceState: "ready" };

function render(data: NetworkEgressSnapshot | null, override: Partial<React.ComponentProps<typeof NetworkEgressSettingsView>> = {}): string {
  return renderToStaticMarkup(<NetworkEgressSettingsView snapshot={data} draft={data?.configuration ?? null} loading={!data}
    error={null} busy={null} saved={false} dirty={false} onChange={() => undefined}
    onSave={async () => undefined} onRefresh={async () => undefined} onLogin={async () => undefined} onReload={async () => undefined} {...override} />);
}

await i18n.changeLanguage("zh-CN");
const chinese = render(snapshot);
assert.match(chinese, /网络出口/u);
assert.match(chinese, /Tailscale 已连接/u);
assert.match(chinese, /就绪/u);
assert.match(chinese, /Linux.*在线/u);
assert.match(chinese, /SSH 用户名/u);
assert.match(chinese, /SSH 端口/u);
assert.match(chinese, /value="lzw"/u);
assert.match(chinese, /value="22"/u);
const phoneCheckbox = chinese.match(/<input[^>]*aria-label="选择 iPhone 作为出口"[^>]*>/u)?.[0];
assert.ok(phoneCheckbox);
assert.match(phoneCheckbox, /disabled/u);
assert.match(chinese, /手机等设备暂不支持/u);
assert.match(chinese, /缓存与文档解析仍在当前服务端/u);
assert.doesNotMatch(chinese, /network-egress-login-link/u, "connected clients never offer another login");

for (const [state, text] of [
  ["disabled", "未启用"], ["unsupported", "不支持"], ["offline", "离线"], ["needs_configuration", "待配置"],
  ["connecting", "连接中"], ["ready", "就绪"], ["error", "连接失败"],
] as Array<[NetworkEgressNodeState, string]>) {
  const data: NetworkEgressSnapshot = { ...snapshot, nodes: [{ ...snapshot.nodes[0]!, state }] };
  assert.ok(render(data).includes(text), `node state ${state} is visible`);
}

const unsafeExtra = Object.assign({ ...snapshot.nodes[0]!, state: "error" as const, errorCode: "ssh_host_untrusted" as const },
  { internalProxyPort: 54321, privateKeyPath: "/private/test-network-key", stderr: "secret-raw-stderr" });
const errorHtml = render({ ...snapshot, nodes: [unsafeExtra], sourceServiceState: "unavailable" });
assert.match(errorHtml, /尚未信任此服务器的 SSH 主机密钥/u);
assert.match(errorHtml, /资料获取服务暂不可用/u);
assert.doesNotMatch(errorHtml, /54321|private\/test-network-key|secret-raw-stderr/u);

const edit = { ...configuration, nodes: [{ ...configuration.nodes[0]!, sshUser: "another-user" }] };
const dirtyHtml = render(snapshot, { draft: edit, dirty: true });
assert.match(dirtyHtml, /待保存/u);
assert.doesNotMatch(dirtyHtml, />就绪</u, "edited SSH details cannot present an old ready check as their own");
assert.match(dirtyHtml, /有未保存的更改/u);
assert.doesNotMatch(render(snapshot, { draft: { ...configuration, enabled: false }, dirty: true }), />就绪</u,
  "a global disable draft does not reuse the saved ready label");
assert.match(render(snapshot, { draft: { ...edit, nodes: [{ ...edit.nodes[0]!, sshUser: "" }] }, dirty: true }), /请为选中的服务器填写用户名/u);
assert.match(render(snapshot, { busy: "save" }), /保存中/u);
assert.match(render(snapshot, { saved: true }), /设置已保存/u);
assert.match(render(null), /network-egress-loading/u);
assert.match(render(null, { loading: false, error: "settings.network.error.loadFailed" }), /无法读取网络出口状态/u);
assert.match(render({ ...snapshot, nodes: [], configuration: { schemaVersion: 1, enabled: false, nodes: [] } }), /尚未发现其他设备/u);
assert.match(render({ ...snapshot, tailscale: { state: "not_installed" } }), /href="https:\/\/tailscale.com\/download"/u);
assert.match(render({ ...snapshot, tailscale: { state: "unavailable" } }), /确认当前服务端的 Tailscale 客户端/u);

const login = render({ ...snapshot, tailscale: { state: "needs_login", authUrl: "https://login.tailscale.com/a/example" } });
assert.match(login, /href="https:\/\/login.tailscale.com\/a\/example" target="_blank" rel="noopener noreferrer"/u);
for (const url of ["javascript:alert(1)", "http://login.tailscale.com/a/1", "https://login.tailscale.com.evil.example/a/1",
  "https://user:password@login.tailscale.com/a/1", "https://login.tailscale.com:444/a/1", "https://headscale.example/a/1"]) {
  assert.equal(trustedTailscaleLoginUrl(url), null, url);
  assert.doesNotMatch(render({ ...snapshot, tailscale: { state: "needs_login", authUrl: url } }), /network-egress-login-link/u);
}
assert.equal(trustedTailscaleLoginUrl("https://login.tailscale.com:443/a/1"), "https://login.tailscale.com/a/1");

assert.equal(reconcileNetworkDraft(edit, configuration, configuration), edit, "status polling preserves unsaved node edits");
const external = { ...configuration, enabled: false };
assert.equal(reconcileNetworkDraft(structuredClone(configuration), configuration, external), external, "clean pages follow externally saved settings");
assert.equal(reconcileNetworkDraft(null, undefined, configuration), configuration);
assert.equal(sameNetworkConfiguration(configuration, structuredClone(configuration)), true);
for (const port of [Number.NaN, 0, 22.5, 65536])
  assert.equal(validNetworkConfiguration({ ...configuration, nodes: [{ ...configuration.nodes[0]!, sshPort: port }] }), false);
assert.equal(validNetworkConfiguration(configuration), true);
assert.equal(validNetworkConfiguration({ ...configuration, nodes: [{ ...configuration.nodes[0]!, sshUser: "  " }] }), false);
for (const sshUser of ["user name", "-user", "user@host", "中文", "user/host"])
  assert.equal(validNetworkConfiguration({ ...configuration, nodes: [{ ...configuration.nodes[0]!, sshUser }] }), false);

assert.equal(networkEgressErrorMessage(new ApiError("secret-raw-stderr", 500, { errorCode: "apply_failed" }), "settings.network.error.loadFailed"), "settings.network.error.applyFailed");
assert.equal(networkEgressErrorMessage(new ApiError("secret-raw-stderr", 500, { errorCode: "unknown-error" }), "settings.network.error.loadFailed"), "settings.network.error.loadFailed");
assert.equal(networkEgressErrorMessage(new ApiError("secret-raw-stderr", 403, { errorCode: "request_not_allowed" }), "settings.network.error.loadFailed"), "settings.network.error.requestNotAllowed");

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; method: string; body?: unknown; signal?: AbortSignal | null }> = [];
globalThis.fetch = async (input, init) => {
  requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal });
  return new Response(JSON.stringify(snapshot), { headers: { "Content-Type": "application/json" } });
};
try {
  const controller = new AbortController();
  assert.deepEqual(await networkEgressApi.load(controller.signal), snapshot);
  await networkEgressApi.save(configuration, controller.signal);
  await networkEgressApi.refresh(controller.signal);
  await networkEgressApi.login(controller.signal);
  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [["/api/network/egress", "GET"], ["/api/network/egress", "PUT"],
    ["/api/network/egress/refresh", "POST"], ["/api/network/egress/login", "POST"]]);
  assert.deepEqual(requests[1]?.body, configuration, "saving sends only the opt-in configuration, never discovered peers or status");
  assert.ok(requests.every((request) => request.signal === controller.signal), "every operation can cancel when the panel unmounts");
} finally { globalThis.fetch = originalFetch; }

await i18n.changeLanguage("en");
const english = render(snapshot);
assert.match(english, /Network exits/u);
assert.match(english, /Tailscale is connected/u);
assert.match(english, /SSH username/u);
assert.match(english, /Ready/u);
assert.doesNotMatch(english, /网络出口|就绪|保存/u);
console.log("network exit settings UI, draft, privacy and API contract tests passed");
