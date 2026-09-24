import type { ConnectionCapability } from "./connections.js";

/** A model as a `/models` listing describes it; only the fields classification reads. */
export interface DiscoveredModel {
  id: string;
  name?: string;
  capabilities: ConnectionCapability[];
  supportedVoices?: string[];
}

const TTS_RE = /(^|[/-])(tts|speech|voice)(?![a-z])|-tts-|text-to-speech/i;
const STT_RE = /whisper|asr|transcri|parakeet|(^|[/-])stt(?![a-z])|speech-to-text|canary/i;
const EMBEDDING_RE = /embed|(^|[/-])bge-|(^|[/-])e5-|minilm|(^|[/-])gte-|nomic-embed|voyage-|text-embedding/i;
/** Models that serve none of the four capabilities Telomi selects. */
const NONE_RE = /rerank|moderation|dall-e|image-1|sora|imagen|stable-diffusion|flux|guard(?![a-z])/i;

/** Hugging Face task names a speech server may declare for a model (Speaches does). */
const TASK_CAPABILITIES = new Map<string, ConnectionCapability>([["text-to-speech", "tts"], ["automatic-speech-recognition", "stt"]]);

/** Voice ids from a listing that names them as strings or as `{ id }` objects. */
function voiceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((voice) => typeof voice === "string" ? voice : typeof voice?.id === "string" ? voice.id as string : "").filter((voice) => voice.trim().length > 0);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * What a listed model can do. Structured hints win (OpenRouter `architecture` modalities,
 * `supported_voices` or `voices` from speech services, a Hugging Face `task`); the id decides when a listing has none.
 */
export function classifyModel(raw: Record<string, unknown>): DiscoveredModel | undefined {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return undefined;
  const name = typeof raw.name === "string" && raw.name ? raw.name : undefined;
  const listedVoices = voiceIds(raw.supported_voices);
  const supportedVoices = listedVoices.length ? listedVoices : voiceIds(raw.voices);
  const task = typeof raw.task === "string" ? raw.task : "";
  const architecture = raw.architecture && typeof raw.architecture === "object" ? raw.architecture as Record<string, unknown> : {};
  const input = strings(architecture.input_modalities ?? raw.input_modalities);
  const output = strings(architecture.output_modalities ?? raw.output_modalities);
  const capabilities = new Set<ConnectionCapability>();
  // Audio that is not speech (music generation, spoken chat replies) serves none of the capabilities Telomi selects.
  const otherAudio = output.includes("audio") && !output.includes("speech");

  // OpenRouter lists speech, transcription and embedding catalogs with their own output modality.
  if (supportedVoices.length > 0 || output.includes("speech")) capabilities.add("tts");
  // A model that takes text alongside audio is a multimodal LLM answering through chat, not a recognizer.
  if (output.includes("transcription") || (input.includes("audio") && !input.includes("text") && output.includes("text") && !output.includes("audio"))) capabilities.add("stt");
  if (output.some((item) => /embed/i.test(item))) capabilities.add("embedding");
  if (output.includes("text") && !otherAudio && !capabilities.size) capabilities.add("chat");
  const declared = TASK_CAPABILITIES.get(task);
  if (declared) capabilities.add(declared);

  // A declared task is the listing's own statement, so one Telomi selects nothing for is not guessed from the id.
  if (capabilities.size === 0 && !task && !otherAudio && !NONE_RE.test(id)) {
    if (TTS_RE.test(id)) capabilities.add("tts");
    else if (STT_RE.test(id)) capabilities.add("stt");
    else if (EMBEDDING_RE.test(id)) capabilities.add("embedding");
    else capabilities.add("chat");
  }
  return { id, name, capabilities: [...capabilities], ...(supportedVoices.length ? { supportedVoices } : {}) };
}

/**
 * A model's stored capabilities. An empty list is a classification too: the model serves none of them.
 * A model saved before classification existed, or with only values this version does not know, is classified by its id.
 */
export function capabilitiesFor(model: { id: string; capabilities?: unknown }): ConnectionCapability[] {
  const stored = strings(model.capabilities).filter((item): item is ConnectionCapability => ["chat", "embedding", "tts", "stt"].includes(item));
  if (stored.length || (Array.isArray(model.capabilities) && model.capabilities.length === 0)) return stored;
  return classifyModel({ id: model.id })?.capabilities ?? [];
}
