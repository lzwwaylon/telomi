import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "../../web/src/features/settings/SettingsPage.js";
import { AssignmentBoard, type BoardRow } from "../../web/src/features/settings/AssignmentBoard.js";
import { chatBoardRows } from "../../web/src/features/settings/ChatModelSettings.js";
import { embeddingBoardRows, embeddingChanges, embeddingDraft } from "../../web/src/features/settings/MemoryEmbeddingSettings.js";
import { sttBoardRows } from "../../web/src/features/settings/SttSettings.js";
import { generationChanges, generationDraft, ttsBoardRows } from "../../web/src/features/settings/TtsSettings.js";
import { PendingConfigNotice, UnsavedChangesNotice } from "../../web/src/features/settings/PendingConfigNotice.js";
import type { SpeechConfigurationResponse } from "../../shared/speech-configuration.js";
import type { AudioGenerationConfiguration, AudioGenerationResponse, AudioGenerationSelection } from "../../shared/audio-generation.js";
import { ConnectionsSection } from "../../web/src/features/settings/ConnectionsSection.js";
import { OllamaConnectionForm } from "../../web/src/features/settings/OllamaConnectionForm.js";
import { SourceRow, type SourceEntry } from "../../web/src/features/settings/SearchProviderSection.js";
import { ConnectionTestButton, ListedInput } from "../../web/src/features/settings/ConnectionModelFields.js";
import { VoicePreviewButton } from "../../web/src/features/settings/VoicePreviewButton.js";
import { localRuntimeDetail } from "../../web/src/features/settings/VoiceLocalRuntimeSettings.js";
import { CustomProviderForm, CustomProviderRow } from "../../web/src/features/settings/CustomProviderRow.js";
import { CloudProviderRow } from "../../web/src/features/settings/CloudProviderRow.js";
import { ConnectionBadges } from "../../web/src/features/settings/ConnectionBadges.js";
import { connectionTestFeedback } from "../../web/src/features/settings/use-test-model.js";
import { renderStatus } from "../../web/src/features/settings/ProviderAccountsInline.js";
import type { ProviderAccountSummary } from "../../shared/types.js";
import type { ConnectionSummary } from "../../shared/connections.js";
import type { EmbeddingResponse } from "../../shared/embedding-configuration.js";
import i18next from "i18next";
import {
	type ProviderConfig,
	type SearchCredentialProviderStatus,
} from "../../web/src/features/settings/provider-config.js";
import { keptVoice } from "../../web/src/features/settings/audio-config.js";

/**
 * A translation used as a regular expression matches itself and nothing else. Copy carries regex
 * metacharacters of its own, "{{count}} Goal(s) switch on their next turn" for one, and an
 * unescaped "(s)" silently turns into a group that matches a different sentence.
 */
const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

test("settings deep links assemble only the requested panel", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    for (const [search, panel] of [
      ["", "chat"],
      ["?section=unknown", "chat"],
      ["?section=chat", "chat"],
      ["?section=embedding", "embedding"],
      ["?section=tts", "tts"],
      ["?section=stt", "stt"],
      ["?section=sources", "sources"],
      ["?section=appearance", "appearance"],
      // Older links: credentials and the overview now live on the capability pages; `audio` and `voice` folded into recognition.
      ["?section=connections", "chat"],
      ["?section=overview", "chat"],
      ["?section=provider", "chat"],
      ["?section=audio", "stt"],
      ["?section=voice", "stt"],
    ]) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { search } },
      });
      const html = renderToStaticMarkup(<SettingsPage onBack={() => undefined} />);
      assert.deepEqual(html.match(/data-testid="settings-section-[^"]+"/g), [
        `data-testid="settings-section-${panel}"`,
      ]);
      assert.match(html, new RegExp(`data-testid="settings-nav-${panel}" aria-current="page"`));
      assert.match(html, /data-testid="settings-back"/);
      for (const removed of ["settings-nav-overview", "settings-nav-connections"]) {
        assert.ok(!html.includes(removed), `${removed} is no longer a page`);
      }
    }
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

const CONNECTIONS: ConnectionSummary[] = [
  { id: "telomi-test", kind: "custom", status: "connected", auth: "api_key", keyHint: "sk…1", capabilities: ["chat", "embedding"], usedBy: [],
    models: { chat: [{ id: "large-1", name: "Large 1" }, { id: "small-1", name: "Small 1" }], embedding: [{ id: "embed-1" }], tts: [], stt: [] } },
  { id: "telomi-idle", kind: "cloud", status: "unconfigured", auth: null, keyHint: null, capabilities: ["chat"], usedBy: [],
    models: { chat: [{ id: "idle-1" }], embedding: [], tts: [], stt: [] } },
];

const CHAT_CONFIG: ProviderConfig = {
  defaultProvider: "telomi-test",
  defaultModel: "large-1",
  defaultThinkingLevel: "low",
  stageThinkingLevels: { "primeRoot.reportWriter": "high" },
  enabledModels: [],
  providerFallbackModels: [],
  taskModels: { primeRoot: "telomi-test/small-1" },
  taskModelRoles: [
    { id: "cornellNote", label: "Cornell Note", description: "", legacyEnvVar: "", stages: { evidenceNote: { label: "Evidence note", envVar: "" } } },
    { id: "primeRoot", label: "Prime Root", description: "", legacyEnvVar: "", stages: { reportWriter: { label: "Report writing", envVar: "" } } },
  ],
  providers: [],
  thinkingLevels: ["off", "low", "high"],
  consumers: [
    { id: "mainAgent", effectiveModel: "telomi-test/large-1", status: "pending", pendingCount: 2, stages: [] },
    { id: "cornellNote", effectiveModel: "telomi-test/large-1", status: "active", pendingCount: 0, stages: [{ key: "cornellNote.evidenceNote", label: "Evidence note", thinkingLevel: "low", source: "settings" }] },
    { id: "primeRoot", effectiveModel: "telomi-test/small-1", status: "active", pendingCount: 0, stages: [{ key: "primeRoot.reportWriter", label: "Report writing", thinkingLevel: "high", source: "override" }] },
  ],
};

test("a memory failure before any global default exists is a hint to set one, not an error", () => {
  const fresh: ProviderConfig = { ...CHAT_CONFIG, defaultProvider: null, defaultModel: null, consumers: [], memoryConfiguration: { status: "failed", error: "Hindsight startup failed: Configure the Memory llm model or global LLM default" } };
  assert.deepEqual(chatBoardRows(fresh)[0]?.status, { text: i18next.t("settings.board.memoryNeedsDefault"), tone: "pending" });
  const configured: ProviderConfig = { ...CHAT_CONFIG, consumers: [], memoryConfiguration: { status: "failed", error: "Memory cannot use openai-codex models ('openai-codex-responses' is unsupported)" } };
  const status = chatBoardRows(configured)[0]?.status;
  assert.equal(status?.tone, "error");
  // The default row points to where the user can fix Memory; the reason is stated there once.
  assert.ok(!status?.text.includes("openai-codex"), "the protocol error stays on the User Memory page");
  assert.deepEqual(status?.link, { label: i18next.t("settings.board.memoryFix"), href: "/settings?section=embedding#memory-models" });
  const html = renderToStaticMarkup(<AssignmentBoard capability="chat" rows={chatBoardRows(configured)} connections={CONNECTIONS} testId="chat-board" onChange={() => undefined} />);
  assert.match(html, /<a href="\/settings\?section=embedding#memory-models"[^>]*data-testid="chat-board-status-link-default">/);
  // Without an embedding model the service cannot start; that asks for a choice, it is not a failure.
  const unset: ProviderConfig = { ...configured, memoryConfiguration: { status: "failed", error: "Hindsight startup failed: Choose an embedding model for User Memory", embeddingSelected: false } };
  assert.deepEqual(chatBoardRows(unset)[0]?.status, { text: i18next.t("settings.board.memoryNeedsEmbedding"), tone: "pending", link: { label: i18next.t("settings.board.memoryChooseEmbedding"), href: "/settings?section=embedding" } });
});

test("the assignment board shows the default, marks inherited rows, and offers a reset only where a row is its own", () => {
  const rows = chatBoardRows(CHAT_CONFIG);
  // The first row is the global default; a role without its own model resolves to it.
  assert.deepEqual(rows[0]?.own, { connection: "telomi-test", model: "large-1", depth: "low" });
  assert.equal(rows[1]?.own, null);
  assert.deepEqual(rows[1]?.resolved, { connection: "telomi-test", model: "large-1", depth: "low" });
  assert.deepEqual(rows[2]?.own, { connection: "telomi-test", model: "small-1", depth: "high" });
  assert.deepEqual(rows[2]?.stages, [{ key: "primeRoot.reportWriter", label: "Report writing", own: "high", resolved: "high" }]);

  const html = renderToStaticMarkup(
    <AssignmentBoard capability="chat" rows={rows} connections={CONNECTIONS} columns={["depth"]} depthLevels={CHAT_CONFIG.thinkingLevels} testId="chat-board" onChange={() => undefined} />,
  );
  assert.match(html, /data-testid="chat-board-model-default"[^>]*>[\s\S]*?<option value="large-1" selected="">/);
  // The Runtime's adoption state is stated per row, not derived by the page.
  assert.match(html, new RegExp(`data-testid="chat-board-status-default"[^>]*>${literal(i18next.t("settings.board.pendingGoals", { count: 2 }))}`));
  // An inherited row shows the default's value and has no reset; an own row has one.
  assert.match(html, /data-testid="chat-board-row-cornellNote" data-inherited="true"/);
  assert.match(html, /data-testid="chat-board-model-cornellNote"[^>]*>[\s\S]*?<option value="large-1" selected="">/);
  assert.ok(!html.includes('data-testid="chat-board-reset-cornellNote"'));
  assert.match(html, /data-testid="chat-board-reset-primeRoot"/);
  assert.match(html, /data-testid="chat-board-depth-primeRoot.reportWriter"[^>]*>[\s\S]*?<option value="high" selected="">/);
  // A connection without a credential is not offered at all; only ones that can serve now are.
  assert.ok(!html.includes('value="telomi-idle"'), "an unconfigured connection is not listed");
  assert.match(html, /<option value="telomi-test"/);
  // Inheritance is shown, never explained: no override or inherit wording, no checkbox.
  for (const removed of ["显式覆盖", "继承默认", "使用显式覆盖", "override", 'type="checkbox"']) {
    assert.ok(!html.includes(removed), `${removed} must not render`);
  }
  assert.ok(!html.includes("{{"), "no message placeholder may reach the page");
});

test("the search Provider panel states what the Runtime reports and never a secret", () => {
  const provider: SearchCredentialProviderStatus = {
    id: "tavily",
    sourceIds: ["general_web_tavily"],
    status: "pending",
    pendingReason: "a separately hosted Source Service at http://source.internal authenticates with its own configuration",
    fields: [{
      id: "tavily_api_key",
      env: "SOURCE_SERVICE_TAVILY_API_KEY",
      optional: false,
      configured: true,
      keyHint: "tvly…0001",
      provenance: "imported",
      pendingConfigured: true,
      deleted: false,
      legacyEnvSet: ["TAVILY_API_KEY"],
      locationEnv: null,
      locationError: null,
    }],
  };
  const source: SourceEntry = {
    id: "tavily", auth: "api_key", sourceIds: ["general_web_tavily"],
    status: { state: "error", checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(), reason: "HTTP 401" },
    enabled: true,
    credential: provider,
  };
  const html = renderToStaticMarkup(<SourceRow source={source} onChanged={() => undefined} />);
  // The verified state comes first, with when it was established and why it failed.
  assert.match(html, /data-testid="source-status-dot" data-state="error"/);
  assert.match(html, /data-testid="source-reason-tavily"[^>]*>HTTP 401</);
  assert.match(html, /data-testid="source-verify-tavily"/);
  // Which credential the Source Service reads, and only a hint of it.
  assert.match(html, /SOURCE_SERVICE_TAVILY_API_KEY/);
  assert.match(html, /tvly…0001/);
  // Prepared and not-in-effect are distinct facts, and neither reads as a completed change.
  assert.match(html, /data-testid="search-provider-pending-tavily"/);
  // A prepared credential can be activated later without typing it again.
  assert.match(html, /data-testid="search-provider-apply-pending-tavily"/);
  assert.match(html, /data-testid="search-provider-not-adopted-tavily"/);
  assert.match(html, /source\.internal/);
  // Where the credential came from is stated rather than presented as a deliberate choice.
  assert.match(html, /(从环境变量导入|Imported from the environment)/);
  // A legacy variable is named as no longer deciding anything, rather than silently ignored.
  assert.match(html, /TAVILY_API_KEY/);
  assert.ok(!html.includes("{{"), "no message placeholder may reach the page");
});

test("a kept draft shows on the board and offers to retry or discard, while the active selection still resolves", () => {
  const active = { default: { connection: "telomi-audio", model: "" }, cleanupEnabled: false, cleanupInstructions: "" };
  const state: SpeechConfigurationResponse = {
    active,
    pending: { ...active, default: { connection: "cloud-stt", model: "whisper-1" } },
    effective: { recognition: { connection: "telomi-audio", model: "", baseUrl: "" }, local: { connection: "telomi-audio", model: "", baseUrl: "" }, cleanupModel: null, cleanupEnabled: false, cleanupInstructions: "" },
    sources: { recognition: "default", local: "default", cleanupModel: "default" },
    consumers: [{ id: "recognition", status: "active", boundary: "next-recording" }, { id: "local", status: "active", boundary: "next-recording" }, { id: "cleanupModel", status: "unavailable", boundary: "next-recording" }],
    status: "saved", boundary: "next-recording",
  };
  const rows = sttBoardRows(state);
  assert.deepEqual(rows[0]?.own, { connection: "cloud-stt", model: "whisper-1" }, "the draft is what the user sees and edits");
  assert.deepEqual(rows[0]?.resolved, active.default, "what actually serves is still the active selection");
  const html = renderToStaticMarkup(<PendingConfigNotice busy={false} onApply={() => {}} onDiscard={() => {}} testId="stt-pending" />);
  assert.match(html, /data-testid="stt-pending-apply"/);
  assert.match(html, /data-testid="stt-pending-discard"/);
  assert.ok(html.includes(i18next.t("settings.board.savedForLater")));
});

test("the embedding board states each index's serving selection, rebuild progress and failure reason", () => {
  const state: EmbeddingResponse = {
    active: { default: { connection: "openrouter", model: "qwen/qwen3-embedding-0.6b" }, memory: { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" } },
    pending: null, target: null, status: "rebuilding",
    effective: { wiki: { connection: "openrouter", model: "qwen/qwen3-embedding-0.6b", baseUrl: "" }, memory: { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", baseUrl: "" } },
    sources: { wiki: "default", memory: "override" },
    consumers: [
      { id: "wiki", status: "rebuilding", serving: { connection: "openrouter", model: "qwen/qwen3-embedding-0.6b" }, progress: { done: 12, total: 40 }, estimate: { units: 40, characters: 51200 } },
      { id: "memory", status: "failed", serving: { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" }, error: "model could not be loaded" },
    ],
  };
  const rows = embeddingBoardRows(state);
  assert.equal(rows[1]?.own, null);
  assert.deepEqual(rows[1]?.resolved, { connection: "openrouter", model: "qwen/qwen3-embedding-0.6b" });
  assert.match(rows[1]?.status?.text ?? "", /12 \/ 40|12 of 40/);
  assert.equal(rows[1]?.status?.tone, "busy");
  assert.deepEqual(rows[2]?.own, { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" });
  assert.deepEqual(rows[2]?.status, { text: "model could not be loaded", tone: "error" });
  for (const row of rows) assert.ok(!(row.status?.text ?? "").includes("{{"), "no message placeholder may reach the page");

  // Staged edits show in the rows but only the indexes whose model actually changes are rebuilt.
  const draft = { ...state.active, default: { connection: "openai", model: "text-embedding-3-small" } };
  assert.deepEqual(embeddingChanges(state.active, draft), ["wiki"], "memory keeps its own selection, so only wiki rebuilds");
  assert.deepEqual(embeddingChanges(state.active, { ...state.active, memory: { connection: "openrouter", model: "qwen/qwen3-embedding-0.6b" } }), ["memory"]);
  assert.deepEqual(embeddingChanges(state.active, { default: state.active.default, memory: state.active.memory }), []);
  const stagedRows = embeddingBoardRows(state, draft);
  assert.deepEqual(stagedRows[0]?.own, draft.default);
  assert.deepEqual(stagedRows[1]?.resolved, draft.default, "an inherited row previews the staged default");
  assert.equal(stagedRows[1]?.status?.tone, "busy", "status keeps stating the server's side");
});

test("with no embedding model chosen the board preselects nothing, and a default reaches every index that has no own model", () => {
  const state: EmbeddingResponse = {
    active: {}, pending: null, target: null, status: "active",
    effective: { wiki: null, memory: null }, sources: { wiki: null, memory: null },
    consumers: [{ id: "wiki", status: "unconfigured", serving: null }, { id: "memory", status: "unconfigured", serving: null }],
  };
  const rows = embeddingBoardRows(state);
  assert.deepEqual(rows.map((row) => [row.own, row.resolved]), [[null, null], [null, null], [null, null]], "no placeholder model on any row");
  assert.deepEqual(rows.slice(1).map((row) => row.status), [1, 2].map(() => ({ text: i18next.t("settings.embedding.status.unconfigured"), tone: "pending" })));
  const html = renderToStaticMarkup(<AssignmentBoard capability="embedding" rows={rows} connections={CONNECTIONS} testId="embedding-board" onChange={() => undefined} />);
  assert.match(html, /data-testid="embedding-board-connection-default"[^>]*><option value="" selected="">/u, "the default row asks for a choice");

  const ollama = { connection: "ollama", model: "embeddinggemma:latest" };
  const chosen = embeddingDraft(state.active, "default", ollama);
  assert.deepEqual(chosen, { default: ollama });
  assert.deepEqual(embeddingChanges(state.active, chosen), ["wiki", "memory"]);
  assert.deepEqual(embeddingBoardRows(state, chosen).slice(1).map((row) => row.resolved), [ollama, ollama]);
  const local = { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" };
  const own = embeddingDraft(chosen, "memory", local);
  assert.deepEqual(embeddingDraft(own, "default", { connection: "openrouter", model: "baai/bge-m3" }).memory, local, "a Memory model the user chose stays its own");
  assert.deepEqual(embeddingDraft(own, "memory", null), chosen, "the reset button makes Memory follow the default");
});

test("a speech row edit waits on the page until the user saves it, and every row says where it stands", () => {
  const voice = (over: Partial<AudioGenerationSelection> = {}): AudioGenerationSelection => ({ connection: "telomi-audio", model: "qwen-tts", voice: "longanhuan_v3.6", rate: 1, ...over });
  const active: AudioGenerationConfiguration = { default: voice(), podcast: voice({ voice: "ryan" }) };
  const state: AudioGenerationResponse = {
    active,
    pending: null,
    effective: { playback: { ...voice(), baseUrl: "" }, local: { ...voice(), baseUrl: "" }, podcast: { ...voice({ voice: "ryan" }), baseUrl: "" } },
    sources: { playback: "default", local: "default", podcast: "override" },
    consumers: [{ id: "playback", status: "active" }, { id: "local", status: "pending" }, { id: "podcast", status: "active" }],
    connections: [], status: "active",
  };

  // Nothing edited: the rows only repeat what the Runtime reports about what speaks now.
  assert.deepEqual(ttsBoardRows(state).map((row) => row.status?.text), [
    // A waiting row names its own boundary: the local Worker converses, it does not play back.
    undefined, i18next.t("settings.board.active"), i18next.t("settings.board.nextUse.local"), i18next.t("settings.board.active"),
  ]);

  // An edit produces a draft this page holds, so a mis-picked voice sends nothing and changes nothing.
  const changed = generationDraft(active, "default", voice({ voice: "loongjohn" }));
  assert.deepEqual(active.default, voice(), "the edit never touches what is saved");
  assert.deepEqual(generationChanges(active, changed), ["default", "playback", "local"], "the podcast keeps its own voice");
  const staged = ttsBoardRows(state, changed);
  assert.equal(staged[0]?.status?.text, i18next.t("settings.board.unsaved"));
  assert.deepEqual(staged[1]?.resolved, changed.default, "an inherited row previews the unsaved default");
  assert.equal(staged[1]?.status?.text, i18next.t("settings.board.unsaved"), "a row the edit reaches no longer reads as active");
  assert.equal(staged[3]?.status?.text, i18next.t("settings.board.active"), "the podcast still speaks what it speaks");

  // Edits accumulate: a rate, a row of its own and a reset each keep what the others changed.
  const cumulative = generationDraft(generationDraft(generationDraft(changed, "podcast", voice({ rate: 1.5 })), "local", voice({ voice: "ryan" })), "podcast", null);
  assert.equal(cumulative.default.voice, "loongjohn", "the first edit survives the later ones");
  assert.deepEqual(cumulative.local, voice({ voice: "ryan" }));
  assert.equal(cumulative.podcast, undefined, "a reset row follows the draft default again");
  assert.deepEqual(generationChanges(active, cumulative), ["default", "playback", "local", "podcast"]);

  // Unsaved edits offer all three answers; editing alone takes none of them.
  const notice = renderToStaticMarkup(<UnsavedChangesNotice busy={false} onSave={() => {}} onApply={() => {}} onDiscard={() => {}} testId="tts-draft" />);
  for (const action of ["save", "apply", "discard"]) assert.match(notice, new RegExp(`data-testid="tts-draft-${action}"`));
  assert.ok(notice.includes(i18next.t("settings.board.unsavedHint")));

  // Saved for later, including a draft a refused apply left behind: the board shows and corrects the
  // draft, the active selection still serves, and the draft is not announced as a change that landed.
  for (const status of ["saved", "failed"] as const) {
    const rows = ttsBoardRows({ ...state, pending: changed, status });
    assert.deepEqual(rows[0]?.own, changed.default, "the saved draft is what the user sees and edits");
    assert.equal(rows[0]?.status?.text, i18next.t("settings.board.savedNotApplied"));
    assert.equal(rows[3]?.status?.text, i18next.t("settings.board.active"), "an untouched row keeps the Runtime's word");
  }
  assert.deepEqual(generationChanges(changed, generationDraft(changed, "default", voice())), ["default", "playback", "local"], "correcting a saved draft is unsaved again");
  const kept = renderToStaticMarkup(<PendingConfigNotice busy={false} onApply={() => {}} onDiscard={() => {}} testId="tts-pending" hint={i18next.t("settings.board.savedPending")} />);
  assert.match(kept, /data-testid="tts-pending-apply"/);
  assert.ok(kept.includes(i18next.t("settings.board.savedPending")), "a draft saved on purpose does not read as a failed attempt");
  assert.ok(!kept.includes("{{"), "no message placeholder may reach the page");

  // A row still waiting for its model, the state a connection change leaves behind, is part of the
  // unsaved edits: it reads as unsaved and can be dropped, but nothing is saved while it is open.
  const waiting = ttsBoardRows(state, undefined, ["default"]);
  assert.equal(waiting[0]?.status?.text, i18next.t("settings.board.unsaved"));
  assert.equal(waiting[3]?.status?.text, i18next.t("settings.board.active"), "a row the user has not touched is unaffected");
  const blocked = renderToStaticMarkup(<UnsavedChangesNotice busy={false} incomplete onSave={() => {}} onApply={() => {}} onDiscard={() => {}} testId="tts-draft" />);
  const button = (html: string, id: string) => {
    const tag = html.match(new RegExp(`<button[^>]*data-testid="${id}"`))?.[0];
    assert.ok(tag, `${id} must render`);
    return tag;
  };
  for (const action of ["save", "apply"]) assert.match(button(blocked, `tts-draft-${action}`), /disabled=""/, `${action} waits for a complete selection`);
  assert.doesNotMatch(button(blocked, "tts-draft-discard"), /disabled=""/, "a half-finished edit can always be dropped");
  assert.ok(blocked.includes(i18next.t("settings.board.unsavedIncomplete")), "the page says what the row is missing");
  for (const action of ["save", "apply"]) assert.doesNotMatch(button(notice, `tts-draft-${action}`), /disabled=""/, `${action} is offered once every row is complete`);
});

test("a source without a managed credential shows only its verified state", () => {
  const source: SourceEntry = {
    id: "youtube", auth: "browser_session", sourceIds: ["youtube"],
    status: { state: "needs_login", checkedAt: new Date().toISOString(), code: "no_login" },
    enabled: true,
    credential: null,
  };
  const html = renderToStaticMarkup(<SourceRow source={source} onChanged={() => undefined} />);
  assert.match(html, /data-state="needs_login"/);
  assert.match(html, /(需要登录|Needs login)/);
  assert.match(html, /(没有找到登录态|No login found)/);
  assert.ok(!html.includes("search-provider-edit-youtube"), "no credential controls for a browser-only source");
  // The login is repaired from the group's single browser login entry, not per row; every
  // checkable source can be switched off.
  assert.ok(!html.includes("source-sync-youtube") && !html.includes("source-login-youtube"), "no per-source login control");
  assert.match(html, /data-testid="source-enabled-youtube"[^>]*checked/);
  assert.ok(!html.includes("{{"));

  const off = renderToStaticMarkup(<SourceRow source={{ ...source, enabled: false }} onChanged={() => undefined} />);
  assert.match(off, /data-state="disabled"/);
  assert.match(off, /(已关闭|Switched off)/);
});

test("the search Provider panel explains a cookie file that could not be imported", () => {
  const provider: SearchCredentialProviderStatus = {
    id: "twitter", sourceIds: ["twitter"], status: "unconfigured", pendingReason: null,
    fields: [{ id: "twitter_cookie", env: "SOURCE_SERVICE_TWITTER_COOKIE", optional: false,
      configured: false, keyHint: null, provenance: null, pendingConfigured: false,
      deleted: false, legacyEnvSet: [], locationEnv: "X_COOKIE_FILE",
      locationError: "credential file could not be read as UTF-8" }],
  };
  const source: SourceEntry = { id: "twitter", auth: "browser_session", sourceIds: ["twitter"], status: null, enabled: true, credential: provider };
  const html = renderToStaticMarkup(<SourceRow source={source} onChanged={() => undefined} />);
  assert.match(html, /data-testid="source-status-dot" data-state="unchecked"/);
  // The browser holds the login, so no key is typed here; only the file it would fall back to is named.
  assert.ok(!html.includes("search-provider-edit-twitter"), "a browser-backed source has no key input");
  assert.match(html, /data-testid="source-override-twitter"/);
  assert.match(html, /credential file could not be read as UTF-8/);
  assert.ok(!html.includes("{{"));
});

test("a connection test starts with no model chosen and waits for the user to pick one", () => {
  // No model is selected on the user's behalf: a retired catalog entry would otherwise be tested
  // and validated without anyone choosing it.
  const cloud = renderToStaticMarkup(<CloudProviderRow id="openai-codex" capability="chat"
    entry={{ envName: null, envSet: false, authEntry: { configured: true, type: "oauth", keyHint: null }, pendingEntry: null }}
    provider={{ id: "openai-codex", models: [{ id: "model-a", name: "A" }, { id: "model-b", name: "B" }] }}
    oauthInfo={undefined} onChanged={() => undefined} />);
  const cloudSelect = cloud.match(/<select[^>]*data-testid="cloud-provider-openai-codex-test-model"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(cloudSelect, "the row offers the catalog to choose from");
  assert.match(cloudSelect[1], new RegExp(`<option value=""[^>]*>${literal(i18next.t("settings.page.pickTestModel"))}</option>`));
  assert.doesNotMatch(cloudSelect[1], /<option value="model-[^"]+"[^>]*selected/, "no catalog model is preselected");
  const cloudTest = cloud.match(new RegExp(`<button[^>]*>(?:<[^>]*>)*${literal(i18next.t("settings.page.test"))}</button>`));
  assert.ok(cloudTest);
  assert.match(cloudTest[0], /disabled=""/, "testing waits for a chosen model");
  assert.match(cloudTest[0], new RegExp(literal(i18next.t("settings.page.pickTestModelFirst"))));

  const custom = renderToStaticMarkup(<CustomProviderRow capability="chat" onChanged={() => undefined}
    provider={{ id: "local", api: "openai-completions", baseUrl: "http://127.0.0.1:1", hasApiKey: false, apiKeyHint: null, models: [{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }] }} />);
  const customSelect = custom.match(/<select[^>]*data-testid="custom-provider-local-test-model"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(customSelect);
  assert.match(customSelect[1], new RegExp(`<option value=""[^>]*>${literal(i18next.t("settings.page.pickTestModel"))}</option>`));
  assert.doesNotMatch(customSelect[1], /<option value="m[^"]+"[^>]*selected/);
  const customTest = custom.match(new RegExp(`<button[^>]*>(?:<[^>]*>)*${literal(i18next.t("settings.page.test"))}</button>`));
  assert.ok(customTest);
  assert.match(customTest[0], /disabled=""/);
});

test("the chat board says when no default model is set and when the Provider rejected it", () => {
  const base = { defaultProvider: null, defaultModel: null, defaultThinkingLevel: null, enabledModels: [], providerFallbackModels: [], taskModels: {}, stageThinkingLevels: {}, taskModelRoles: [], providers: [], thinkingLevels: [] };
  const unset = chatBoardRows({ ...base, consumers: [{ id: "mainAgent", effectiveModel: "", status: "active", pendingCount: 0, stages: [] }] });
  assert.deepEqual(unset[0]?.status, { text: i18next.t("settings.board.noDefault"), tone: "error" });
  const rejected = chatBoardRows({ ...base, defaultProvider: "openai-codex", defaultModel: "retired",
    consumers: [{ id: "mainAgent", effectiveModel: "openai-codex/retired", status: "failed", error: "Codex error: retired is not supported", pendingCount: 0, stages: [] }] });
  assert.equal(rejected[0]?.status?.tone, "error");
  assert.match(rejected[0]?.status?.text ?? "", /retired is not supported/);
  assert.notEqual(rejected[0]?.status?.text, i18next.t("settings.board.active"));
});

test("a connectivity verdict reads as product copy and keeps the upstream diagnostic", () => {
  const upstream = "Codex error: The 'probe-mini' model is not supported when using Codex with a ChatGPT account.";
  const passed = connectionTestFeedback({ ok: true, durationMs: 2515 }, "probe-terra");
  assert.equal(passed.kind, "ok");
  assert.equal(passed.text, i18next.t("settings.connections.testOkModel", { ms: 2515, model: "probe-terra" }));
  assert.ok(passed.text.includes("probe-terra"), "the verdict names the model that was actually tested");
  const failed = connectionTestFeedback({ ok: false, error: upstream }, "probe-mini");
  assert.equal(failed.kind, "err");
  assert.equal(failed.text, i18next.t("settings.connections.testFailed", { error: upstream }));
  assert.ok(failed.text.includes(upstream), "the upstream diagnostic stays readable in full");
  assert.equal(
    connectionTestFeedback({ ok: false }, "probe-mini").text,
    i18next.t("settings.connections.testFailed", { error: i18next.t("settings.codexaccountsinline.unknownError") }),
    "a failure with no detail still reads as copy, never as a bare status code",
  );
});

test("an account status never reaches the user as a raw enum value", () => {
  const account = (status: ProviderAccountSummary["status"]): ProviderAccountSummary => ({
    id: "a", label: "已导入", type: "oauth", status, createdAt: 0, isActive: true, chainPosition: 0,
  });
  assert.equal(renderStatus(account("ok"), 0).text, i18next.t("common.available"));
  assert.equal(renderStatus(account("auth-error"), 0).text, i18next.t("settings.codexaccountsinline.authenticationFailed"));
  for (const status of ["unknown", "expired", "rate-limited"] as const) {
    assert.doesNotMatch(renderStatus(account(status), 0).text, /^[a-z-]+$/u, `${status} is shown as copy, not as its enum value`);
  }
});

test("a capability test button is disabled until a connection and model are chosen", () => {
  const empty = renderToStaticMarkup(<ConnectionTestButton capability="embedding" connection="" model="" testId="probe" />);
  assert.match(empty, /data-testid="probe"/);
  assert.match(empty, /<button[^>]* disabled=""/);
  const ready = renderToStaticMarkup(<ConnectionTestButton capability="tts" connection="openrouter" model="x-ai/grok-voice-tts-1.0" voice="eve" />);
  assert.doesNotMatch(ready, /<button[^>]* disabled=""/);
  assert.match(ready, new RegExp(`>${literal(i18next.t("settings.page.test"))}<`));
});

test("each capability page offers to add a connection pinned to that capability", () => {
  const markup = renderToStaticMarkup(<ConnectionsSection capability="embedding" />);
  assert.match(markup, /data-testid="connections-embedding"/);
  assert.match(markup, /data-testid="add-connection-embedding"/);
  assert.match(markup, new RegExp(literal(i18next.t("settings.connections.addConnection"))));
  assert.doesNotMatch(markup, /custom-provider-form-capability/, "the form opens on demand");
  // Only the chat page can add a built-in cloud provider.
  assert.doesNotMatch(markup, /add-connection-cloud/);
});

test("the model field lists available models and keeps an unlisted value", () => {
  const models = [{ id: "x-ai/grok-voice-tts-1.0", name: "Grok Voice" }];
  const listed = renderToStaticMarkup(<ListedInput options={models} value="x-ai/grok-voice-tts-1.0" listId="m" onChange={() => undefined} />);
  assert.match(listed, /<select[^>]*data-testid="m"/);
  assert.match(listed, /Grok Voice · x-ai\/grok-voice-tts-1.0/);
  assert.match(listed, new RegExp(literal(i18next.t("settings.connections.manual"))));
  const stale = renderToStaticMarkup(<ListedInput options={models} value="Qwen3-TTS" listId="m" onChange={() => undefined} />);
  assert.match(stale, new RegExp(`<option value="Qwen3-TTS" selected="">Qwen3-TTS · ${literal(i18next.t("settings.connections.unlisted"))}`));
  const bare = renderToStaticMarkup(<ListedInput options={[]} value="" listId="m" onChange={() => undefined} />);
  assert.match(bare, /<input[^>]*data-testid="m-manual"/, "a connection without models for the capability takes free text");
});

test("every speech row previews its own selection and lists its model's voices", () => {
  const speech = { id: "telomi-audio", kind: "custom", status: "connected", auth: null, keyHint: null, capabilities: ["tts"], usedBy: [],
    models: { chat: [], embedding: [], tts: [{ id: "qwen-tts", supportedVoices: ["vivian", "ryan"] }], stt: [] } } as unknown as ConnectionSummary;
  const selection = { connection: "telomi-audio", model: "qwen-tts", voice: "vivian", rate: 1 };
  const rows: BoardRow[] = [
    { id: "default", label: "Default", own: selection, resolved: selection },
    { id: "podcast", label: "Podcast", own: null, resolved: selection },
    { id: "local", label: "Local", own: { ...selection, voice: "" }, resolved: { ...selection, voice: "" } },
  ];
  const html = renderToStaticMarkup(<AssignmentBoard capability="tts" rows={rows} connections={[speech]} columns={["voice", "rate"]} testId="tts-board" onChange={() => undefined}
    action={(row, shown) => <VoicePreviewButton selection={shown} text="hi" testId={`tts-board-preview-${row.id}`} />} />);
  for (const id of ["default", "podcast"]) {
    assert.match(html, new RegExp(`data-testid="tts-board-preview-${id}"><button[^>]*>.*?${literal(i18next.t("settings.tts.preview"))}</button>`), `the ${id} row previews, whether its selection is its own or inherited`);
  }
  assert.doesNotMatch(html, /data-testid="tts-board-test-/, "the speech board previews instead of running the connection test");
  assert.match(html, /<option value="ryan">ryan<\/option>/, "a row lists the voices of its model");
  assert.match(html, new RegExp(`data-testid="tts-board-voice-local"[^>]*><option value="" selected="">${literal(i18next.t("settings.audioGeneration.serverDefault"))}</option>`), "an empty voice is the server's default, not a missing choice");

  // Choosing a model that lists voices keeps the voice only if it is listed; otherwise the server's default speaks.
  assert.equal(keptVoice("af_heart", ["af_heart", "am_adam"]), "af_heart");
  assert.equal(keptVoice("vivian", ["af_heart", "am_adam"]), "");
  // A model that lists nothing, such as one being typed by hand, keeps the typed voice.
  assert.equal(keptVoice("vivian", []), "vivian");

  // A background save leaves every cell usable and shows nothing while it is quick; a blocking one disables them and says it is saving.
  const background = renderToStaticMarkup(<AssignmentBoard capability="tts" rows={rows} connections={[speech]} columns={["voice", "rate"]} testId="tts-board" saving onChange={() => undefined} />);
  assert.doesNotMatch(background, /disabled=""/, "cells stay usable while a change applies in the background");
  assert.doesNotMatch(background, /data-testid="tts-board-saving"/);
  const blocking = renderToStaticMarkup(<AssignmentBoard capability="tts" rows={rows} connections={[speech]} columns={["voice", "rate"]} testId="tts-board" busy onChange={() => undefined} />);
  assert.match(blocking, /<input[^>]*disabled=""[^>]*data-testid="tts-board-rate-default"/);
  // Every cell waits for the save to settle, the model among them, so no edit is built on what is being replaced.
  assert.match(blocking, /<select[^>]*disabled=""[^>]*data-testid="tts-board-model-default"/);
  assert.match(blocking, /data-testid="tts-board-saving"/);

  // Listed voices, plus a manual entry for the rest.
  const voices = renderToStaticMarkup(<ListedInput options={[{ id: "vivian" }]} value="vivian" listId="audio-voices-default" onChange={() => undefined} />);
  assert.match(voices, /<option value="vivian" selected="">vivian<\/option>/);
  assert.match(voices, new RegExp(literal(i18next.t("settings.connections.manual"))));
});

test("a connection row counts its models as copy, so one model does not read as several", () => {
  const html = renderToStaticMarkup(<CustomProviderRow capability="tts" onChanged={() => undefined}
    provider={{ id: "telomi-audio", baseUrl: "http://127.0.0.1:9595/v1", api: "openai-completions", hasApiKey: false, apiKeyHint: null, compat: null, models: [{ id: "qwen-tts", capabilities: ["tts"] }] }} />);
  assert.ok(html.includes(i18next.t("settings.page.countModels", { count: 1 })), "the count reaches the page through the message, not as a bare number");
  assert.ok(!html.includes("{{"), "no message placeholder may reach the page");
});

test("a connection row counts every model it serves and names its users as the model tables do", () => {
  const summary: ConnectionSummary = {
    id: "telomi-audio", kind: "custom", status: "connected", auth: null, keyHint: null, capabilities: ["tts", "stt"],
    models: { chat: [], embedding: [], tts: [{ id: "qwen-tts" }], stt: [{ id: "qwen-asr" }] },
    usedBy: [
      ...(["playback", "local", "podcast"] as const).map((consumer) => ({ capability: "tts" as const, consumer, connection: "telomi-audio", model: "qwen-tts" })),
      ...(["recognition", "local"] as const).map((consumer) => ({ capability: "stt" as const, consumer, connection: "telomi-audio", model: "qwen-asr" })),
    ],
  };
  const html = renderToStaticMarkup(<CustomProviderRow capability="tts" summary={summary} onChanged={() => undefined}
    provider={{ id: "telomi-audio", baseUrl: "http://127.0.0.1:9595/v1", api: "openai-completions", hasApiKey: false, apiKeyHint: null, compat: null, models: [{ id: "qwen-tts", capabilities: ["tts"] }, { id: "qwen-asr", capabilities: ["stt"] }] }} />);
  assert.ok(html.includes(i18next.t("settings.page.countModels", { count: 2 })), "the header counts the recognition model too, not only this page's");
  for (const id of ["settings.audioGeneration.playback", "settings.audioGeneration.local", "settings.audioGeneration.podcast", "settings.speech.recognition", "settings.speech.local"] as const) {
    assert.ok(html.includes(i18next.t(id)), `${id} is named as its model table names it`);
  }
  assert.doesNotMatch(html, /playback|podcast|recognition|, local/, "no internal consumer id reaches the page");

  const chat = renderToStaticMarkup(<ConnectionBadges summary={{ ...CONNECTIONS[0], usedBy: [
    { capability: "chat", consumer: "default", connection: "telomi-test", model: "large-1" },
    { capability: "chat", consumer: "wikiMaintainer", connection: "telomi-test", model: "small-1" },
    { capability: "embedding", consumer: "memory", connection: "telomi-test", model: "embed-1" },
  ] }} />);
  for (const label of [i18next.t("settings.board.default"), "Wiki Curator", i18next.t("settings.embedding.memory")]) assert.ok(chat.includes(label), label);
  assert.doesNotMatch(chat, /wikiMaintainer|· memory/);
});

test("a saved key waits to be activated with a test model the user picks, and says so", () => {
  const html = renderToStaticMarkup(<CloudProviderRow id="deepseek" capability="chat"
    entry={{ id: "deepseek", envName: null, envSet: false, authEntry: { configured: false, type: null, keyHint: null }, pendingEntry: { configured: true, type: "api_key", keyHint: null } }}
    provider={{ id: "deepseek", models: [{ id: "model-a", name: "A" }] }}
    oauthInfo={undefined} onChanged={() => undefined} />);
  const callout = html.match(/data-testid="cloud-provider-pending-deepseek"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(callout);
  assert.ok(callout[1].includes(i18next.t("settings.page.credentialSavedPickTestModel")), "the callout asks for the test model");
  const activate = callout[1].match(/<button[^>]*data-testid="cloud-provider-apply-pending-deepseek"[^>]*>/);
  assert.ok(activate);
  assert.match(activate[0], /disabled=""/, "activation waits for a picked model instead of failing on click");
  assert.match(activate[0], new RegExp(`title="${literal(i18next.t("settings.page.pickTestModelFirst"))}"`));
});

test("a connection's discovered models are listed under the capability each one serves", () => {
  const html = renderToStaticMarkup(<CustomProviderForm mode="edit" onCancel={() => undefined} onSaved={() => undefined}
    initial={{
      id: "speaches", baseUrl: "http://192.168.1.9:8000/v1", api: "openai-completions", hasApiKey: false, apiKeyHint: null, compat: null,
      models: [
        { id: "gpt-local", capabilities: ["chat"] },
        { id: "kokoro", capabilities: ["tts"], supportedVoices: ["alloy", "nova"] },
        { id: "whisper-1", capabilities: ["stt"] },
        { id: "bge-m3", capabilities: ["embedding"] },
        { id: "cohere/rerank-v3", capabilities: [] },
      ],
    }} />);
  for (const capability of ["chat", "embedding", "tts", "stt", "other"]) {
    assert.match(html, new RegExp(`data-testid="custom-provider-models-${capability}"`), `${capability} models are grouped on their own`);
  }
  assert.match(html, new RegExp(literal(i18next.t("settings.page.countVoices", { count: 2 }))), "a TTS model carries its voices");
});

test("a connection edited from a capability page shows only that capability's models", () => {
  const models = [
    { id: "gpt-local", capabilities: ["chat" as const] },
    { id: "kokoro", capabilities: ["tts" as const], supportedVoices: ["alloy"] },
    { id: "whisper-1", capabilities: ["stt" as const] },
    { id: "bge-m3", capabilities: ["embedding" as const] },
    { id: "cohere/rerank-v3", capabilities: [] },
  ];
  const initial = { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" as const, hasApiKey: true, apiKeyHint: null, compat: null, models };
  const shown = (viewCapability: "chat" | "embedding" | "tts" | "stt") => renderToStaticMarkup(
    <CustomProviderForm mode="edit" initial={initial} viewCapability={viewCapability} onCancel={() => undefined} onSaved={() => undefined} />);
  for (const [viewCapability, id] of [["chat", "gpt-local"], ["embedding", "bge-m3"], ["tts", "kokoro"], ["stt", "whisper-1"]] as const) {
    const html = shown(viewCapability);
    const groups = [...html.matchAll(/data-testid="custom-provider-models-([a-z]+)"/g)].map((match) => match[1]);
    assert.deepEqual(groups, [viewCapability], `${viewCapability} page lists its own group only`);
    for (const other of models.filter((model) => model.id !== id)) assert.doesNotMatch(html, new RegExp(`title="${other.id}"`), `${other.id} is hidden on the ${viewCapability} page`);
    assert.ok(html.includes(i18next.t("settings.page.modelsCount", { count: 1 })), "the count is this page's models");
    assert.equal(html.includes('data-testid="custom-provider-form-probe-model"'), viewCapability === "chat", "the chat probe model is offered only among chat models");
  }
});

test("the Ollama preset offers detection and a pull field, and appears where Ollama can serve", () => {
  const form = renderToStaticMarkup(<OllamaConnectionForm capability="embedding" initial={null} onCancel={() => undefined} onSaved={() => undefined} />);
  assert.match(form, /data-testid="ollama-base-url"[^>]*value="http:\/\/127\.0\.0\.1:11434\/v1"/);
  assert.match(form, /data-testid="ollama-detect"/);
  assert.match(form, /data-testid="ollama-pull-name"/);
  assert.match(form, /disabled="" data-testid="ollama-save"/, "nothing to save before detection answers");
  assert.ok(!form.includes("{{"), "no message placeholder may reach the page");
  assert.match(renderToStaticMarkup(<ConnectionsSection capability="embedding" />), /data-testid="add-connection-ollama"/);
  assert.doesNotMatch(renderToStaticMarkup(<ConnectionsSection capability="tts" />), /add-connection-ollama/, "Ollama serves no speech capability");
});

test("the local runtime panel words each model's install step in the interface language", () => {
  const tts = i18next.t("settings.voicelocalruntimesettings.ttsModel");
  const asr = i18next.t("settings.voicelocalruntimesettings.asrModel");
  assert.equal(localRuntimeDetail("fetching pinned local TTS model asset 4/12"),
    i18next.t("settings.voicelocalruntimesettings.fetchingModelFile", { model: tts, current: "4", total: "12" }));
  assert.equal(localRuntimeDetail("validating pinned local ASR model"),
    i18next.t("settings.voicelocalruntimesettings.verifyingModel", { model: asr }));
  assert.equal(localRuntimeDetail("local TTS model installation failed validation or download"),
    i18next.t("settings.voicelocalruntimesettings.modelInstallFailed", { model: tts }));
  assert.equal(localRuntimeDetail("local audio runtime is ready"), i18next.t("common.localAudioRuntimeIsReady"));
  assert.equal(localRuntimeDetail("insufficient disk space for local TTS model: need 1 bytes"), "insufficient disk space for local TTS model: need 1 bytes",
    "a step the panel does not know keeps the service's own words");
});

test("with no speech model chosen the read aloud and recognition boards preselect nothing", () => {
  const tts: AudioGenerationResponse = {
    active: {}, pending: null, status: "active",
    effective: { playback: null, local: null, podcast: null }, sources: { playback: null, local: null, podcast: null },
    consumers: [{ id: "playback", status: "unconfigured" }, { id: "local", status: "unconfigured" }, { id: "podcast", status: "unconfigured" }],
  };
  const ttsRows = ttsBoardRows(tts);
  assert.deepEqual(ttsRows.map((row) => [row.own, row.resolved]), [[null, null], [null, null], [null, null], [null, null]], "no telomi-audio placeholder on any row");
  assert.deepEqual(ttsRows.slice(1).map((row) => row.status?.text), [1, 2, 3].map(() => i18next.t("settings.board.noModelChosen")));

  const stt: SpeechConfigurationResponse = {
    active: { cleanupEnabled: false, cleanupInstructions: "" }, pending: null, status: "active", boundary: "next-recording",
    effective: { cleanupModel: null, cleanupEnabled: false, cleanupInstructions: "" },
    sources: { recognition: "default", local: "default", cleanupModel: "default" },
    consumers: [{ id: "recognition", status: "unconfigured", boundary: "next-recording" }, { id: "local", status: "unconfigured", boundary: "next-recording" }, { id: "cleanupModel", status: "unavailable", boundary: "next-recording" }],
  };
  const sttRows = sttBoardRows(stt);
  assert.deepEqual(sttRows.slice(0, 3).map((row) => [row.own, row.resolved]), [[null, null], [null, null], [null, null]]);
  assert.deepEqual(sttRows.slice(1, 3).map((row) => row.status?.text), [1, 2].map(() => i18next.t("settings.board.noModelChosen")));
});
