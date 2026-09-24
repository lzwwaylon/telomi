import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { voiceDataRoot } from "../workspaces/server-runtime-paths.js";
import { writeFileAtomic } from "../lib/fs.js";
import { sha256 } from "../lib/hash.js";
import {
  VOICE_STREAM_MAX_GLOSSARY_ENTRIES,
  VOICE_STREAM_MAX_TERM_LENGTH,
  type VoiceGlossaryEntry,
  type VoiceGlossarySnapshot,
} from "../../shared/voice-stt.js";

const GLOSSARY_SCHEMA_VERSION = 1;
const DEFAULT_PROMPT_MAX_CHARS = 800;

interface StoredVoiceGlossary {
  schemaVersion: typeof GLOSSARY_SCHEMA_VERSION;
  updatedAt: string;
  entries: VoiceGlossaryEntry[];
}

export class VoiceGlossaryStore {
  private readonly path: string;

  constructor(workspaceDir: string) {
    this.path = join(voiceDataRoot(workspaceDir), "glossary.json");
  }

  getSnapshot(): VoiceGlossarySnapshot {
    const stored = this.read();
    const entries = stored?.entries ?? [];
    return {
      revision: glossaryRevision(entries),
      updatedAt: stored?.updatedAt ?? null,
      entries,
    };
  }

  replace(entries: unknown): VoiceGlossarySnapshot {
    const normalized = normalizeGlossaryEntries(entries);
    const stored: StoredVoiceGlossary = {
      schemaVersion: GLOSSARY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      entries: normalized,
    };
    writeFileAtomic(this.path, `${JSON.stringify(stored, null, 2)}\n`);
    return {
      revision: glossaryRevision(normalized),
      updatedAt: stored.updatedAt,
      entries: normalized,
    };
  }

  learnCanonicalTerms(terms: string[]): {
    snapshot: VoiceGlossarySnapshot;
    learned: string[];
  } {
    const snapshot = this.getSnapshot();
    const existing = new Set(
      snapshot.entries.map((entry) => entry.canonical.toLocaleLowerCase()),
    );
    const learned = [
      ...new Set(terms.map((term) => term.trim()).filter(Boolean)),
    ].filter((term) => !existing.has(term.toLocaleLowerCase()));
    if (learned.length === 0) return { snapshot, learned: [] };
    return {
      snapshot: this.replace([
        ...snapshot.entries,
        ...learned.map((canonical) => ({
          canonical,
          enabled: true,
          source: "learned",
        })),
      ]),
      learned,
    };
  }

  undoLearnedCanonicalTerms(terms: string[]): {
    snapshot: VoiceGlossarySnapshot;
    removed: string[];
  } {
    const snapshot = this.getSnapshot();
    const requested = new Set(
      terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean),
    );
    if (requested.size === 0) return { snapshot, removed: [] };

    const removed = snapshot.entries
      .filter(
        (entry) =>
          entry.source === "learned" &&
          requested.has(entry.canonical.toLocaleLowerCase()),
      )
      .map((entry) => entry.canonical);
    if (removed.length === 0) return { snapshot, removed };

    const removedKeys = new Set(
      removed.map((term) => term.toLocaleLowerCase()),
    );
    return {
      snapshot: this.replace(
        snapshot.entries.filter(
          (entry) => !removedKeys.has(entry.canonical.toLocaleLowerCase()),
        ),
      ),
      removed,
    };
  }

  private read(): StoredVoiceGlossary | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
      const record = parsed as Record<string, unknown>;
      if (
        record.schemaVersion !== GLOSSARY_SCHEMA_VERSION ||
        typeof record.updatedAt !== "string"
      )
        return null;
      return {
        schemaVersion: GLOSSARY_SCHEMA_VERSION,
        updatedAt: record.updatedAt,
        entries: normalizeGlossaryEntries(record.entries),
      };
    } catch {
      return null;
    }
  }
}

export function buildGlossaryPrompt(
  entries: VoiceGlossaryEntry[],
  maxChars = DEFAULT_PROMPT_MAX_CHARS,
): string | undefined {
  const selected = selectVoicePromptTerms(entries, maxChars);
  return selected.length > 0 ? `Keywords: ${selected.join(", ")}` : undefined;
}

export function selectVoicePromptTerms(
  entries: VoiceGlossaryEntry[],
  maxChars = DEFAULT_PROMPT_MAX_CHARS,
): string[] {
  const terms = entries.filter((entry) => entry.enabled).map((entry) => entry.canonical).filter(Boolean);
  const prefix = "Keywords: ";
  const selected: string[] = [];
  let length = prefix.length;
  for (const term of terms) {
    const additional = (selected.length > 0 ? 2 : 0) + term.length;
    if (length + additional > maxChars) break;
    selected.push(term);
    length += additional;
  }
  return selected;
}

export function normalizeGlossaryEntries(value: unknown): VoiceGlossaryEntry[] {
  if (!Array.isArray(value)) throw new Error("entries must be an array");
  if (value.length > VOICE_STREAM_MAX_GLOSSARY_ENTRIES) {
    throw new Error(
      `entries must contain at most ${VOICE_STREAM_MAX_GLOSSARY_ENTRIES} items`,
    );
  }

  const seenIds = new Set<string>();
  const seenCanonicals = new Set<string>();
  const entries = value.map<VoiceGlossaryEntry>((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`entries[${index}] must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const canonical = cleanTerm(
      record.canonical,
      `entries[${index}].canonical`,
    );
    const canonicalKey = canonical.toLocaleLowerCase();
    if (seenCanonicals.has(canonicalKey))
      throw new Error(`duplicate canonical term: ${canonical}`);
    seenCanonicals.add(canonicalKey);

    const rawId = typeof record.id === "string" ? record.id.trim() : "";
    const id =
      rawId ||
      `term_${sha256(canonicalKey).slice(0, 16)}`;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
      throw new Error(`entries[${index}].id is invalid`);
    if (seenIds.has(id)) throw new Error(`duplicate glossary id: ${id}`);
    seenIds.add(id);

    const language =
      record.language === undefined
        ? undefined
        : cleanLanguage(record.language, `entries[${index}].language`);
    const source =
      record.source === "manual" || record.source === "learned" || record.source === "imported"
        ? record.source
        : undefined;

    return {
      id,
      canonical,
      ...(language ? { language } : {}),
      enabled: record.enabled === undefined ? true : Boolean(record.enabled),
      ...(source ? { source } : {}),
    };
  });
  return entries;
}

function cleanTerm(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const term = value.trim().replace(/\s+/g, " ");
  if (!term) throw new Error(`${field} must not be empty`);
  if (term.length > VOICE_STREAM_MAX_TERM_LENGTH) {
    throw new Error(
      `${field} must contain at most ${VOICE_STREAM_MAX_TERM_LENGTH} characters`,
    );
  }
  return term;
}

function cleanLanguage(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const language = value.trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language)) {
    throw new Error(`${field} must be a BCP-47 language hint`);
  }
  return language;
}

export function glossaryRevision(entries: VoiceGlossaryEntry[]): string {
  return sha256(JSON.stringify(entries)).slice(0, 16);
}
