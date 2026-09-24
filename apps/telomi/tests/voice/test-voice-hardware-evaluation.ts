import { sha256 } from "../../server/lib/hash.js";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DEFAULT_VOICE_VAD_CONFIG } from "../../server/audio/voice-vad.js";
import { VoiceEvaluationFixtureLoader } from "../../server/voice/evaluation-fixtures.js";
import {
	evaluateVoiceCorpusCoverage,
	loadVoiceEvaluationManifestFile,
} from "../../server/voice/evaluation.js";
import {
	VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
	VoiceHardwareEvaluationStore,
} from "../../server/voice/hardware-evaluation.js";
import { VoiceHistoryStore } from "../../server/voice/history.js";

test("a confirmed physical capture becomes a private replayable hardware evaluation case", async () => {
	const root = mkdtempSync(resolve(tmpdir(), "voice-hardware-eval-"));
	const repositoryRoot = resolve(root, "repository");
	const appRoot = resolve(repositoryRoot, "apps", "telomi");
	const runtimeRoot = resolve(root, "runtime");
	const baseManifestPath = resolve(appRoot, "voice-evals", "base.json");
	const baseAudio = Buffer.from("base evaluation audio");
	const captureAudio = Buffer.from("private physical microphone audio");
	try {
		await mkdir(dirname(baseManifestPath), { recursive: true });
		await mkdir(resolve(repositoryRoot, "fixtures"), { recursive: true });
		writeFileSync(resolve(repositoryRoot, "fixtures", "base.wav"), baseAudio);
		writeFileSync(
			baseManifestPath,
			JSON.stringify(baseEvaluationManifest(baseAudio)),
		);

		const history = new VoiceHistoryStore(runtimeRoot, {
			now: () => new Date("2026-07-21T08:00:00.000Z"),
		});
		history.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const entry = history.record({
			goalId: "goal-hardware-eval",
			status: "completed",
			text: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
			rawText: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
			canonicalText: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
			provider: "telomi-audio",
			mime: "audio/webm",
			audio: captureAudio,
			microphone: {
				deviceLabel: "MacBook Pro麦克风",
				deviceFingerprint: "a".repeat(64),
				selectionStatus: "built-in",
				usedFallback: false,
			},
		}).entry!;

		const hardwareEvaluations = new VoiceHardwareEvaluationStore({
			historyStore: history,
			repositoryRoot,
			appRoot,
			baseManifestPath,
			now: () => new Date("2026-07-21T08:01:00.000Z"),
		});
		const promoted = hardwareEvaluations.promote({
			historyId: entry.id,
			hardwareName: "Apple MacBook Pro Built-in Microphone",
			speakerId: "local-user",
			confirmations: {
				physicalHardware: true,
				exactPrompt: true,
				privateAudioCopy: true,
			},
		});

		assert.equal(promoted.capture.historyId, entry.id);
		assert.equal(promoted.capture.hardwareName, "Apple MacBook Pro Built-in Microphone");
		assert.equal(promoted.capture.deviceFingerprint, "a".repeat(64));
		assert.equal(promoted.capture.microphoneId, promoted.capture.caseId);
		assert.equal(promoted.capture.condition, "baseline");
		assert.equal(promoted.capture.audioSha256, sha256(captureAudio));
		assert.equal(promoted.capture.referenceText, VOICE_HARDWARE_EVALUATION_PROMPT_ZH);
		assert.equal(existsSync(promoted.manifestPath), true);
		assert.equal(existsSync(promoted.registryPath), true);

		const manifest = loadVoiceEvaluationManifestFile(promoted.manifestPath);
		assert.equal(manifest.cases.length, 3);
		const hardwareCases = manifest.cases.filter(
			(candidate) => candidate.microphone.verification === "hardware-verified",
		);
		assert.equal(hardwareCases.length, 2);
		const hardwareCase = hardwareCases.find(
			(candidate) => candidate.id === promoted.capture.caseId,
		)!;
		const hardwareVadCase = hardwareCases.find(
			(candidate) => candidate.id === `${promoted.capture.caseId}-vad-on`,
		)!;
		assert.equal(hardwareCase.referenceProvenance.kind, "human-verified");
		assert.equal(hardwareCase.referenceText, VOICE_HARDWARE_EVALUATION_PROMPT_ZH);
		assert.equal(hardwareCase.pipeline.vad.enabled, false);
		assert.equal(hardwareVadCase.pipeline.vad.enabled, true);
		assert.equal(hardwareVadCase.audio.sha256, hardwareCase.audio.sha256);
		assert.equal(hardwareVadCase.referenceText, hardwareCase.referenceText);
		assert.equal(hardwareVadCase.microphone.id, hardwareCase.microphone.id);
		assert.deepEqual(hardwareVadCase.slices, [
			"hardware-microphone",
			"hardware-vad",
		]);
		assert.deepEqual(hardwareCase.terms, [
			{ canonical: "MFlow", expectedOccurrences: 1 },
			{ canonical: "PostgreSQL", expectedOccurrences: 1 },
			{ canonical: "六成", expectedOccurrences: 1 },
		]);
		assert.deepEqual(
			hardwareCase.pipeline.glossary.map((entry) => entry.canonical),
			["MFlow", "PostgreSQL"],
			"score-only terms must not alter the ASR glossary prompt",
		);
		assert.deepEqual(hardwareVadCase.terms, hardwareCase.terms);
		assert.deepEqual(hardwareVadCase.pipeline.glossary, hardwareCase.pipeline.glossary);
		assert.equal(evaluateVoiceCorpusCoverage(manifest).microphones.actual, 1);
		const microphoneSuffix = promoted.capture.microphoneId.replace(
			/^hardware-mic-/u,
			"",
		);
		assert.deepEqual(
			manifest.coverageRequirements.requiredSlices.filter((slice) =>
				slice.startsWith("hardware-real-"),
			),
			[
				`hardware-real-room-noise-${microphoneSuffix}`,
				`hardware-real-keyboard-noise-${microphoneSuffix}`,
			],
		);
		assert.equal(
			manifest.coverageRequirements.requiredSlices.includes("real-far-field"),
			true,
		);

		const fixtureLoader = new VoiceEvaluationFixtureLoader({
			repositoryRoot,
			cacheRoot: resolve(appRoot, ".pi", "voice", "unused-cache"),
		});
		assert.deepEqual(
			await fixtureLoader.load(hardwareCase, { allowRemote: false }),
			captureAudio,
		);
		assert.equal(
			readFileSync(promoted.registryPath, "utf8").includes(entry.microphone?.deviceLabel ?? ""),
			true,
		);

		const validManifest = readFileSync(promoted.manifestPath, "utf8");
		writeFileSync(
			resolve(repositoryRoot, promoted.capture.fixturePath),
			Buffer.from("corrupted private fixture"),
		);
		assert.throws(
			() => hardwareEvaluations.rematerialize(),
			/hardware evaluation fixture is corrupted/i,
		);
		assert.equal(
			readFileSync(promoted.manifestPath, "utf8"),
			validManifest,
			"fixture validation must fail before replacing the last valid manifest",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two hardware slots cannot be satisfied by the same browser device fingerprint", async () => {
	const root = mkdtempSync(resolve(tmpdir(), "voice-hardware-duplicate-"));
	const repositoryRoot = resolve(root, "repository");
	const appRoot = resolve(repositoryRoot, "apps", "telomi");
	const runtimeRoot = resolve(root, "runtime");
	const baseManifestPath = resolve(appRoot, "voice-evals", "base.json");
	const baseAudio = Buffer.from("base evaluation audio");
	try {
		await mkdir(dirname(baseManifestPath), { recursive: true });
		await mkdir(resolve(repositoryRoot, "fixtures"), { recursive: true });
		writeFileSync(resolve(repositoryRoot, "fixtures", "base.wav"), baseAudio);
		writeFileSync(baseManifestPath, JSON.stringify(baseEvaluationManifest(baseAudio)));

		let now = new Date("2026-07-21T09:00:00.000Z");
		const history = new VoiceHistoryStore(runtimeRoot, { now: () => now });
		history.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const record = (audio: string) =>
			history.record({
				goalId: "goal-hardware-duplicate",
				status: "completed",
				text: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
				provider: "telomi-audio",
				mime: "audio/webm",
				audio: Buffer.from(audio),
				microphone: {
					deviceLabel: "Same physical input",
					deviceFingerprint: "b".repeat(64),
					selectionStatus: "exact",
					usedFallback: false,
				},
			}).entry!;
		const first = record("first private capture");
		now = new Date("2026-07-21T09:01:00.000Z");
		const second = record("second private capture");
		const hardwareEvaluations = new VoiceHardwareEvaluationStore({
			historyStore: history,
			repositoryRoot,
			appRoot,
			baseManifestPath,
			now: () => new Date("2026-07-21T09:02:00.000Z"),
		});
		const confirmations = {
			physicalHardware: true,
			exactPrompt: true,
			privateAudioCopy: true,
		};
		const firstPromotion = hardwareEvaluations.promote({
			historyId: first.id,
			hardwareName: "First declared model",
			speakerId: "local-user",
			confirmations,
		});

		assert.throws(
			() =>
				hardwareEvaluations.promote({
					historyId: second.id,
					hardwareName: "Second declared model",
					speakerId: "local-user",
					confirmations,
				}),
			/same device fingerprint/i,
		);
		assert.equal(
			readdirSync(resolve(appRoot, ".pi", "voice", "evaluation-fixtures"))
				.filter((name) => name.endsWith(".webm")).length,
			1,
			"a rejected promotion must not copy another private recording",
		);

		assert.throws(
			() =>
				hardwareEvaluations.promote({
					historyId: second.id,
					hardwareName: "First declared model",
					speakerId: "local-user",
					condition: "room-noise",
					conditionNote: "Real conversation and ventilation noise in the room",
					confirmations,
				}),
			/real acoustic condition confirmation is required/i,
		);
		const roomPromotion = hardwareEvaluations.promote({
			historyId: second.id,
			hardwareName: "First declared model",
			speakerId: "local-user",
			condition: "room-noise",
			conditionNote: "Real conversation and ventilation noise in the room",
			confirmations: {
				...confirmations,
				realCondition: true,
			},
		});
		assert.equal(roomPromotion.capture.microphoneId, firstPromotion.capture.caseId);
		assert.equal(
			roomPromotion.capture.caseId,
			`${firstPromotion.capture.caseId}-room-noise`,
		);
		assert.equal(roomPromotion.coverage.microphones.actual, 1);
		assert.equal(roomPromotion.coverage.missingSlices.length, 2);
		const roomCases = loadVoiceEvaluationManifestFile(
			roomPromotion.manifestPath,
		).cases.filter((candidate) =>
			candidate.id.startsWith(roomPromotion.capture.caseId),
		);
		assert.equal(roomCases.length, 2);
		assert.deepEqual(
			roomCases.map((candidate) => candidate.pipeline.vad.enabled).sort(),
			[false, true],
		);
		assert.equal(
			new Set(roomCases.map((candidate) => candidate.microphone.id)).size,
			1,
		);
		assert.throws(
			() => hardwareEvaluations.remove(firstPromotion.capture.caseId),
			/remove real-condition captures before removing their hardware baseline/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two distinct confirmed devices satisfy the 2/2 hardware gate and remain replayable", async () => {
	const root = mkdtempSync(resolve(tmpdir(), "voice-hardware-two-devices-"));
	const repositoryRoot = resolve(root, "repository");
	const appRoot = resolve(repositoryRoot, "apps", "telomi");
	const runtimeRoot = resolve(root, "runtime");
	const baseManifestPath = resolve(appRoot, "voice-evals", "base.json");
	const baseAudio = Buffer.from("base evaluation audio");
	const firstAudio = Buffer.from("first physical microphone recording");
	const secondAudio = Buffer.from("second physical microphone recording");
	try {
		await mkdir(dirname(baseManifestPath), { recursive: true });
		await mkdir(resolve(repositoryRoot, "fixtures"), { recursive: true });
		writeFileSync(resolve(repositoryRoot, "fixtures", "base.wav"), baseAudio);
		writeFileSync(baseManifestPath, JSON.stringify(baseEvaluationManifest(baseAudio)));

		let now = new Date("2026-07-21T10:00:00.000Z");
		const history = new VoiceHistoryStore(runtimeRoot, { now: () => now });
		history.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const record = (
			audio: Buffer,
			deviceLabel: string,
			deviceFingerprint: string,
		) =>
			history.record({
				goalId: "goal-hardware-two-devices",
				status: "completed",
				text: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
				provider: "telomi-audio",
				mime: "audio/webm",
				audio,
				microphone: {
					deviceLabel,
					deviceFingerprint,
					selectionStatus: "exact",
					usedFallback: false,
				},
			}).entry!;
		const first = record(firstAudio, "MacBook Pro Microphone", "c".repeat(64));
		now = new Date("2026-07-21T10:01:00.000Z");
		const second = record(secondAudio, "External USB Microphone", "d".repeat(64));
		const hardwareEvaluations = new VoiceHardwareEvaluationStore({
			historyStore: history,
			repositoryRoot,
			appRoot,
			baseManifestPath,
			now: () => new Date("2026-07-21T10:02:00.000Z"),
		});
		const confirmations = {
			physicalHardware: true,
			exactPrompt: true,
			privateAudioCopy: true,
		};
		const firstPromotion = hardwareEvaluations.promote({
			historyId: first.id,
			hardwareName: "Apple MacBook Pro Built-in Microphone",
			speakerId: "local-user",
			confirmations,
		});
		const secondPromotion = hardwareEvaluations.promote({
			historyId: second.id,
			hardwareName: "Acme External USB Microphone",
			speakerId: "local-user",
			confirmations,
		});

		assert.deepEqual(secondPromotion.coverage.microphones, {
			required: 2,
			actual: 2,
			complete: true,
		});
		assert.equal(secondPromotion.coverage.complete, false);
		assert.equal(secondPromotion.coverage.missingSlices.length, 5);
		const manifest = loadVoiceEvaluationManifestFile(secondPromotion.manifestPath);
		const hardwareCases = manifest.cases.filter(
			(candidate) => candidate.microphone.verification === "hardware-verified",
		);
		assert.equal(hardwareCases.length, 4);
		assert.equal(new Set(hardwareCases.map((item) => item.microphone.id)).size, 2);
		const fixtureLoader = new VoiceEvaluationFixtureLoader({
			repositoryRoot,
			cacheRoot: resolve(appRoot, ".pi", "voice", "unused-cache"),
		});
		for (const capture of [
			{ id: firstPromotion.capture.caseId, audio: firstAudio },
			{ id: secondPromotion.capture.caseId, audio: secondAudio },
		]) {
			const pair = hardwareCases.filter(
				(candidate) => candidate.microphone.id === capture.id,
			);
			assert.equal(pair.length, 2);
			assert.deepEqual(
				pair.map((candidate) => candidate.pipeline.vad.enabled).sort(),
				[false, true],
			);
			assert.equal(pair[0]?.audio.sha256, pair[1]?.audio.sha256);
			assert.equal(pair[0]?.referenceText, pair[1]?.referenceText);
			for (const evaluationCase of pair) {
				assert.deepEqual(
					await fixtureLoader.load(evaluationCase, { allowRemote: false }),
					capture.audio,
				);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("removing hardware evidence deletes its private fixture and rematerializes the manifest", async () => {
	const root = mkdtempSync(resolve(tmpdir(), "voice-hardware-remove-"));
	const repositoryRoot = resolve(root, "repository");
	const appRoot = resolve(repositoryRoot, "apps", "telomi");
	const runtimeRoot = resolve(root, "runtime");
	const baseManifestPath = resolve(appRoot, "voice-evals", "base.json");
	const baseAudio = Buffer.from("base evaluation audio");
	const captureAudio = Buffer.from("private recording to remove");
	try {
		await mkdir(dirname(baseManifestPath), { recursive: true });
		await mkdir(resolve(repositoryRoot, "fixtures"), { recursive: true });
		writeFileSync(resolve(repositoryRoot, "fixtures", "base.wav"), baseAudio);
		writeFileSync(baseManifestPath, JSON.stringify(baseEvaluationManifest(baseAudio)));
		const history = new VoiceHistoryStore(runtimeRoot);
		history.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const entry = history.record({
			goalId: "goal-hardware-remove",
			status: "completed",
			text: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
			provider: "telomi-audio",
			mime: "audio/webm",
			audio: captureAudio,
			microphone: {
				deviceLabel: "Removable physical input",
				deviceFingerprint: "e".repeat(64),
				selectionStatus: "exact",
				usedFallback: false,
			},
		}).entry!;
		const hardwareEvaluations = new VoiceHardwareEvaluationStore({
			historyStore: history,
			repositoryRoot,
			appRoot,
			baseManifestPath,
		});
		const promoted = hardwareEvaluations.promote({
			historyId: entry.id,
			hardwareName: "Removable Physical Microphone",
			speakerId: "local-user",
			confirmations: {
				physicalHardware: true,
				exactPrompt: true,
				privateAudioCopy: true,
			},
		});
		const fixturePath = resolve(repositoryRoot, promoted.capture.fixturePath);
		assert.equal(existsSync(fixturePath), true);

		const removed = hardwareEvaluations.remove(promoted.capture.caseId);

		assert.equal(removed.removed.caseId, promoted.capture.caseId);
		assert.equal(removed.privateFixtureDeleted, true);
		assert.equal(existsSync(fixturePath), false);
		assert.equal(removed.coverage.microphones.actual, 0);
		assert.equal(
			loadVoiceEvaluationManifestFile(removed.manifestPath).cases.some(
				(candidate) => candidate.id === promoted.capture.caseId,
			),
			false,
		);
		assert.throws(
			() => hardwareEvaluations.remove(promoted.capture.caseId),
			/hardware evaluation case not found/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("tampered registry paths are rejected before private evidence can be changed", async () => {
	const root = mkdtempSync(resolve(tmpdir(), "voice-hardware-tamper-"));
	const repositoryRoot = resolve(root, "repository");
	const appRoot = resolve(repositoryRoot, "apps", "telomi");
	const runtimeRoot = resolve(root, "runtime");
	const baseManifestPath = resolve(appRoot, "voice-evals", "base.json");
	const baseAudio = Buffer.from("base evaluation audio");
	try {
		await mkdir(dirname(baseManifestPath), { recursive: true });
		await mkdir(resolve(repositoryRoot, "fixtures"), { recursive: true });
		writeFileSync(resolve(repositoryRoot, "fixtures", "base.wav"), baseAudio);
		writeFileSync(baseManifestPath, JSON.stringify(baseEvaluationManifest(baseAudio)));
		const history = new VoiceHistoryStore(runtimeRoot);
		history.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const entry = history.record({
			goalId: "goal-hardware-tamper",
			status: "completed",
			text: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
			provider: "telomi-audio",
			mime: "audio/webm",
			audio: Buffer.from("private recording"),
			microphone: {
				deviceLabel: "Physical input",
				deviceFingerprint: "f".repeat(64),
				selectionStatus: "exact",
				usedFallback: false,
			},
		}).entry!;
		const hardwareEvaluations = new VoiceHardwareEvaluationStore({
			historyStore: history,
			repositoryRoot,
			appRoot,
			baseManifestPath,
		});
		const promoted = hardwareEvaluations.promote({
			historyId: entry.id,
			hardwareName: "Physical Microphone",
			speakerId: "local-user",
			confirmations: {
				physicalHardware: true,
				exactPrompt: true,
				privateAudioCopy: true,
			},
		});
		const registry = JSON.parse(readFileSync(promoted.registryPath, "utf8"));
		registry.captures[0].fixturePath = "outside-private-evidence.webm";
		writeFileSync(promoted.registryPath, `${JSON.stringify(registry, null, 2)}\n`);

		assert.throws(
			() => hardwareEvaluations.remove(promoted.capture.caseId),
			/invalid hardware evidence registry/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("every human confirmation is required before any private evaluation artifact is created", async () => {
	const root = mkdtempSync(resolve(tmpdir(), "voice-hardware-confirmations-"));
	const repositoryRoot = resolve(root, "repository");
	const appRoot = resolve(repositoryRoot, "apps", "telomi");
	const runtimeRoot = resolve(root, "runtime");
	const baseManifestPath = resolve(appRoot, "voice-evals", "base.json");
	const baseAudio = Buffer.from("base evaluation audio");
	try {
		await mkdir(dirname(baseManifestPath), { recursive: true });
		await mkdir(resolve(repositoryRoot, "fixtures"), { recursive: true });
		writeFileSync(resolve(repositoryRoot, "fixtures", "base.wav"), baseAudio);
		writeFileSync(baseManifestPath, JSON.stringify(baseEvaluationManifest(baseAudio)));
		const history = new VoiceHistoryStore(runtimeRoot);
		history.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const entry = history.record({
			goalId: "goal-hardware-confirmations",
			status: "completed",
			text: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
			provider: "telomi-audio",
			mime: "audio/webm",
			audio: Buffer.from("private recording"),
			microphone: {
				deviceLabel: "Physical input",
				deviceFingerprint: "1".repeat(64),
				selectionStatus: "exact",
				usedFallback: false,
			},
		}).entry!;
		const hardwareEvaluations = new VoiceHardwareEvaluationStore({
			historyStore: history,
			repositoryRoot,
			appRoot,
			baseManifestPath,
		});
		for (const missing of [
			"physicalHardware",
			"exactPrompt",
			"privateAudioCopy",
		] as const) {
			const confirmations = {
				physicalHardware: true,
				exactPrompt: true,
				privateAudioCopy: true,
			};
			confirmations[missing] = false;
			assert.throws(
				() =>
					hardwareEvaluations.promote({
						historyId: entry.id,
						hardwareName: "Physical Microphone",
						speakerId: "local-user",
						confirmations,
					}),
				/confirmation is required/i,
			);
		}
		assert.equal(existsSync(resolve(appRoot, ".pi")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function baseEvaluationManifest(audio: Buffer): unknown {
	return {
		schemaVersion: 2,
		name: "hardware-evaluation-base",
		corpusVersion: "2026-07-21.1",
		description: "Base manifest for a hardware promotion contract test",
		coverageRequirements: {
			requiredSlices: ["common-zh"],
			minimumHumanSpeakers: 1,
			minimumMicrophones: 2,
		},
		qualityGate: { requireCaseAcceptance: true },
		cases: [
			{
				id: "base-recording",
				description: "Source-authored base recording",
				audio: {
					path: "fixtures/base.wav",
					mime: "audio/wav",
					sha256: sha256(audio),
					source: {
						kind: "project-recording",
						name: "Base fixture",
						license: "CC0-1.0",
					},
				},
				referenceText: "基础语音",
				referenceProvenance: {
					kind: "source-authored",
					note: "Authored with the fixture",
				},
				language: "zh",
				metrics: ["cer"],
				slices: ["common-zh"],
				speaker: { id: "base-speaker", kind: "human" },
				microphone: {
					id: "base-recording-chain",
					verification: "recording-condition-only",
					note: "Physical model is not documented",
				},
				terms: [],
				forbiddenTerms: [],
				acceptance: { stage: "raw", maxCer: 0.2 },
				pipeline: {
					languageHint: "zh",
					provider: "telomi-audio",
					cleanupRequested: false,
					vad: DEFAULT_VOICE_VAD_CONFIG,
					glossary: [],
				},
			},
		],
	};
}
