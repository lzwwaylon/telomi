import { resolveSpeechConfiguration, noteSpeechConfiguration } from "./configuration.js";
import type { SpeechExecutionConfiguration } from "../../shared/speech-configuration.js";
import { voiceDataRoot } from "../workspaces/server-runtime-paths.js";
import { sha256 } from "../lib/hash.js";
import {
  existsSync,
  readFileSync,
  statSync,
  } from "node:fs";
import { join } from "node:path";
import { loadAudioSettings } from "../audio/providers/settings.js";
import {
  isNormalizedVoiceVadConfig,
  normalizeVoiceVadConfig,
  type VoiceVadConfig,
} from "../audio/voice-vad.js";
import {
  normalizeVoiceLanguagePreference,
  voiceLanguageHint,
  type VoiceLanguagePreference,
} from "../../shared/voice-languages.js";
import { type VoiceGlossarySnapshot } from "../../shared/voice-stt.js";
import { isVoiceContextSnapshotId } from "../../shared/voice-context.js";
import {
  normalizeVoiceCleanupConfig,
  type VoiceCleanupConfig,
} from "../../shared/voice-cleanup.js";
import {
  glossaryRevision,
  normalizeGlossaryEntries,
  VoiceGlossaryStore,
} from "./glossary.js";
import { writeJsonAtomic } from "../lib/fs.js";

const VOICE_CONTEXT_SCHEMA_VERSION = 4;
const VOICE_CONTEXT_MAX_FILE_BYTES = 16 * 1024 * 1024;

export interface VoiceUtteranceContextSnapshot {
  schemaVersion: typeof VOICE_CONTEXT_SCHEMA_VERSION;
  id: string;
  capturedAt: string;
  languagePreference: VoiceLanguagePreference;
  languageHint?: string;
  glossary: VoiceGlossarySnapshot;
  vad: VoiceVadConfig;
  cleanup: VoiceCleanupConfig;
  speech?: SpeechExecutionConfiguration;
}

export interface VoiceUtteranceContextStoreOptions {
  loadLanguagePreference?: () => unknown;
  loadVadConfig?: () => unknown;
  loadCleanupConfig?: () => unknown;
  now?: () => Date;
}

export class VoiceUtteranceContextStore {
  private readonly rootDir: string;
  private readonly glossary: VoiceGlossaryStore;
  private readonly loadLanguagePreference: () => unknown;
  private readonly loadVadConfig: () => unknown;
  private readonly loadCleanupConfig: () => unknown;
  private readonly now: () => Date;

  constructor(
    workspaceDir: string,
    options: VoiceUtteranceContextStoreOptions = {},
  ) {
    this.rootDir = join(voiceDataRoot(workspaceDir), "context-snapshots");
    this.glossary = new VoiceGlossaryStore(workspaceDir);
    this.loadLanguagePreference =
      options.loadLanguagePreference ?? (() => loadAudioSettings().sttLanguage);
    this.loadVadConfig =
      options.loadVadConfig ?? (() => loadAudioSettings().sttVad);
    this.loadCleanupConfig =
      options.loadCleanupConfig ??
      (() => {
        const settings = loadAudioSettings();
        return {
          enabled: settings.sttCleanupEnabled,
          modelId: settings.sttCleanupModel,
          instructions: settings.sttCleanupInstructions,
        };
      });
    this.now = options.now ?? (() => new Date());
  }

  capture(
    options: {
      languagePreference?: unknown;
      languageHint?: unknown;
      vad?: unknown;
      cleanup?: unknown;
    } = {},
  ): VoiceUtteranceContextSnapshot {
    const languagePreference = normalizeVoiceLanguagePreference(
      options.languagePreference ?? this.loadLanguagePreference(),
    );
    const languageHint = Object.prototype.hasOwnProperty.call(
      options,
      "languageHint",
    )
      ? normalizeLanguageHint(options.languageHint)
      : voiceLanguageHint(languagePreference);
    const vad = normalizeVoiceVadConfig(
      Object.prototype.hasOwnProperty.call(options, "vad")
        ? options.vad
        : this.loadVadConfig(),
    );
    const speech = resolveSpeechConfiguration();
    const cleanup = normalizeVoiceCleanupConfig(
      Object.prototype.hasOwnProperty.call(options, "cleanup")
        ? options.cleanup
        : this.loadCleanupConfig(),
      "",
    );
    noteSpeechConfiguration("recognition", speech); noteSpeechConfiguration("cleanupModel", speech);
    const content: Omit<VoiceUtteranceContextSnapshot, "id" | "capturedAt"> = {
      schemaVersion: VOICE_CONTEXT_SCHEMA_VERSION,
      languagePreference,
      ...(languageHint ? { languageHint } : {}),
      glossary: this.glossary.getSnapshot(),
      vad,
      cleanup,
      ...(speech ? { speech } : {}),
    };
    const id = contextId(content);
    const existing = this.get(id);
    if (existing) return existing;

    const snapshot: VoiceUtteranceContextSnapshot = {
      ...content,
      id,
      capturedAt: this.now().toISOString(),
    };
    writeJsonAtomic(this.pathFor(id), snapshot);
    return snapshot;
  }

  get(id: string): VoiceUtteranceContextSnapshot | null {
    if (!isVoiceContextSnapshotId(id)) return null;
    const path = this.pathFor(id);
    if (!existsSync(path)) return null;
    try {
      if (statSync(path).size > VOICE_CONTEXT_MAX_FILE_BYTES) return null;
      return normalizeStoredContext(
        JSON.parse(readFileSync(path, "utf8")) as unknown,
        id,
      );
    } catch {
      return null;
    }
  }

  require(id: string): VoiceUtteranceContextSnapshot {
    const snapshot = this.get(id);
    if (!snapshot) {
      throw new Error(`Voice utterance context snapshot not found: ${id}`);
    }
    return snapshot;
  }

  private pathFor(id: string): string {
    return join(this.rootDir, `${id}.json`);
  }
}

function normalizeStoredContext(
  value: unknown,
  expectedId: string,
): VoiceUtteranceContextSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== VOICE_CONTEXT_SCHEMA_VERSION ||
    record.id !== expectedId ||
    typeof record.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(record.capturedAt))
  ) {
    return null;
  }
  if (
    !record.glossary ||
    typeof record.glossary !== "object" ||
    Array.isArray(record.glossary)
  ) {
    return null;
  }
  const glossaryRecord = record.glossary as Record<string, unknown>;
  const glossaryEntries = normalizeGlossaryEntries(glossaryRecord.entries);
  const glossary: VoiceGlossarySnapshot = {
    revision: glossaryRevision(glossaryEntries),
    updatedAt: optionalIso(glossaryRecord.updatedAt),
    entries: glossaryEntries,
  };
  if (glossaryRecord.revision !== glossary.revision) return null;
  const languagePreference = normalizeVoiceLanguagePreference(
    record.languagePreference,
  );
  if (record.languagePreference !== languagePreference) return null;
  const languageHint = normalizeLanguageHint(record.languageHint);
  if (!isNormalizedVoiceVadConfig(record.vad)) return null;
  const vad = normalizeVoiceVadConfig(record.vad);
  const cleanup = normalizeVoiceCleanupConfig(record.cleanup, record.speech ? "" : undefined);
  if (JSON.stringify(record.cleanup) !== JSON.stringify(cleanup)) {
    return null;
  }
  const content: Omit<VoiceUtteranceContextSnapshot, "id" | "capturedAt"> = {
    schemaVersion: VOICE_CONTEXT_SCHEMA_VERSION,
    languagePreference,
    ...(languageHint ? { languageHint } : {}),
    glossary,
    vad,
    cleanup,
    ...(record.speech ? { speech: record.speech as SpeechExecutionConfiguration } : {}),
  };
  if (contextId(content) !== expectedId) return null;
  return {
    ...content,
    id: expectedId,
    capturedAt: record.capturedAt,
  };
}

function optionalIso(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Voice context source timestamp is invalid");
  }
  return value;
}

function normalizeLanguageHint(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value)
  ) {
    throw new Error("Voice context language hint is invalid");
  }
  return value;
}

function contextId(content: {
  schemaVersion: number;
  languagePreference: VoiceLanguagePreference;
  languageHint?: string;
  glossary: VoiceGlossarySnapshot;
  vad: VoiceVadConfig;
  cleanup: VoiceCleanupConfig;
  speech?: SpeechExecutionConfiguration;
}): string {
  const effectiveContent = {
    schemaVersion: content.schemaVersion,
    languagePreference: content.languagePreference,
    ...(content.languageHint ? { languageHint: content.languageHint } : {}),
    glossary: {
      revision: content.glossary.revision,
      entries: content.glossary.entries,
    },
    vad: content.vad,
    cleanup: content.cleanup,
    ...(content.speech ? { speech: content.speech } : {}),
  };
  return `voice_ctx_${sha256(JSON.stringify(effectiveContent))}`;
}
