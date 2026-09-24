import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceCleanupSettings } from "../../web/src/features/settings/VoiceCleanupSettings.js";
import { Volume2 } from "lucide-react";
import { VoiceToggleSettings } from "../../web/src/features/settings/VoiceToggleSettings.js";
import { VoiceLocalRuntimeSettings } from "../../web/src/features/settings/VoiceLocalRuntimeSettings.js";

test("local voice runtime exposes install progress and an explicit start action", () => {
  const installing = renderToStaticMarkup(
    <VoiceLocalRuntimeSettings
      initialStatus={{
        schemaVersion: 1,
        stage: "installing",
        baseUrl: "http://127.0.0.1:9595/v1",
        managed: true,
        owned: true,
        detail: "正在下载固定模型资产 4/8",
        installStage: "downloading",
        completedFiles: 3,
        totalFiles: 8,
        pid: 1234,
        error: null,
        updatedAt: "2026-07-21T00:00:00.000Z",
      }}
    />,
  );
  assert.match(installing, /本地语音运行环境/);
  assert.match(installing, /安装中/);
  assert.match(installing, /3 \/ 8/);
  assert.match(installing, /role="progressbar"/);
  assert.match(installing, /aria-valuenow="3"/);

  const stopped = renderToStaticMarkup(
    <VoiceLocalRuntimeSettings
      initialStatus={{
        schemaVersion: 1,
        stage: "stopped",
        baseUrl: "http://127.0.0.1:9595/v1",
        managed: true,
        owned: false,
        detail: "local audio sidecar is stopped",
        installStage: null,
        completedFiles: 0,
        totalFiles: 0,
        pid: null,
        error: null,
        updatedAt: "2026-07-21T00:00:00.000Z",
      }}
    />,
  );
  assert.match(stopped, /安装并启动/);
  assert.match(stopped, /data-testid="voice-local-runtime-start"/);
});

test("AI cleanup settings are explicit, local-first and disabled by default", () => {
  const html = renderToStaticMarkup(
    <VoiceCleanupSettings
      enabled={false}
      instructions=""
      disabled={false}
      onPatch={() => undefined}
    />,
  );

  assert.match(html, /AI 文本清理/);
  assert.match(html, /默认关闭/);
  assert.match(html, /失败时保留未经清理的转写文本/);
  assert.match(html, /data-testid="voice-cleanup-enabled"/);
  assert.doesNotMatch(html, /data-testid="voice-cleanup-model"/, "the cleanup model is selected in the speech configuration");
  assert.doesNotMatch(html, /checked=""/);
});

test("recording cue settings retain the OpenWhispr default-on behavior", () => {
  const html = renderToStaticMarkup(
    <VoiceToggleSettings
      icon={Volume2}
      heading="settings.voicerecordingcuesettings.recordingCues"
      description="settings.voicerecordingcuesettings.playASoundWhenRecordingStartsAndStopsOn"
      toggleLabel="settings.voicerecordingcuesettings.playRecordingCues"
      field="audioCuesEnabled"
      testId="voice-recording-cues"
      enabled
      disabled={false}
      onPatch={() => undefined}
    />,
  );

  assert.match(html, /录音提示音/);
  assert.match(html, /录音开始和停止时播放提示音/);
  assert.match(html, /默认开启/);
  assert.match(html, /data-testid="voice-recording-cues-enabled"/);
  assert.match(html, /checked=""/);
});
