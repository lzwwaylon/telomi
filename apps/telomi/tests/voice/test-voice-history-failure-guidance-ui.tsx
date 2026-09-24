import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  classifyVoiceTranscriptionFailure,
  getVoiceHistoryFailureGuidance,
} from "../../shared/voice-history-failure.js";
import { VoiceHistoryFailureGuidanceContent } from "../../web/src/features/settings/VoiceHistorySettings.js";
import i18n from "../../web/src/app/i18n.js";

test("transcription failures receive stable actionable codes without classifying no-audio", () => {
  assert.equal(
    classifyVoiceTranscriptionFailure(
      "openai-whisper",
      "OPENAI_API_KEY not set",
    ),
    "API_KEY_MISSING",
  );
  assert.equal(
    classifyVoiceTranscriptionFailure(
      "openrouter-stt",
      "HTTP 401: invalid api key",
    ),
    "INVALID_KEY",
  );
  assert.equal(
    classifyVoiceTranscriptionFailure(
      "self-hosted-stt",
      "HTTP 404: model qwen-asr was not found",
    ),
    "MODEL_NOT_AVAILABLE",
  );
  assert.equal(
    classifyVoiceTranscriptionFailure(
      "openrouter-stt",
      "HTTP 429: rate limit exceeded",
    ),
    "PROVIDER_RATE_LIMITED",
  );
  assert.equal(
    classifyVoiceTranscriptionFailure(
      "telomi-audio",
      "telomi-audio ASR request timed out",
    ),
    "TIMEOUT",
  );
  assert.equal(
    classifyVoiceTranscriptionFailure(
      "telomi-audio",
      "fetch failed: connect ECONNREFUSED 127.0.0.1:9595",
    ),
    "NETWORK",
  );
  assert.equal(
    classifyVoiceTranscriptionFailure(
      "openai-whisper",
      "You're offline. Cloud transcription requires an internet connection.",
    ),
    "OFFLINE",
  );
  assert.equal(
    classifyVoiceTranscriptionFailure("telomi-audio", "HTTP 503: unavailable"),
    "SERVER_ERROR",
  );
  assert.equal(
    classifyVoiceTranscriptionFailure("telomi-audio", "No audio detected"),
    undefined,
  );
});

test("configuration failures with retained audio guide users to settings and retry", async () => {
  const guidance = getVoiceHistoryFailureGuidance({
    provider: "openai-whisper",
    errorCode: "API_KEY_MISSING",
    hasAudio: true,
  });
  assert.deepEqual(guidance, {
    kind: "configuration",
    messageCode: "configuration-retry-retained",
    actionCode: "open-transcription-settings",
    settingsTarget: "stt-provider",
  });

  await i18n.changeLanguage("zh-CN");
  const html = renderToStaticMarkup(
    <VoiceHistoryFailureGuidanceContent
      guidance={guidance!}
      onOpenSettings={() => {}}
    />,
  );
  assert.match(html, /data-testid="voice-history-failure-guidance"/);
  assert.match(html, /配置语音转写服务后，可使用保留的原音频重试/);
  assert.match(html, /定位语音转写设置/);
});

test("configuration failures without audio do not promise retry recovery", () => {
  assert.deepEqual(
    getVoiceHistoryFailureGuidance({
      provider: "openai-whisper",
      errorCode: "INVALID_KEY",
      hasAudio: false,
    }),
    {
      kind: "configuration",
      messageCode: "configuration-next-recording",
      actionCode: "open-transcription-settings",
      settingsTarget: "stt-provider",
    },
  );
});

test("settings target follows the failed provider boundary", () => {
  assert.equal(
    getVoiceHistoryFailureGuidance({
      provider: "telomi-audio",
      errorCode: "MODEL_NOT_AVAILABLE",
      hasAudio: true,
    })?.settingsTarget,
    "local-runtime",
  );
  assert.equal(
    getVoiceHistoryFailureGuidance({
      provider: "self-hosted-stt",
      errorCode: "INVALID_KEY",
      hasAudio: true,
    })?.settingsTarget,
    "self-hosted-stt",
  );
});

test("offline, network, limits and rate limits have distinct recovery guidance", () => {
  assert.deepEqual(
    getVoiceHistoryFailureGuidance({
      provider: "telomi-audio",
      errorCode: "NETWORK",
      hasAudio: true,
    }),
    {
      kind: "connection",
      messageCode: "local-runtime-retry-retained",
      actionCode: "open-local-runtime",
      settingsTarget: "local-runtime",
    },
  );
  assert.equal(
    getVoiceHistoryFailureGuidance({
      provider: "openai-whisper",
      errorCode: "OFFLINE",
      hasAudio: true,
    })?.messageCode,
    "offline-retry-retained",
  );
  assert.equal(
    getVoiceHistoryFailureGuidance({
      provider: "openai-whisper",
      errorCode: "LIMIT_REACHED",
      hasAudio: true,
    })?.messageCode,
    "limit-reached",
  );
  assert.equal(
    getVoiceHistoryFailureGuidance({
      provider: "openrouter-stt",
      errorCode: "PROVIDER_RATE_LIMITED",
      hasAudio: true,
    })?.messageCode,
    "rate-limited",
  );
});

test("unknown legacy error codes keep the existing generic failure UI", () => {
  assert.equal(
    getVoiceHistoryFailureGuidance({
      provider: "telomi-audio",
      errorCode: "LEGACY_UNKNOWN",
      hasAudio: true,
    }),
    null,
  );
});
