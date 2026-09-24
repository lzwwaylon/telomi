import {
	existsSync,
	readFileSync,
	unlinkSync,
	} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { voiceDataRoot } from "../workspaces/server-runtime-paths.js";
import { assertInsideRoot } from "../lib/paths.js";
import { sha256 } from "../lib/hash.js";
import { DEFAULT_VOICE_VAD_CONFIG } from "../audio/voice-vad.js";
import {
	VOICE_HARDWARE_EVALUATION_CONDITIONS,
	VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
	type VoiceHardwareEvaluationCondition,
	type VoiceHardwareEvaluationConfirmations,
	type VoiceHardwareEvaluationPublicCapture,
	type VoiceHardwareEvaluationSnapshot,
} from "../../shared/voice-hardware-evaluation.js";
import type { VoiceMicrophoneSelectionStatus } from "../../shared/voice-microphone.js";
import {
	evaluateVoiceCorpusCoverage,
	loadVoiceEvaluationManifestFile,
	parseVoiceEvaluationManifest,
	type VoiceCorpusCoverage,
	type VoiceEvaluationCase,
} from "./evaluation.js";
import type { VoiceHistoryStore } from "./history.js";
import { MANAGED_AUDIO_CONNECTION_ID } from "../../shared/connections.js";

export {
	VOICE_HARDWARE_EVALUATION_CONDITIONS,
	VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
} from "../../shared/voice-hardware-evaluation.js";
export type {
	VoiceHardwareEvaluationCondition,
	VoiceHardwareEvaluationConfirmations,
} from "../../shared/voice-hardware-evaluation.js";
import { writeFileAtomic } from "../lib/fs.js";
import { toErrorMessage } from "../lib/values.js";

const HARDWARE_EVIDENCE_SCHEMA_VERSION = 2;
const HARDWARE_EVALUATION_TERMS = ["MFlow", "PostgreSQL", "六成"] as const;
const HARDWARE_VAD_SLICE = "hardware-vad";
const DEFAULT_BASELINE_CONDITION_NOTE =
	"Normal close-range dictation without an intentionally introduced acoustic stress condition";
const ELIGIBLE_SELECTION_STATUSES = new Set<VoiceMicrophoneSelectionStatus>([
	"default",
	"built-in",
	"exact",
	"remapped",
]);

export interface VoiceHardwareEvaluationPromotionInput {
	historyId: string;
	hardwareName: string;
	speakerId: string;
	condition?: VoiceHardwareEvaluationCondition;
	conditionNote?: string;
	confirmations: VoiceHardwareEvaluationConfirmations;
}

export interface VoiceHardwareEvaluationCapture {
	caseId: string;
	microphoneId: string;
	condition: VoiceHardwareEvaluationCondition;
	conditionNote: string;
	historyId: string;
	recordedAt: string;
	promotedAt: string;
	referenceText: string;
	language: "zh";
	metric: "cer";
	speakerId: string;
	hardwareName: string;
	deviceLabel: string;
	deviceFingerprint: string;
	selectionStatus: VoiceMicrophoneSelectionStatus;
	audioSha256: string;
	audioBytes: number;
	mime: string;
	durationSec?: number;
	fixturePath: string;
}

interface StoredVoiceHardwareEvidence {
	schemaVersion: typeof HARDWARE_EVIDENCE_SCHEMA_VERSION;
	baseManifestPath: string;
	updatedAt: string;
	captures: VoiceHardwareEvaluationCapture[];
}

export interface VoiceHardwareEvaluationPromotionResult {
	capture: VoiceHardwareEvaluationCapture;
	registryPath: string;
	manifestPath: string;
	coverage: VoiceCorpusCoverage;
}

export interface VoiceHardwareEvaluationRemovalResult {
	removed: VoiceHardwareEvaluationCapture;
	privateFixtureDeleted: boolean;
	registryPath: string;
	manifestPath: string;
	coverage: VoiceCorpusCoverage;
}

export interface VoiceHardwareEvaluationMaterializationResult {
	registryPath: string;
	manifestPath: string;
	coverage: VoiceCorpusCoverage;
}

interface VoiceHardwareEvaluationStoreOptions {
	historyStore: Pick<VoiceHistoryStore, "getEntry" | "readAudio">;
	repositoryRoot: string;
	appRoot: string;
	baseManifestPath: string;
	now?: () => Date;
}

/**
 * Deep local release-evidence Module.
 *
 * Interface: promote one explicitly confirmed Voice History capture, or remove
 * one promoted case and its unshared private fixture.
 * Implementation: validates provenance, manages ignored content-addressed audio,
 * updates the local registry and materializes a complete evaluation manifest.
 * Nothing here grants confirmation implicitly.
 */
export class VoiceHardwareEvaluationStore {
	private readonly historyStore: VoiceHardwareEvaluationStoreOptions["historyStore"];
	private readonly repositoryRoot: string;
	private readonly appRoot: string;
	private readonly baseManifestPath: string;
	private readonly evidenceRoot: string;
	private readonly fixtureRoot: string;
	private readonly now: () => Date;
	readonly registryPath: string;
	readonly manifestPath: string;

	constructor(options: VoiceHardwareEvaluationStoreOptions) {
		this.historyStore = options.historyStore;
		this.repositoryRoot = resolve(options.repositoryRoot);
		this.appRoot = resolve(options.appRoot);
		this.baseManifestPath = resolve(options.baseManifestPath);
		assertInsideRoot(this.repositoryRoot, this.appRoot, "appRoot", { allowRoot: false });
		assertInsideRoot(this.appRoot, this.baseManifestPath, "baseManifestPath", { allowRoot: false });
		this.evidenceRoot = resolve(
			voiceDataRoot(this.appRoot),
			"hardware-evaluations",
		);
		this.fixtureRoot = resolve(
			voiceDataRoot(this.appRoot),
			"evaluation-fixtures",
		);
		this.registryPath = resolve(this.evidenceRoot, "evidence.json");
		this.manifestPath = resolve(
			this.evidenceRoot,
			"local-qwen-v1.hardware.json",
		);
		this.now = options.now ?? (() => new Date());
	}

	getSnapshot(): VoiceHardwareEvaluationSnapshot {
		const registry = this.readRegistry();
		this.assertPrivateFixtures(registry.captures);
		const coverage = evaluateVoiceCorpusCoverage(
			this.buildManifest(registry.captures),
		);
		return {
			prompt: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
			updatedAt: registry.updatedAt,
			captures: registry.captures.map(toPublicCapture),
			coverage: {
				complete: coverage.complete,
				missingSlices: coverage.missingSlices,
				microphones: coverage.microphones,
			},
		};
	}

	promote(
		input: VoiceHardwareEvaluationPromotionInput,
	): VoiceHardwareEvaluationPromotionResult {
		const condition = normalizeHardwareCondition(input.condition);
		requireConfirmations(input.confirmations, condition);
		const hardwareName = cleanRequired(input.hardwareName, "hardwareName", 200);
		const speakerId = cleanIdentifier(input.speakerId, "speakerId");
		const conditionNote = condition === "baseline"
			? input.conditionNote === undefined
				? DEFAULT_BASELINE_CONDITION_NOTE
				: cleanRequired(input.conditionNote, "conditionNote", 500)
			: cleanRequired(input.conditionNote, "conditionNote", 500);
		const entry = this.historyStore.getEntry(input.historyId);
		if (!entry) throw new Error("Voice History entry not found");
		if (entry.status !== "completed") {
			throw new Error("hardware evaluation requires a completed transcription");
		}
		if (!entry.microphone?.deviceLabel || !entry.microphone.deviceFingerprint) {
			throw new Error("hardware evaluation requires microphone capture evidence");
		}
		if (entry.microphone.usedFallback) {
			throw new Error("fallback microphone captures cannot be hardware verified");
		}
		if (!ELIGIBLE_SELECTION_STATUSES.has(entry.microphone.selectionStatus)) {
			throw new Error(
				`microphone selection status ${entry.microphone.selectionStatus} is not eligible for hardware verification`,
			);
		}
		const retainedAudio = this.historyStore.readAudio(entry.id);
		if (!retainedAudio?.buffer.length) {
			throw new Error("hardware evaluation requires retained source audio");
		}

		const audioSha256 = sha256(retainedAudio.buffer);
		const fixturePath = resolve(
			this.fixtureRoot,
			`${audioSha256}.${extensionForMime(retainedAudio.mime)}`,
		);
		assertInsideRoot(this.fixtureRoot, fixturePath, "hardware fixture path", { allowRoot: false });

		const registry = this.readRegistry();
		const microphoneId = hardwareMicrophoneId(hardwareName);
		const caseId = hardwareCaptureCaseId(microphoneId, condition);
		if (registry.captures.some((capture) => capture.caseId === caseId)) {
			throw new Error(
				`hardware evaluation already contains ${hardwareName} condition ${condition}`,
			);
		}
		if (registry.captures.some((capture) => capture.historyId === entry.id)) {
			throw new Error("Voice History capture was already promoted");
		}
		const baseline = registry.captures.find(
			(capture) =>
				capture.microphoneId === microphoneId &&
				capture.condition === "baseline",
		);
		if (condition === "baseline") {
			if (registry.captures.some((capture) => capture.microphoneId === microphoneId)) {
				throw new Error(`hardware evaluation already contains ${hardwareName}`);
			}
			if (
				registry.captures.some(
					(capture) =>
						capture.deviceFingerprint === entry.microphone!.deviceFingerprint,
				)
			) {
				throw new Error(
					"hardware evaluation already contains the same device fingerprint",
				);
			}
		} else {
			if (!baseline) {
				throw new Error(
					"real-condition capture requires an existing verified baseline for the same hardware",
				);
			}
			if (baseline.deviceFingerprint !== entry.microphone.deviceFingerprint) {
				throw new Error(
					"real-condition capture must match the verified baseline device fingerprint",
				);
			}
			if (baseline.speakerId !== speakerId) {
				throw new Error(
					"real-condition capture must use the baseline speaker identity",
				);
			}
		}
		writeBufferOnce(fixturePath, retainedAudio.buffer, audioSha256);
		const promotedAt = this.now().toISOString();
		const capture: VoiceHardwareEvaluationCapture = {
			caseId,
			microphoneId,
			condition,
			conditionNote,
			historyId: entry.id,
			recordedAt: entry.createdAt,
			promotedAt,
			referenceText: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
			language: "zh",
			metric: "cer",
			speakerId,
			hardwareName,
			deviceLabel: entry.microphone.deviceLabel,
			deviceFingerprint: entry.microphone.deviceFingerprint,
			selectionStatus: entry.microphone.selectionStatus,
			audioSha256,
			audioBytes: retainedAudio.buffer.length,
			mime: retainedAudio.mime,
			...(entry.durationSec === undefined
				? {}
				: { durationSec: entry.durationSec }),
			fixturePath: repositoryRelativePath(this.repositoryRoot, fixturePath),
		};
		const updatedRegistry: StoredVoiceHardwareEvidence = {
			...registry,
			updatedAt: promotedAt,
			captures: [...registry.captures, capture],
		};
		const manifest = this.buildManifest(updatedRegistry.captures);
		writeFileAtomic(this.registryPath, `${JSON.stringify(updatedRegistry, null, 2)}\n`);
		writeFileAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		return {
			capture,
			registryPath: this.registryPath,
			manifestPath: this.manifestPath,
			coverage: evaluateVoiceCorpusCoverage(manifest),
		};
	}

	remove(caseIdInput: string): VoiceHardwareEvaluationRemovalResult {
		const caseId = cleanIdentifier(caseIdInput, "caseId");
		const registry = this.readRegistry();
		const removed = registry.captures.find(
			(capture) => capture.caseId === caseId,
		);
		if (!removed) throw new Error("hardware evaluation case not found");
		const remainingCaptures = registry.captures.filter(
			(capture) => capture.caseId !== caseId,
		);
		if (
			removed.condition === "baseline" &&
			remainingCaptures.some(
				(capture) => capture.microphoneId === removed.microphoneId,
			)
		) {
			throw new Error(
				"remove real-condition captures before removing their hardware baseline",
			);
		}
		const fixturePath = resolve(this.repositoryRoot, removed.fixturePath);
		assertInsideRoot(this.fixtureRoot, fixturePath, "hardware fixture path", { allowRoot: false });
		const stillReferenced = remainingCaptures.some(
			(capture) => capture.fixturePath === removed.fixturePath,
		);
		const updatedAt = this.now().toISOString();
		const updatedRegistry: StoredVoiceHardwareEvidence = {
			...registry,
			updatedAt,
			captures: remainingCaptures,
		};
		const manifest = this.buildManifest(remainingCaptures);
		writeFileAtomic(this.registryPath, `${JSON.stringify(updatedRegistry, null, 2)}\n`);
		writeFileAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		let privateFixtureDeleted = false;
		if (!stillReferenced && existsSync(fixturePath)) {
			unlinkSync(fixturePath);
			privateFixtureDeleted = true;
		}
		return {
			removed,
			privateFixtureDeleted,
			registryPath: this.registryPath,
			manifestPath: this.manifestPath,
			coverage: evaluateVoiceCorpusCoverage(manifest),
		};
	}

	rematerialize(): VoiceHardwareEvaluationMaterializationResult {
		const registry = this.readRegistry();
		this.assertPrivateFixtures(registry.captures);
		const manifest = this.buildManifest(registry.captures);
		writeFileAtomic(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
		writeFileAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		return {
			registryPath: this.registryPath,
			manifestPath: this.manifestPath,
			coverage: evaluateVoiceCorpusCoverage(manifest),
		};
	}

	private assertPrivateFixtures(
		captures: VoiceHardwareEvaluationCapture[],
	): void {
		for (const capture of captures) {
			const fixturePath = resolve(this.repositoryRoot, capture.fixturePath);
			assertInsideRoot(this.fixtureRoot, fixturePath, "hardware fixture path", { allowRoot: false });
			if (!existsSync(fixturePath)) {
				throw new Error(`hardware evaluation fixture is missing: ${capture.caseId}`);
			}
			const fixture = readFileSync(fixturePath);
			if (
				fixture.length !== capture.audioBytes ||
				sha256(fixture) !== capture.audioSha256
			) {
				throw new Error(`hardware evaluation fixture is corrupted: ${capture.caseId}`);
			}
		}
	}

	private readRegistry(): StoredVoiceHardwareEvidence {
		const baseManifestPath = repositoryRelativePath(
			this.repositoryRoot,
			this.baseManifestPath,
		);
		if (!existsSync(this.registryPath)) {
			return {
				schemaVersion: HARDWARE_EVIDENCE_SCHEMA_VERSION,
				baseManifestPath,
				updatedAt: this.now().toISOString(),
				captures: [],
			};
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.registryPath, "utf8"));
		} catch (error) {
			throw new Error(
				`failed to read hardware evidence registry: ${toErrorMessage(error)}`,
			);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("invalid hardware evidence registry");
		}
		const value = parsed as {
			schemaVersion?: number;
			baseManifestPath?: unknown;
			updatedAt?: unknown;
			captures?: unknown[];
		};
		if (
			value.schemaVersion !== HARDWARE_EVIDENCE_SCHEMA_VERSION ||
			value.baseManifestPath !== baseManifestPath ||
			!isIsoDate(value.updatedAt) ||
			!Array.isArray(value.captures)
		) {
			throw new Error("invalid hardware evidence registry");
		}
		const captures = value.captures.map(normalizeStoredCapture);
		if (captures.some((capture) => capture === undefined)) {
			throw new Error("invalid hardware evidence registry");
		}
		const normalizedCaptures = captures as VoiceHardwareEvaluationCapture[];
		if (
			!normalizedCaptures.every((capture) =>
				this.isExpectedStoredCapture(capture),
			) ||
			!hasValidHardwareCaptureGraph(normalizedCaptures)
		) {
			throw new Error("invalid hardware evidence registry");
		}
		return {
			schemaVersion: HARDWARE_EVIDENCE_SCHEMA_VERSION,
			baseManifestPath,
			updatedAt: value.updatedAt,
			captures: normalizedCaptures,
		};
	}

	private isExpectedStoredCapture(
		capture: VoiceHardwareEvaluationCapture,
	): boolean {
		const expectedMicrophoneId = hardwareMicrophoneId(capture.hardwareName);
		const expectedCaseId = hardwareCaptureCaseId(
			expectedMicrophoneId,
			capture.condition,
		);
		const expectedFixturePath = repositoryRelativePath(
			this.repositoryRoot,
			resolve(
				this.fixtureRoot,
				`${capture.audioSha256}.${extensionForMime(capture.mime)}`,
			),
		);
		return (
			capture.microphoneId === expectedMicrophoneId &&
			capture.caseId === expectedCaseId &&
			capture.fixturePath === expectedFixturePath
		);
	}

	private buildManifest(captures: VoiceHardwareEvaluationCapture[]) {
		const base = loadVoiceEvaluationManifestFile(this.baseManifestPath);
		const baselineCaptures = captures.filter(
			(capture) => capture.condition === "baseline",
		);
		const conditionCoverageSlices = baselineCaptures.flatMap((capture) =>
			(["room-noise", "keyboard-noise"] as const).map((condition) =>
				realConditionCoverageSlice(capture.microphoneId, condition),
			),
		);
		if (baselineCaptures.length > 0) {
			conditionCoverageSlices.push("real-far-field");
		}
		return parseVoiceEvaluationManifest({
			...base,
			name: `${base.name}-hardware-local`,
			corpusVersion: `${base.corpusVersion}+hardware-${baselineCaptures.length}-conditions-${captures.length}-vad-ab-v1`,
			description: `${base.description} This local-only materialization adds explicitly confirmed private physical-microphone condition captures as same-audio VAD off/on pairs and must not be committed.`,
			coverageRequirements: {
				...base.coverageRequirements,
				requiredSlices: [
					...new Set([
						...base.coverageRequirements.requiredSlices,
						HARDWARE_VAD_SLICE,
						...conditionCoverageSlices,
					]),
				],
			},
			cases: [
				...base.cases,
				...captures.flatMap(toEvaluationCases),
			],
		});
	}
}

function toPublicCapture(
	capture: VoiceHardwareEvaluationCapture,
): VoiceHardwareEvaluationPublicCapture {
	return {
		caseId: capture.caseId,
		microphoneId: capture.microphoneId,
		condition: capture.condition,
		conditionNote: capture.conditionNote,
		historyId: capture.historyId,
		recordedAt: capture.recordedAt,
		promotedAt: capture.promotedAt,
		speakerId: capture.speakerId,
		hardwareName: capture.hardwareName,
		deviceLabel: capture.deviceLabel,
		selectionStatus: capture.selectionStatus,
		audioBytes: capture.audioBytes,
		...(capture.durationSec === undefined
			? {}
			: { durationSec: capture.durationSec }),
	};
}

function toEvaluationCases(
	capture: VoiceHardwareEvaluationCapture,
): VoiceEvaluationCase[] {
	return [
		toEvaluationCase(capture, false),
		toEvaluationCase(capture, true),
	];
}

function toEvaluationCase(
	capture: VoiceHardwareEvaluationCapture,
	vadEnabled: boolean,
): VoiceEvaluationCase {
	const vadMode = vadEnabled ? "on" : "off";
	return {
		id: vadEnabled ? `${capture.caseId}-vad-on` : capture.caseId,
		description: `Local physical-microphone ${capture.condition} capture from ${capture.hardwareName} with neural VAD ${vadMode}`,
		audio: {
			path: capture.fixturePath,
			mime: capture.mime,
			sha256: capture.audioSha256,
			...(capture.durationSec === undefined
				? {}
				: { durationSec: capture.durationSec }),
			source: {
				kind: "user-hardware-capture",
				name: `${capture.hardwareName} ${capture.condition}`,
				license: "private-local-evaluation-only",
			},
		},
		referenceText: capture.referenceText,
		referenceProvenance: {
			kind: "human-verified",
			note: `The local operator explicitly confirmed reading the fixed prompt through ${capture.hardwareName} under ${capture.condition}: ${capture.conditionNote}; capture ${capture.historyId} recorded ${capture.recordedAt}.`,
		},
		language: capture.language,
		metrics: [capture.metric],
		slices: hardwareConditionSlices(capture),
		speaker: { id: capture.speakerId, kind: "human" },
		microphone: {
			id: capture.microphoneId,
			verification: "hardware-verified",
			note: `Operator-confirmed ${capture.hardwareName}; condition ${capture.condition}; browser label ${capture.deviceLabel}; selection ${capture.selectionStatus}; fingerprint ${capture.deviceFingerprint.slice(0, 16)}...`,
		},
		terms: HARDWARE_EVALUATION_TERMS.map((canonical) => ({
			canonical,
			expectedOccurrences: 1,
		})),
		forbiddenTerms: [],
		acceptance: {
			stage: "raw",
			maxCer: 0.15,
			minTermPrecision: 1,
			minTermRecall: 1,
			minExactCanonicalRate: 1,
		},
		pipeline: {
			languageHint: "zh",
			provider: MANAGED_AUDIO_CONNECTION_ID,
			cleanupRequested: false,
			vad: {
				...DEFAULT_VOICE_VAD_CONFIG,
				enabled: vadEnabled,
			},
			glossary: [
				{
					id: "hardware-mflow",
					canonical: "MFlow",
					language: "en",
					enabled: true,
					source: "manual",
				},
				{
					id: "hardware-postgresql",
					canonical: "PostgreSQL",
					language: "en",
					enabled: true,
					source: "manual",
				},
			],
		},
	};
}

function requireConfirmations(
	confirmations: VoiceHardwareEvaluationConfirmations,
	condition: VoiceHardwareEvaluationCondition,
): void {
	if (!confirmations.physicalHardware) {
		throw new Error("physical hardware confirmation is required");
	}
	if (!confirmations.exactPrompt) {
		throw new Error("exact fixed-prompt confirmation is required");
	}
	if (!confirmations.privateAudioCopy) {
		throw new Error("private audio copy confirmation is required");
	}
	if (condition !== "baseline" && !confirmations.realCondition) {
		throw new Error("real acoustic condition confirmation is required");
	}
}

function normalizeHardwareCondition(
	value: unknown,
): VoiceHardwareEvaluationCondition {
	if (value === undefined) return "baseline";
	if (
		typeof value !== "string" ||
		!VOICE_HARDWARE_EVALUATION_CONDITIONS.includes(
			value as VoiceHardwareEvaluationCondition,
		)
	) {
		throw new Error(
			`condition must be one of ${VOICE_HARDWARE_EVALUATION_CONDITIONS.join(", ")}`,
		);
	}
	return value as VoiceHardwareEvaluationCondition;
}

function hardwareMicrophoneId(hardwareName: string): string {
	return `hardware-mic-${sha256(Buffer.from(hardwareName.toLocaleLowerCase())).slice(0, 12)}`;
}

function hardwareCaptureCaseId(
	microphoneId: string,
	condition: VoiceHardwareEvaluationCondition,
): string {
	return condition === "baseline"
		? microphoneId
		: `${microphoneId}-${condition}`;
}

function realConditionCoverageSlice(
	microphoneId: string,
	condition: Exclude<VoiceHardwareEvaluationCondition, "baseline">,
): string {
	const suffix = microphoneId.replace(/^hardware-mic-/u, "");
	return `hardware-real-${condition}-${suffix}`;
}

function hardwareConditionSlices(
	capture: VoiceHardwareEvaluationCapture,
): string[] {
	const slices = ["hardware-microphone", HARDWARE_VAD_SLICE];
	if (capture.condition !== "baseline") {
		slices.push(
			`real-${capture.condition}`,
			realConditionCoverageSlice(capture.microphoneId, capture.condition),
		);
	}
	return slices;
}

function normalizeStoredCapture(
	value: unknown,
): VoiceHardwareEvaluationCapture | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return isStoredCapture(value) ? value : undefined;
}

function hasValidHardwareCaptureGraph(
	captures: VoiceHardwareEvaluationCapture[],
): boolean {
	if (
		!hasUniqueValues(captures.map((capture) => capture.caseId)) ||
		!hasUniqueValues(captures.map((capture) => capture.historyId)) ||
		!hasUniqueValues(captures.map((capture) => capture.audioSha256)) ||
		!hasUniqueValues(
			captures.map(
				(capture) => `${capture.microphoneId}:${capture.condition}`,
			),
		)
	) {
		return false;
	}
	const baselines = new Map<string, VoiceHardwareEvaluationCapture>();
	const fingerprintOwners = new Map<string, string>();
	for (const capture of captures) {
		if (capture.condition === "baseline") {
			if (baselines.has(capture.microphoneId)) return false;
			baselines.set(capture.microphoneId, capture);
		}
		const fingerprintOwner = fingerprintOwners.get(capture.deviceFingerprint);
		if (fingerprintOwner && fingerprintOwner !== capture.microphoneId) return false;
		fingerprintOwners.set(capture.deviceFingerprint, capture.microphoneId);
	}
	for (const capture of captures) {
		const baseline = baselines.get(capture.microphoneId);
		if (
			!baseline ||
			baseline.deviceFingerprint !== capture.deviceFingerprint ||
			baseline.hardwareName.toLocaleLowerCase() !==
				capture.hardwareName.toLocaleLowerCase() ||
			baseline.speakerId !== capture.speakerId
		) {
			return false;
		}
	}
	return true;
}

function isStoredCapture(value: unknown): value is VoiceHardwareEvaluationCapture {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const capture = value as Partial<VoiceHardwareEvaluationCapture>;
	return (
		isSafeIdentifier(capture.caseId) &&
		isSafeIdentifier(capture.microphoneId) &&
		typeof capture.condition === "string" &&
		VOICE_HARDWARE_EVALUATION_CONDITIONS.includes(
			capture.condition as VoiceHardwareEvaluationCondition,
		) &&
		isBoundedStoredString(capture.conditionNote, 500) &&
		isSafeIdentifier(capture.historyId) &&
		isIsoDate(capture.recordedAt) &&
		isIsoDate(capture.promotedAt) &&
		capture.referenceText === VOICE_HARDWARE_EVALUATION_PROMPT_ZH &&
		capture.language === "zh" &&
		capture.metric === "cer" &&
		isSafeIdentifier(capture.speakerId) &&
		isBoundedStoredString(capture.hardwareName, 200) &&
		isBoundedStoredString(capture.deviceLabel, 200) &&
		typeof capture.deviceFingerprint === "string" &&
		/^[a-f0-9]{64}$/u.test(capture.deviceFingerprint) &&
		typeof capture.selectionStatus === "string" &&
		ELIGIBLE_SELECTION_STATUSES.has(
			capture.selectionStatus as VoiceMicrophoneSelectionStatus,
		) &&
		typeof capture.audioSha256 === "string" &&
		/^[a-f0-9]{64}$/u.test(capture.audioSha256) &&
		Number.isSafeInteger(capture.audioBytes) &&
		(capture.audioBytes ?? 0) > 0 &&
		typeof capture.mime === "string" &&
		/^audio\/[A-Za-z0-9.+-]+(?:\s*;.*)?$/u.test(capture.mime) &&
		(capture.durationSec === undefined ||
			(typeof capture.durationSec === "number" &&
				Number.isFinite(capture.durationSec) &&
				capture.durationSec > 0)) &&
		typeof capture.fixturePath === "string" &&
		capture.fixturePath.length > 0
	);
}

function isIsoDate(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Number.isFinite(Date.parse(value))
	);
}

function isBoundedStoredString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value === value.trim() &&
		value.length > 0 &&
		value.length <= maxLength
	);
}

function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 120 &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
	);
}

function hasUniqueValues(values: string[]): boolean {
	return new Set(values).size === values.length;
}

function cleanRequired(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const cleaned = value.trim();
	if (!cleaned || cleaned.length > maxLength) {
		throw new Error(`${field} must contain 1 to ${maxLength} characters`);
	}
	return cleaned;
}

function cleanIdentifier(value: unknown, field: string): string {
	const cleaned = cleanRequired(value, field, 120);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(cleaned)) {
		throw new Error(`${field} must be a safe identifier`);
	}
	return cleaned;
}

function writeBufferOnce(path: string, buffer: Buffer, digest: string): void {
	if (existsSync(path)) {
		if (sha256(readFileSync(path)) !== digest) {
			throw new Error("existing hardware fixture SHA-256 mismatch");
		}
		return;
	}
	writeFileAtomic(path, buffer);
}

function repositoryRelativePath(repositoryRoot: string, path: string): string {
	assertInsideRoot(repositoryRoot, path, "repository path", { allowRoot: false });
	return relative(repositoryRoot, path).split(sep).join("/");
}

function extensionForMime(mime: string): string {
	const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (normalized === "audio/webm") return "webm";
	if (normalized === "audio/ogg") return "ogg";
	if (normalized === "audio/wav" || normalized === "audio/x-wav") return "wav";
	if (normalized === "audio/mpeg") return "mp3";
	if (normalized === "audio/mp4" || normalized === "audio/aac") return "m4a";
	if (normalized === "audio/flac") return "flac";
	return "audio";
}
