import { mountAudioGenerationApi, parseAudioGenerationSelection, resolveAudioGeneration } from "../audio/configuration.js";
import { mountSpeechConfigurationApi } from "./configuration.js";
import type { Express, Request, Response } from "express";
import { createHash } from "crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "fs";
import { join } from "path";
import { resolveAgentPath } from "../config/agent-directory.js";
import { speak } from "../audio/providers/tts.js";
import type { AudioGenerationSelection } from "../../shared/audio-generation.js";
import {
  normalizeVoiceVadConfig,
  type VoiceVadConfig,
} from "../audio/voice-vad.js";
import {
  isVoiceLanguagePreference,
  normalizeVoiceLanguagePreference,
} from "../../shared/voice-languages.js";
import {
  getAudioLocalRuntimeManager,
  type AudioLocalRuntimeManager,
} from "../audio/local-runtime.js";
import {
  loadSettings,
  saveSettings,
  type AudioSettings,
  type PiSettings,
} from "../config/settings.js";
import { toErrorMessage } from "../lib/values.js";

const VOICE_PREVIEW_DIR = resolveAgentPath("audio-voice-previews");
const MAX_VOICE_PREVIEW_TEXT = 500;
const VOICE_PREVIEW_FILE = /^[0-9a-f]{40}\.mp3$/;

/** Voice preferences under `settings.audio`. Model, connection and credential selection is managed by the unified speech and audio configuration. */
type AudioPreferences = Required<Pick<AudioSettings, "sttLanguage" | "audioCuesEnabled" | "sttVad">>;
function normalizeAudioSettings(settings: PiSettings): AudioPreferences {
  const audio = settings.audio ?? {};
  return {
    sttLanguage: normalizeVoiceLanguagePreference(audio.sttLanguage),
    audioCuesEnabled: audio.audioCuesEnabled !== false,
    sttVad: normalizeVoiceVadConfig(audio.sttVad),
  };
}

async function buildResponse(
  settings: PiSettings,
  localAudio: AudioLocalRuntimeManager,
) {
  return {
    config: normalizeAudioSettings(settings),
    // A bounded probe through the runtime manager; the VAD status rides on it.
    telomiAudio: { runtime: await localAudio.refresh() },
  };
}

function voicePreviewText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error("preview text is required");
  if (text.length > MAX_VOICE_PREVIEW_TEXT) throw new Error(`preview text must be at most ${MAX_VOICE_PREVIEW_TEXT} characters`);
  return text;
}

/**
 * One utterance of a settings row's selection, applied or not, the way its consumer would hear it.
 * A preview is kept by what produced it, so replaying one costs nothing.
 */
async function voicePreview(selection: AudioGenerationSelection, text: string): Promise<string> {
  const audio = resolveAudioGeneration("playback", { default: selection });
  const file = `${createHash("sha1").update(JSON.stringify({ ...audio, text })).digest("hex")}.mp3`;
  const path = join(VOICE_PREVIEW_DIR, file);
  try {
    if (statSync(path).size > 0) return file;
  } catch {
    // Generate below.
  }
  mkdirSync(VOICE_PREVIEW_DIR, { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp.mp3`;
  try {
    const result = await speak({ audio, text, format: "mp3", outPath: tmpPath });
    if (!result.ok) throw new Error(result.reason);
    renameSync(tmpPath, path);
    return file;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

export function mountAudioConfigApi(
  app: Express,
  localAudio = getAudioLocalRuntimeManager(),
): void {
  mountAudioGenerationApi(app);
  mountSpeechConfigurationApi(app);
  app.get(
    "/api/audio-config/local-runtime",
    async (_req: Request, res: Response) => {
      try {
        res.json(await localAudio.refresh());
      } catch (error) {
        res.status(503).json({
          error: toErrorMessage(error),
          status: localAudio.status(),
        });
      }
    },
  );

  app.post(
    "/api/audio-config/local-runtime/start",
    async (_req: Request, res: Response) => {
      try {
        res.json(await localAudio.startExplicitly());
      } catch (error) {
        res.status(503).json({
          error: toErrorMessage(error),
          status: localAudio.status(),
        });
      }
    },
  );

  app.get("/api/audio-config", async (_req: Request, res: Response) => {
    try {
      res.json(await buildResponse(loadSettings(), localAudio));
    } catch (err) {
      res
        .status(500)
        .json({ error: toErrorMessage(err) });
    }
  });


  app.post("/api/audio-config/voice-preview", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    let selection: AudioGenerationSelection;
    let text: string;
    try {
      selection = parseAudioGenerationSelection(body);
      text = voicePreviewText(body.text);
    } catch (err) {
      res.status(400).json({ error: toErrorMessage(err) });
      return;
    }
    try {
      res.json({ url: `/api/audio-config/voice-preview/${await voicePreview(selection, text)}` });
    } catch (err) {
      res.status(502).json({ error: toErrorMessage(err) });
    }
  });

  app.get("/api/audio-config/voice-preview/:file", (req: Request, res: Response) => {
    const file = String(req.params.file);
    if (!VOICE_PREVIEW_FILE.test(file)) {
      res.status(404).json({ error: "voice preview not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.type("audio/mpeg").sendFile(join(VOICE_PREVIEW_DIR, file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "voice preview not found" });
    });
  });

  app.patch("/api/audio-config", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    let settings: PiSettings;
    try {
      settings = loadSettings();
    } catch (err) {
      res
        .status(500)
        .json({ error: toErrorMessage(err) });
      return;
    }

    const next: AudioSettings = { ...(settings.audio ?? {}) };
    if (Object.hasOwn(body, "sttLanguage")) {
      if (!isVoiceLanguagePreference(body.sttLanguage)) {
        res.status(400).json({
          error: `invalid sttLanguage '${String(body.sttLanguage)}'`,
        });
        return;
      }
      next.sttLanguage = body.sttLanguage;
    }
    if (Object.hasOwn(body, "audioCuesEnabled")) {
      if (typeof body.audioCuesEnabled !== "boolean") {
        res.status(400).json({ error: "audioCuesEnabled must be a boolean" });
        return;
      }
      next.audioCuesEnabled = body.audioCuesEnabled;
    }
    if (Object.hasOwn(body, "sttVad")) {
      if (
        !body.sttVad ||
        typeof body.sttVad !== "object" ||
        Array.isArray(body.sttVad)
      ) {
        res.status(400).json({ error: "sttVad must be an object" });
        return;
      }
      next.sttVad = normalizeVoiceVadConfig(body.sttVad);
    }

    settings.audio = next;
    try {
      const response = await buildResponse(settings, localAudio);
      const normalized: AudioSettings = { ...next, ...response.config, sttVad: response.config.sttVad as VoiceVadConfig };
      // Persist only the requested keys so a concurrent unified-configuration save is not clobbered.
      const latest = loadSettings();
      latest.audio = { ...latest.audio };
      for (const key of Object.keys(body)) if (key in normalized) latest.audio[key] = normalized[key];
      saveSettings(latest);
      res.json(response);
    } catch (err) {
      res
        .status(500)
        .json({ error: toErrorMessage(err) });
    }
  });
}
