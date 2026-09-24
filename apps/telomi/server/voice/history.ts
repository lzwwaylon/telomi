import { randomBytes } from "node:crypto";
import {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	} from "node:fs";
import { join } from "node:path";
import { voiceDataRoot } from "../workspaces/server-runtime-paths.js";
import { isVoiceContextSnapshotId } from "../../shared/voice-context.js";
import {
	VOICE_HISTORY_DEFAULT_LIMIT,
	VOICE_HISTORY_MAX_ENTRIES,
	VOICE_HISTORY_MAX_LIMIT,
	VOICE_HISTORY_RETENTION_DAYS,
	isVoiceHistoryEntryId,
	type VoiceHistoryCleanupMeta,
	type VoiceHistoryEntry,
	type VoiceHistorySaveResult,
	type VoiceHistorySettings,
	type VoiceHistorySnapshot,
	type VoiceHistoryStorageUsage,
	type VoiceHistoryUserEdit,
	type VoiceHistoryUserEditUnmeasuredReason,
} from "../../shared/voice-history.js";
import {
	isVoiceSessionId,
	isVoiceUtteranceId,
} from "../../shared/voice-stt.js";
import {
	VOICE_MICROPHONE_SELECTION_STATUSES,
	type VoiceMicrophoneEvidence,
} from "../../shared/voice-microphone.js";
import {
	isVoiceCloudSttProvider,
	type VoiceSttRoutingMeta,
} from "../../shared/voice-stt-routing.js";
import { normalizeProviderId } from "../audio/registry.js";
import { writeFileAtomic, writeJsonAtomic } from "../lib/fs.js";

const HISTORY_SCHEMA_VERSION = 4;
const SETTINGS_SCHEMA_VERSION = 1;
const DEFAULT_AUDIO_RETENTION_DAYS = 30;
const MAX_USER_EDIT_CHARACTERS = 5_000;
export const MIN_DISCARDED_RECORDING_MS = 1_000;

interface StoredVoiceHistory {
	schemaVersion: typeof HISTORY_SCHEMA_VERSION;
	entries: VoiceHistoryEntry[];
}

interface StoredVoiceHistorySettings {
	schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
	dataRetentionEnabled: boolean;
	audioRetentionDays: number;
	saveDiscardedTranscriptions: boolean;
	updatedAt: string;
}

interface VoiceHistoryRecordInput {
	goalId: string;
	sessionId?: string;
	utteranceId?: string;
	status: "completed" | "failed" | "discarded";
	text?: string;
	rawText?: string;
	canonicalText?: string;
	provider: string;
	model?: string;
	language?: string;
	durationSec?: number;
	mime: string;
	errorMessage?: string;
	errorCode?: string;
	contextSnapshotId?: string;
	glossaryRevision?: string;
	cleanup?: VoiceHistoryCleanupMeta;
	routing?: VoiceSttRoutingMeta;
	microphone?: VoiceMicrophoneEvidence;
	audio?: Buffer;
}

export interface VoiceHistoryRetryOutcome {
	status: "completed" | "failed";
	text?: string;
	rawText?: string;
	canonicalText?: string;
	provider: string;
	model?: string;
	language?: string;
	durationSec?: number;
	errorMessage?: string;
	errorCode?: string;
	contextSnapshotId?: string;
	glossaryRevision?: string;
	cleanup?: VoiceHistoryCleanupMeta;
	routing?: VoiceSttRoutingMeta;
}

interface VoiceHistoryStoreOptions {
	now?: () => Date;
	maxEntries?: number;
}

interface VoiceHistorySnapshotOptions {
	includeDiscarded?: boolean;
}

export type VoiceHistoryUserEditInput =
	| {
			outcome: "measured";
			editedText: string;
			elapsedMs: number;
	  }
	| {
			outcome: "unmeasured";
			reason: VoiceHistoryUserEditUnmeasuredReason;
			elapsedMs: number;
	  };

export class VoiceHistoryStore {
	private readonly rootDir: string;
	private readonly historyPath: string;
	private readonly settingsPath: string;
	private readonly audioDir: string;
	private readonly now: () => Date;
	private readonly maxEntries: number;

	constructor(workspaceDir: string, options: VoiceHistoryStoreOptions = {}) {
		this.rootDir = join(voiceDataRoot(workspaceDir), "history");
		this.historyPath = join(this.rootDir, "ledger.json");
		this.settingsPath = join(this.rootDir, "settings.json");
		this.audioDir = join(this.rootDir, "audio");
		this.now = options.now ?? (() => new Date());
		this.maxEntries = options.maxEntries ?? VOICE_HISTORY_MAX_ENTRIES;
	}

	getSettings(): VoiceHistorySettings {
		const stored = this.readSettings();
		return {
			dataRetentionEnabled: stored?.dataRetentionEnabled ?? false,
			audioRetentionDays:
				stored?.audioRetentionDays ?? DEFAULT_AUDIO_RETENTION_DAYS,
			saveDiscardedTranscriptions:
				stored?.saveDiscardedTranscriptions ?? false,
			updatedAt: stored?.updatedAt ?? null,
		};
	}

	updateSettings(value: {
		dataRetentionEnabled?: unknown;
		audioRetentionDays?: unknown;
		saveDiscardedTranscriptions?: unknown;
	}): VoiceHistorySettings {
		const current = this.getSettings();
		const dataRetentionEnabled =
			value.dataRetentionEnabled === undefined
				? current.dataRetentionEnabled
				: requireBoolean(
						value.dataRetentionEnabled,
						"dataRetentionEnabled",
					);
		const audioRetentionDays =
			value.audioRetentionDays === undefined
				? current.audioRetentionDays
				: normalizeRetentionDays(value.audioRetentionDays);
		const saveDiscardedTranscriptions =
			value.saveDiscardedTranscriptions === undefined
				? current.saveDiscardedTranscriptions
				: requireBoolean(
						value.saveDiscardedTranscriptions,
						"saveDiscardedTranscriptions",
					);
		const updatedAt = this.now().toISOString();
		writeJsonAtomic(this.settingsPath, {
			schemaVersion: SETTINGS_SCHEMA_VERSION,
			dataRetentionEnabled,
			audioRetentionDays,
			saveDiscardedTranscriptions,
			updatedAt,
		} satisfies StoredVoiceHistorySettings);

		if (audioRetentionDays === 0) {
			this.clearAllAudio();
		} else {
			this.cleanupExpiredAudio(audioRetentionDays);
		}
		return {
			dataRetentionEnabled,
			audioRetentionDays,
			saveDiscardedTranscriptions,
			updatedAt,
		};
	}

	getSnapshot(
		limit = VOICE_HISTORY_DEFAULT_LIMIT,
		options: VoiceHistorySnapshotOptions = {},
	): VoiceHistorySnapshot {
		const settings = this.getSettings();
		if (settings.audioRetentionDays === 0) {
			this.clearAllAudio();
		} else {
			this.cleanupExpiredAudio(settings.audioRetentionDays);
			this.reconcileMissingAudioFiles();
		}
		const allEntries = this.readHistory().entries;
		const normalizedLimit = Math.max(
			1,
			Math.min(VOICE_HISTORY_MAX_LIMIT, Math.floor(limit) || VOICE_HISTORY_DEFAULT_LIMIT),
		);
		const visibleEntries = options.includeDiscarded
			? allEntries
			: allEntries.filter((entry) => entry.status !== "discarded");
		return {
			settings,
			entries: visibleEntries.slice(0, normalizedLimit),
			usage: calculateUsage(allEntries),
		};
	}

	record(input: VoiceHistoryRecordInput): VoiceHistorySaveResult {
		const settings = this.getSettings();
		if (!settings.dataRetentionEnabled) return { saved: false };

		const createdAt = this.now().toISOString();
		const id = `voice_${randomBytes(16).toString("hex")}`;
		const mime = normalizeAudioMime(input.mime);
		const canSaveAudio =
			Boolean(input.audio?.length) && settings.audioRetentionDays > 0;
		const entry: VoiceHistoryEntry = {
			id,
			goalId: cleanRequiredString(input.goalId, "goalId", 256),
			...(normalizeVoiceSessionId(input.sessionId)
				? { sessionId: normalizeVoiceSessionId(input.sessionId) }
				: {}),
			...(normalizeVoiceUtteranceId(input.utteranceId)
				? { utteranceId: normalizeVoiceUtteranceId(input.utteranceId) }
				: {}),
			status: input.status,
			createdAt,
			updatedAt: createdAt,
			attemptCount: 1,
			text: cleanText(input.text),
			rawText: cleanText(input.rawText),
			canonicalText: cleanText(input.canonicalText),
			provider: normalizeProviderId(cleanRequiredString(input.provider, "provider", 120)),
			...(cleanOptionalString(input.model, 200)
				? { model: cleanOptionalString(input.model, 200) }
				: {}),
			...(cleanOptionalString(input.language, 40)
				? { language: cleanOptionalString(input.language, 40) }
				: {}),
			...(normalizeDuration(input.durationSec) !== undefined
				? { durationSec: normalizeDuration(input.durationSec) }
				: {}),
			mime,
			hasAudio: false,
			audioBytes: 0,
			...(cleanOptionalString(input.errorMessage, 8_000)
				? { errorMessage: cleanOptionalString(input.errorMessage, 8_000) }
				: {}),
			...(cleanOptionalString(input.errorCode, 200)
				? { errorCode: cleanOptionalString(input.errorCode, 200) }
				: {}),
			...(normalizeContextSnapshotId(input.contextSnapshotId)
				? {
						contextSnapshotId: normalizeContextSnapshotId(
							input.contextSnapshotId,
						),
					}
				: {}),
			...(cleanOptionalString(input.glossaryRevision, 120)
				? {
						glossaryRevision: cleanOptionalString(
							input.glossaryRevision,
							120,
						),
					}
				: {}),
			cleanup: normalizeCleanup(input.cleanup),
			...(input.routing
				? { routing: normalizeRouting(input.routing) }
				: {}),
			...(input.microphone
				? { microphone: normalizeMicrophoneEvidence(input.microphone) }
				: {}),
		};

		let audioPath: string | null = null;
		if (canSaveAudio && input.audio) {
			try {
				audioPath = this.writeAudio(id, mime, input.audio);
				entry.hasAudio = true;
				entry.audioBytes = input.audio.length;
			} catch {
				audioPath = null;
			}
		}

		try {
			const history = this.readHistory();
			const entries = [entry, ...history.entries];
			const removed = entries.splice(this.maxEntries);
			this.writeHistory(entries);
			for (const oldEntry of removed) this.deleteAudioFiles(oldEntry.id);
			return { saved: true, entry };
		} catch (error) {
			if (audioPath) {
				try {
					unlinkSync(audioPath);
				} catch {
					// The original ledger error is more actionable than cleanup failure.
				}
			}
			throw error;
		}
	}

	recordDiscarded(
		input: Omit<VoiceHistoryRecordInput, "status" | "provider"> & {
			durationMs: number;
		},
	): VoiceHistorySaveResult {
		const settings = this.getSettings();
		if (
			!settings.dataRetentionEnabled ||
			!settings.saveDiscardedTranscriptions ||
			settings.audioRetentionDays <= 0 ||
			!input.audio?.length ||
			!Number.isFinite(input.durationMs) ||
			input.durationMs < MIN_DISCARDED_RECORDING_MS
		) {
			return { saved: false };
		}
		const result = this.record({
			...input,
			status: "discarded",
			provider: "not-transcribed",
			durationSec: input.durationMs / 1_000,
		});
		if (result.entry?.hasAudio) return result;
		if (result.entry) this.delete(result.entry.id);
		return { saved: false };
	}

	getEntry(id: string): VoiceHistoryEntry | null {
		requireEntryId(id);
		return this.readHistory().entries.find((entry) => entry.id === id) ?? null;
	}

	recordUserEdit(
		id: string,
		input: VoiceHistoryUserEditInput,
	): VoiceHistoryEntry {
		requireEntryId(id);
		const history = this.readHistory();
		const index = history.entries.findIndex((entry) => entry.id === id);
		if (index < 0) throw new Error("Voice history entry not found");
		const current = history.entries[index]!;
		if (current.status !== "completed" || !current.text) {
			throw new Error("Only a completed transcription can record a user edit");
		}
		if (current.userEdit) {
			throw new Error("Voice history user edit is already recorded");
		}

		const elapsedMs = normalizeUserEditElapsedMs(input.elapsedMs);
		const recordedAt = this.now().toISOString();
		let userEdit: VoiceHistoryUserEdit;
		if (input.outcome === "unmeasured") {
			userEdit = {
				outcome: "unmeasured",
				reason: normalizeUserEditUnmeasuredReason(input.reason),
				elapsedMs,
				recordedAt,
			};
		} else {
			if (typeof input.editedText !== "string") {
				throw new Error("editedText must be a string");
			}
			const original = Array.from(current.text.normalize("NFC"));
			const submitted = Array.from(input.editedText.normalize("NFC"));
			if (
				original.length === 0 ||
				original.length > MAX_USER_EDIT_CHARACTERS ||
				submitted.length > MAX_USER_EDIT_CHARACTERS
			) {
				throw new Error(
					`user edit text must contain at most ${MAX_USER_EDIT_CHARACTERS} Unicode code points`,
				);
			}
			const editDistance = unicodeEditDistance(original, submitted);
			userEdit = {
				outcome: "measured",
				unit: "unicode-code-point",
				originalCharacterCount: original.length,
				submittedCharacterCount: submitted.length,
				editDistance,
				modificationRate: editDistance / original.length,
				elapsedMs,
				recordedAt,
			};
		}

		const updated = {
			...current,
			updatedAt: recordedAt,
			userEdit,
		};
		history.entries[index] = updated;
		this.writeHistory(history.entries);
		return updated;
	}

	readAudio(id: string): { buffer: Buffer; mime: string } | null {
		requireEntryId(id);
		const entry = this.getEntry(id);
		if (!entry?.hasAudio) return null;
		const path = this.findAudioPath(id);
		if (!path) {
			this.clearMissingAudioFlag(id);
			return null;
		}
		try {
			return { buffer: readFileSync(path), mime: entry.mime };
		} catch {
			this.clearMissingAudioFlag(id);
			return null;
		}
	}

	applyRetry(id: string, outcome: VoiceHistoryRetryOutcome): VoiceHistoryEntry {
		requireEntryId(id);
		const history = this.readHistory();
		const index = history.entries.findIndex((entry) => entry.id === id);
		if (index < 0) throw new Error("Voice history entry not found");
		const current = history.entries[index]!;
		if (outcome.status === "failed" && current.status === "completed") {
			const preserved: VoiceHistoryEntry = stripUndefined({
				...current,
				updatedAt: this.now().toISOString(),
				attemptCount: current.attemptCount + 1,
				errorMessage: cleanOptionalString(outcome.errorMessage, 8_000),
				errorCode: cleanOptionalString(outcome.errorCode, 200),
			});
			history.entries[index] = preserved;
			this.writeHistory(history.entries);
			return preserved;
		}
		const { userEdit: _previousUserEdit, ...retryBase } = current;
		const updated: VoiceHistoryEntry = {
			...retryBase,
			status: outcome.status,
			updatedAt: this.now().toISOString(),
			attemptCount: current.attemptCount + 1,
			text: cleanText(outcome.text),
			rawText: cleanText(outcome.rawText),
			canonicalText: cleanText(outcome.canonicalText),
			provider: normalizeProviderId(cleanRequiredString(outcome.provider, "provider", 120)),
			contextSnapshotId:
				outcome.contextSnapshotId === undefined
					? current.contextSnapshotId
					: normalizeContextSnapshotId(outcome.contextSnapshotId),
			model: cleanOptionalString(outcome.model, 200),
			language: cleanOptionalString(outcome.language, 40),
			durationSec: normalizeDuration(outcome.durationSec),
			errorMessage: cleanOptionalString(outcome.errorMessage, 8_000),
			errorCode: cleanOptionalString(outcome.errorCode, 200),
			glossaryRevision: cleanOptionalString(outcome.glossaryRevision, 120),
			cleanup: normalizeCleanup(outcome.cleanup),
			...(outcome.routing
				? { routing: normalizeRouting(outcome.routing) }
				: {}),
		};
		history.entries[index] = stripUndefined(updated);
		this.writeHistory(history.entries);
		return history.entries[index]!;
	}

	delete(id: string): boolean {
		requireEntryId(id);
		const history = this.readHistory();
		const entries = history.entries.filter((entry) => entry.id !== id);
		if (entries.length === history.entries.length) return false;
		this.writeHistory(entries);
		this.deleteAudioFiles(id);
		return true;
	}

	clear(): { deletedEntries: number; deletedAudioFiles: number } {
		const deletedEntries = this.readHistory().entries.length;
		const deletedAudioFiles = this.countAudioFiles();
		this.writeHistory([]);
		rmSync(this.audioDir, { recursive: true, force: true });
		return { deletedEntries, deletedAudioFiles };
	}

	private readHistory(): StoredVoiceHistory {
		if (!existsSync(this.historyPath)) {
			return { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [] };
		}
		try {
			const parsed = JSON.parse(readFileSync(this.historyPath, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [] };
			}
			const record = parsed as Record<string, unknown>;
			if (record.schemaVersion !== HISTORY_SCHEMA_VERSION || !Array.isArray(record.entries)) {
				return { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [] };
			}
			return {
				schemaVersion: HISTORY_SCHEMA_VERSION,
				entries: record.entries
					.filter(isStoredEntry)
					.map(normalizeStoredEntry),
			};
		} catch {
			return { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [] };
		}
	}

	private readSettings(): StoredVoiceHistorySettings | null {
		if (!existsSync(this.settingsPath)) return null;
		try {
			const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return null;
			}
			const record = parsed as Record<string, unknown>;
			if (
				record.schemaVersion !== SETTINGS_SCHEMA_VERSION ||
				typeof record.dataRetentionEnabled !== "boolean" ||
				typeof record.updatedAt !== "string"
			) {
				return null;
			}
			return {
				schemaVersion: SETTINGS_SCHEMA_VERSION,
				dataRetentionEnabled: record.dataRetentionEnabled,
				audioRetentionDays: normalizeRetentionDays(record.audioRetentionDays),
				saveDiscardedTranscriptions:
					typeof record.saveDiscardedTranscriptions === "boolean"
						? record.saveDiscardedTranscriptions
						: false,
				updatedAt: record.updatedAt,
			};
		} catch {
			return null;
		}
	}

	private writeHistory(entries: VoiceHistoryEntry[]): void {
		writeJsonAtomic(this.historyPath, {
			schemaVersion: HISTORY_SCHEMA_VERSION,
			entries,
		} satisfies StoredVoiceHistory);
	}

	private writeAudio(id: string, mime: string, audio: Buffer): string {
		const path = join(this.audioDir, `${id}${extensionForMime(mime)}`);
		writeFileAtomic(path, audio);
		return path;
	}

	private findAudioPath(id: string): string | null {
		if (!existsSync(this.audioDir)) return null;
		const name = readdirSync(this.audioDir)
			.filter((candidate) => !candidate.endsWith(".tmp"))
			.find((candidate) => candidate.startsWith(`${id}.`));
		return name ? join(this.audioDir, name) : null;
	}

	private deleteAudioFiles(id: string): number {
		if (!existsSync(this.audioDir)) return 0;
		let deleted = 0;
		for (const name of readdirSync(this.audioDir)) {
			if (!name.startsWith(`${id}.`)) continue;
			try {
				unlinkSync(join(this.audioDir, name));
				deleted += 1;
			} catch {
				// A later cleanup pass can retry deletion.
			}
		}
		return deleted;
	}

	private clearAllAudio(): void {
		const history = this.readHistory();
		if (history.entries.some((entry) => entry.hasAudio)) {
			this.writeHistory(
				history.entries.map((entry) => ({
					...entry,
					hasAudio: false,
					audioBytes: 0,
				})),
			);
		}
		rmSync(this.audioDir, { recursive: true, force: true });
	}

	private cleanupExpiredAudio(retentionDays: number): void {
		if (!existsSync(this.audioDir)) return;
		const cutoff = this.now().getTime() - retentionDays * 86_400_000;
		const history = this.readHistory();
		let changed = false;
		for (const entry of history.entries) {
			if (!entry.hasAudio) continue;
			const createdAt = Date.parse(entry.createdAt);
			if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
			this.deleteAudioFiles(entry.id);
			entry.hasAudio = false;
			entry.audioBytes = 0;
			changed = true;
		}
		if (changed) this.writeHistory(history.entries);
	}

	private clearMissingAudioFlag(id: string): void {
		const history = this.readHistory();
		const entry = history.entries.find((candidate) => candidate.id === id);
		if (!entry?.hasAudio) return;
		entry.hasAudio = false;
		entry.audioBytes = 0;
		this.writeHistory(history.entries);
	}

	private reconcileMissingAudioFiles(): void {
		const history = this.readHistory();
		let changed = false;
		for (const entry of history.entries) {
			if (!entry.hasAudio || this.findAudioPath(entry.id)) continue;
			entry.hasAudio = false;
			entry.audioBytes = 0;
			changed = true;
		}
		if (changed) this.writeHistory(history.entries);
	}

	private countAudioFiles(): number {
		if (!existsSync(this.audioDir)) return 0;
		return readdirSync(this.audioDir).filter((name) => !name.endsWith(".tmp"))
			.length;
	}
}

function normalizeRetentionDays(value: unknown): number {
	const days = typeof value === "number" ? value : Number.NaN;
	if (
		!Number.isInteger(days) ||
		!VOICE_HISTORY_RETENTION_DAYS.includes(
			days as (typeof VOICE_HISTORY_RETENTION_DAYS)[number],
		)
	) {
		throw new Error(
			`audioRetentionDays must be one of ${VOICE_HISTORY_RETENTION_DAYS.join(", ")}`,
		);
	}
	return days;
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
	return value;
}

function normalizeAudioMime(value: string): string {
	const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return /^audio\/[a-z0-9.+-]+$/.test(mime) ? mime : "audio/webm";
}

export function voiceHistoryAudioDownloadFilename(
	id: string,
	mime: string,
): string {
	requireEntryId(id);
	return `Telomi-${id}${extensionForMime(normalizeAudioMime(mime))}`;
}

function extensionForMime(mime: string): string {
	if (mime.includes("webm")) return ".webm";
	if (mime.includes("ogg")) return ".ogg";
	if (mime.includes("wav")) return ".wav";
	if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
	if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) {
		return ".m4a";
	}
	if (mime.includes("flac")) return ".flac";
	return ".audio";
}

function cleanRequiredString(
	value: unknown,
	field: string,
	maxLength: number,
): string {
	const result = cleanOptionalString(value, maxLength);
	if (!result) throw new Error(`${field} must not be empty`);
	return result;
}

function cleanOptionalString(
	value: unknown,
	maxLength: number,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = value.trim();
	return result ? result.slice(0, maxLength) : undefined;
}

function cleanText(value: unknown): string {
	return typeof value === "string" ? value.slice(0, 1_000_000) : "";
}

function normalizeDuration(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function normalizeUserEditElapsedMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("elapsedMs must be a finite non-negative number");
	}
	return Math.round(value * 1_000) / 1_000;
}

function normalizeUserEditUnmeasuredReason(
	value: unknown,
): VoiceHistoryUserEditUnmeasuredReason {
	if (
		value !== "multiple_voice_inputs" &&
		value !== "composer_context_changed" &&
		value !== "text_too_long"
	) {
		throw new Error("Invalid voice user-edit unmeasured reason");
	}
	return value;
}

function unicodeEditDistance(left: string[], right: string[]): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const current = Array<number>(right.length + 1);
		current[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			current[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
				? previous[rightIndex - 1]!
				: 1 + Math.min(
						previous[rightIndex]!,
						current[rightIndex - 1]!,
						previous[rightIndex - 1]!,
					);
		}
		previous = current;
	}
	return previous[right.length]!;
}

function normalizeContextSnapshotId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isVoiceContextSnapshotId(value)) {
		throw new Error("contextSnapshotId must be a valid voice context snapshot id");
	}
	return value;
}

function normalizeCleanup(
	value: VoiceHistoryCleanupMeta | undefined,
): VoiceHistoryCleanupMeta {
	if (!value) return { requested: false, applied: false };
	return stripUndefined({
		requested: Boolean(value.requested),
		applied: Boolean(value.applied),
		modelId: cleanOptionalString(value.modelId, 200),
		durationMs:
			typeof value.durationMs === "number" &&
			Number.isFinite(value.durationMs) &&
			value.durationMs >= 0
				? value.durationMs
				: undefined,
		reason: cleanOptionalString(value.reason, 2_000),
	});
}

function normalizeRouting(value: VoiceSttRoutingMeta): VoiceSttRoutingMeta {
	const primaryProvider = normalizeProviderId(
		cleanOptionalString(value.primaryProvider, 120) ?? "configured-default",
	);
	const fallbackProvider = isVoiceCloudSttProvider(value.fallback?.provider)
		? value.fallback.provider
		: undefined;
	const skipReason =
		value.fallback?.skipReason === "disabled" ||
		value.fallback?.skipReason === "not-local-primary" ||
		value.fallback?.skipReason === "no-audio" ||
		value.fallback?.skipReason === "cancelled"
			? value.fallback.skipReason
			: undefined;
	return {
		primaryProvider,
		fallback: stripUndefined({
			enabled: Boolean(value.fallback?.enabled),
			eligible: Boolean(value.fallback?.eligible),
			used: Boolean(value.fallback?.used),
			provider: fallbackProvider,
			model: cleanOptionalString(value.fallback?.model, 200),
			skipReason,
		}),
		attempts: Array.isArray(value.attempts)
			? value.attempts.slice(0, 4).map((attempt) =>
					stripUndefined({
						provider: normalizeProviderId(
							cleanOptionalString(attempt.provider, 120) ?? "configured-default",
						),
						model: cleanOptionalString(attempt.model, 200),
						ok: Boolean(attempt.ok),
						durationMs:
							typeof attempt.durationMs === "number" &&
							Number.isFinite(attempt.durationMs) &&
							attempt.durationMs >= 0
								? Math.round(attempt.durationMs)
								: 0,
						reason: cleanOptionalString(attempt.reason, 2_000),
					}),
				)
			: [],
	};
}

function normalizeMicrophoneEvidence(
	value: VoiceMicrophoneEvidence,
): VoiceMicrophoneEvidence {
	if (
		!VOICE_MICROPHONE_SELECTION_STATUSES.some(
			(status) => status === value.selectionStatus,
		) ||
		typeof value.usedFallback !== "boolean"
	) {
		throw new Error("Invalid microphone evidence");
	}
	const deviceFingerprint = cleanOptionalString(value.deviceFingerprint, 64);
	if (deviceFingerprint && !/^[a-f0-9]{64}$/u.test(deviceFingerprint)) {
		throw new Error("Invalid microphone device fingerprint");
	}
	return stripUndefined({
		deviceLabel: cleanOptionalString(value.deviceLabel, 200),
		deviceFingerprint,
		selectionStatus: value.selectionStatus,
		usedFallback: value.usedFallback,
	});
}

function requireEntryId(id: string): void {
	if (!isVoiceHistoryEntryId(id)) throw new Error("Invalid voice history entry id");
}

function isStoredEntry(value: unknown): value is VoiceHistoryEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Partial<VoiceHistoryEntry>;
	return (
		typeof entry.id === "string" &&
		isVoiceHistoryEntryId(entry.id) &&
		typeof entry.goalId === "string" &&
		(entry.status === "completed" ||
			entry.status === "failed" ||
			entry.status === "discarded") &&
		typeof entry.createdAt === "string" &&
		typeof entry.updatedAt === "string" &&
		typeof entry.attemptCount === "number" &&
		typeof entry.text === "string" &&
		typeof entry.rawText === "string" &&
		typeof entry.canonicalText === "string" &&
		typeof entry.provider === "string" &&
		typeof entry.mime === "string" &&
		typeof entry.hasAudio === "boolean" &&
		typeof entry.audioBytes === "number" &&
			Boolean(entry.cleanup) &&
			typeof entry.cleanup?.requested === "boolean" &&
			typeof entry.cleanup?.applied === "boolean" &&
			(entry.contextSnapshotId === undefined ||
				isVoiceContextSnapshotId(entry.contextSnapshotId)) &&
			(entry.sessionId === undefined ||
				isVoiceSessionId(entry.sessionId)) &&
			(entry.utteranceId === undefined ||
				isVoiceUtteranceId(entry.utteranceId)) &&
			(entry.routing === undefined || isStoredRouting(entry.routing)) &&
			(entry.microphone === undefined ||
				isStoredMicrophoneEvidence(entry.microphone))
		);
}

function normalizeVoiceSessionId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isVoiceSessionId(value)) throw new Error("Invalid voice session id");
	return value;
}

function normalizeVoiceUtteranceId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isVoiceUtteranceId(value)) throw new Error("Invalid voice utterance id");
	return value;
}

function normalizeStoredEntry(entry: VoiceHistoryEntry): VoiceHistoryEntry {
	const userEdit = normalizeStoredUserEdit(
		(entry as VoiceHistoryEntry & { userEdit?: unknown }).userEdit,
	);
	const normalizedProvider = normalizeProviderId(entry.provider);
	const normalizedRouting = entry.routing ? normalizeRouting(entry.routing) : undefined;
	const normalizedEntry = {
		...entry,
		provider: normalizedProvider,
		...(normalizedRouting ? { routing: normalizedRouting } : {}),
	};
	// Ledgers written before realtime STT was removed may still carry `streaming`.
	const withoutStreaming = stripProperty(
		normalizedEntry as VoiceHistoryEntry & { streaming?: unknown },
		"streaming",
	);
	return userEdit
		? { ...withoutStreaming, userEdit }
		: stripProperty(withoutStreaming, "userEdit");
}

function normalizeStoredUserEdit(value: unknown): VoiceHistoryUserEdit | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<VoiceHistoryUserEdit> & Record<string, unknown>;
	if (
		typeof candidate.recordedAt !== "string" ||
		!Number.isFinite(Date.parse(candidate.recordedAt)) ||
		typeof candidate.elapsedMs !== "number" ||
		!Number.isFinite(candidate.elapsedMs) ||
		candidate.elapsedMs < 0
	) {
		return undefined;
	}
	if (candidate.outcome === "unmeasured") {
		try {
			return {
				outcome: "unmeasured",
				reason: normalizeUserEditUnmeasuredReason(candidate.reason),
				elapsedMs: Math.round(candidate.elapsedMs * 1_000) / 1_000,
				recordedAt: candidate.recordedAt,
			};
		} catch {
			return undefined;
		}
	}
	if (
		candidate.outcome !== "measured" ||
		candidate.unit !== "unicode-code-point" ||
		!isNonNegativeSafeInteger(candidate.originalCharacterCount) ||
		candidate.originalCharacterCount === 0 ||
		!isNonNegativeSafeInteger(candidate.submittedCharacterCount) ||
		!isNonNegativeSafeInteger(candidate.editDistance) ||
		typeof candidate.modificationRate !== "number" ||
		!Number.isFinite(candidate.modificationRate) ||
		candidate.modificationRate < 0 ||
		Math.abs(
			candidate.modificationRate -
				candidate.editDistance / candidate.originalCharacterCount
		) > Number.EPSILON * 8
	) {
		return undefined;
	}
	return {
		outcome: "measured",
		unit: "unicode-code-point",
		originalCharacterCount: candidate.originalCharacterCount,
		submittedCharacterCount: candidate.submittedCharacterCount,
		editDistance: candidate.editDistance,
		modificationRate: candidate.modificationRate,
		elapsedMs: Math.round(candidate.elapsedMs * 1_000) / 1_000,
		recordedAt: candidate.recordedAt,
	};
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStoredMicrophoneEvidence(
	value: unknown,
): value is VoiceMicrophoneEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const evidence = value as Partial<VoiceMicrophoneEvidence>;
	return (
		VOICE_MICROPHONE_SELECTION_STATUSES.some(
			(status) => status === evidence.selectionStatus,
		) &&
		typeof evidence.usedFallback === "boolean" &&
		(evidence.deviceLabel === undefined ||
			(typeof evidence.deviceLabel === "string" &&
				evidence.deviceLabel.length <= 200)) &&
		(evidence.deviceFingerprint === undefined ||
			(typeof evidence.deviceFingerprint === "string" &&
				/^[a-f0-9]{64}$/u.test(evidence.deviceFingerprint)))
	);
}

function isStoredRouting(value: unknown): value is VoiceSttRoutingMeta {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const routing = value as Partial<VoiceSttRoutingMeta>;
	if (
		typeof routing.primaryProvider !== "string" ||
		!routing.fallback ||
		typeof routing.fallback.enabled !== "boolean" ||
		typeof routing.fallback.eligible !== "boolean" ||
		typeof routing.fallback.used !== "boolean" ||
		!Array.isArray(routing.attempts)
	) {
		return false;
	}
	return routing.attempts.every(
		(attempt) =>
			Boolean(attempt) &&
			typeof attempt.provider === "string" &&
			typeof attempt.ok === "boolean" &&
			typeof attempt.durationMs === "number",
	);
}

function calculateUsage(entries: VoiceHistoryEntry[]): VoiceHistoryStorageUsage {
	const measuredUserEdits = entries.flatMap((entry) =>
		entry.userEdit?.outcome === "measured" ? [entry.userEdit] : [],
	);
	const totalOriginalCharacters = measuredUserEdits.reduce(
		(total, evidence) => total + evidence.originalCharacterCount,
		0,
	);
	const totalEditDistance = measuredUserEdits.reduce(
		(total, evidence) => total + evidence.editDistance,
		0,
	);
	return {
		entryCount: entries.length,
		completedCount: entries.filter((entry) => entry.status === "completed").length,
		failedCount: entries.filter((entry) => entry.status === "failed").length,
		discardedCount: entries.filter((entry) => entry.status === "discarded")
			.length,
		audioFileCount: entries.filter((entry) => entry.hasAudio).length,
		audioBytes: entries.reduce((total, entry) => total + entry.audioBytes, 0),
		userEdit: {
			measuredCount: measuredUserEdits.length,
			unmeasuredCount: entries.filter(
				(entry) => entry.userEdit?.outcome === "unmeasured",
			).length,
			totalOriginalCharacters,
			totalEditDistance,
			modificationRate:
				totalOriginalCharacters === 0
					? null
					: totalEditDistance / totalOriginalCharacters,
		},
	};
}

function stripUndefined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== undefined),
	) as T;
}

function stripProperty<
	T extends object,
	K extends keyof T,
>(value: T, key: K): Omit<T, K> {
	const { [key]: _removed, ...rest } = value;
	return rest;
}
