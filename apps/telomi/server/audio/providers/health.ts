import { connectionCatalogRevision } from "../../providers/custom-models.js";
import { classifyModel } from "../../../shared/model-capabilities.js";
import type { ConnectionCapability } from "../../../shared/connections.js";

/**
 * Extensions a speech endpoint declares for itself on `/health`. An endpoint that has no health
 * document, or does not list a capability in it, is a plain OpenAI-compatible server and gets
 * none of them: Telomi never infers an extension from who it thinks it is talking to.
 */
export const AUDIO_CAPABILITIES = ["warmup", "transcription-jobs"] as const;
export type AudioCapability = (typeof AUDIO_CAPABILITIES)[number];

export interface AudioServiceHealth {
	capabilities: readonly AudioCapability[];
	/** Requests this endpoint wants in flight at once. Unlimited when it does not say. */
	maxConcurrency?: number;
}

/** What an endpoint's `/models` listing says about one model. A field it does not report is absent. */
export interface ReportedAudioModel {
	id: string;
	capabilities: readonly ConnectionCapability[];
	/** The service's own statement of what the model serves, believed over classification. */
	modality?: string;
	defaultVoice?: string;
	voices: readonly string[];
	/** The `response_format` values the model can return. */
	responseFormats?: readonly string[];
	/** The `speed` range the model accepts. */
	speed?: { min: number; max: number };
}

const PLAIN: AudioServiceHealth = { capabilities: [] };
const PROBE_TIMEOUT_MS = 3_000;

let cachedRevision = "";
const cached = new Map<string, Promise<unknown>>();

/**
 * What one speech endpoint says it can do, for every audio consumer (STT, TTS, warmup).
 *
 * Probed once per connection catalog revision, so a transcription pays for it on the first
 * request after the catalog changes and never again. A probe that gets no answer at all is not
 * cached: a service that is still starting must be asked again rather than treated as plain for
 * the rest of the revision.
 */
export function audioServiceHealth(baseUrl: string, apiKey?: string): Promise<AudioServiceHealth> {
	return probeOnce(`health|${baseUrl}|${apiKey ?? ""}`, () => probeHealth(baseUrl, apiKey), PLAIN);
}

/**
 * The model this endpoint serves for a capability, for a selection that names none. Telomi carries
 * no default model id of its own, so upgrading the service is enough to change what it runs.
 */
export async function serverDefaultAudioModel(baseUrl: string, apiKey: string | undefined, capability: ConnectionCapability): Promise<string | undefined> {
	const listed = await serverAudioModels(baseUrl, apiKey);
	return listed.find((model) => model.modality ? model.modality === capability : model.capabilities.includes(capability))?.id;
}

/** What this endpoint reports about one model, when its listing names it. */
export async function serverAudioModel(baseUrl: string, apiKey: string | undefined, id: string): Promise<ReportedAudioModel | undefined> {
	return (await serverAudioModels(baseUrl, apiKey)).find((model) => model.id === id);
}

function serverAudioModels(baseUrl: string, apiKey: string | undefined): Promise<readonly ReportedAudioModel[]> {
	return probeOnce(`models|${baseUrl}|${apiKey ?? ""}`, () => probeModels(baseUrl, apiKey), []);
}

/** One answer per endpoint per catalog revision. An unanswered probe is retried, not remembered. */
function probeOnce<T>(key: string, probe: () => Promise<T>, whenUnanswered: T): Promise<T> {
	const revision = connectionCatalogRevision();
	if (revision !== cachedRevision) {
		cached.clear();
		cachedRevision = revision;
	}
	const pending = cached.get(key) as Promise<T> | undefined;
	if (pending) return pending;
	const answer = probe().catch(() => {
		cached.delete(key);
		return whenUnanswered;
	});
	cached.set(key, answer);
	return answer;
}

async function probeHealth(baseUrl: string, apiKey?: string): Promise<AudioServiceHealth> {
	const response = await fetch(healthUrl(baseUrl), {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
		redirect: "error",
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
	// A served answer, including "no such endpoint", is the endpoint's answer and stays cached.
	if (!response.ok) {
		await response.body?.cancel();
		return PLAIN;
	}
	const body = await response.json().catch(() => undefined) as { capabilities?: unknown; max_concurrency?: unknown } | undefined;
	if (!body || typeof body !== "object") return PLAIN;
	const declared: unknown[] = Array.isArray(body.capabilities) ? body.capabilities : [];
	const capabilities = AUDIO_CAPABILITIES.filter((capability) => declared.includes(capability));
	const maxConcurrency = Number(body.max_concurrency);
	return {
		capabilities,
		...(Number.isFinite(maxConcurrency) && maxConcurrency >= 1 ? { maxConcurrency: Math.floor(maxConcurrency) } : {}),
	};
}

async function probeModels(baseUrl: string, apiKey: string | undefined): Promise<ReportedAudioModel[]> {
	const response = await fetch(`${baseUrl}/models`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
		redirect: "error",
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel();
		return [];
	}
	const body = await response.json().catch(() => undefined) as { data?: unknown } | undefined;
	const listed = Array.isArray(body?.data) ? body.data : [];
	return listed.flatMap((entry): ReportedAudioModel[] => {
		if (!entry || typeof entry !== "object") return [];
		const raw = entry as Record<string, unknown>;
		const model = classifyModel(raw);
		if (!model) return [];
		const defaultVoice = typeof raw.default_voice === "string" ? raw.default_voice.trim() : "";
		const responseFormats = Array.isArray(raw.response_formats) ? raw.response_formats.filter((format): format is string => typeof format === "string") : [];
		return [{
			id: model.id,
			capabilities: model.capabilities,
			voices: model.supportedVoices ?? [],
			...(typeof raw.modality === "string" ? { modality: raw.modality } : {}),
			...(defaultVoice ? { defaultVoice } : {}),
			...(responseFormats.length ? { responseFormats } : {}),
			...(typeof raw.min_speed === "number" && typeof raw.max_speed === "number" ? { speed: { min: raw.min_speed, max: raw.max_speed } } : {}),
		}];
	});
}

/** Health sits beside the API root, not inside its versioned path: `<host>/v1` serves `<host>/health`. */
function healthUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v\d+$/, "")}/health`;
	return url.toString();
}

interface ConcurrencyGate {
	active: number;
	waiting: Array<() => void>;
}
const gates = new Map<string, ConcurrencyGate>();

/**
 * Run a request against an endpoint that declared how many it wants at once. Without a declared
 * limit the request goes out immediately: a cloud API is used in parallel, a single-model local
 * server is not overloaded.
 */
export async function withAudioConcurrency<T>(
	baseUrl: string,
	maxConcurrency: number | undefined,
	task: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const release = await acquireAudioSlot(baseUrl, maxConcurrency, signal);
	try {
		return await task();
	} finally {
		release();
	}
}

/**
 * Hold one of an endpoint's declared slots until the returned function is called, for a response
 * that keeps streaming after the call that opened it has returned. Calling it again frees nothing.
 */
export async function acquireAudioSlot(baseUrl: string, maxConcurrency: number | undefined, signal?: AbortSignal): Promise<() => void> {
	if (!maxConcurrency || maxConcurrency < 1) return () => undefined;
	const gate = gates.get(baseUrl) ?? { active: 0, waiting: [] };
	gates.set(baseUrl, gate);
	await acquire(gate, maxConcurrency, signal);
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		release(gate);
	};
}

function acquire(gate: ConcurrencyGate, maxConcurrency: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));
	if (gate.active < maxConcurrency) {
		gate.active += 1;
		return Promise.resolve();
	}
	// A released slot is handed straight to the waiter it wakes, so a caller arriving in between
	// cannot take it and push the endpoint over the limit it declared.
	return new Promise<void>((resolve, reject) => {
		const waiter = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const onAbort = () => {
			gate.waiting = gate.waiting.filter((queued) => queued !== waiter);
			reject(abortReason(signal!));
		};
		gate.waiting.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function release(gate: ConcurrencyGate): void {
	const next = gate.waiting.shift();
	if (next) next();
	else gate.active -= 1;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("audio request aborted", "AbortError");
}
