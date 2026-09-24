import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { VoiceEvaluationFixtureLoader } from "../../server/voice/evaluation-fixtures.js";
import {
	buildVoiceEvaluationReport,
	evaluateVoiceCorpusCoverage,
	loadVoiceEvaluationManifestFile,
	nearestRankPercentile,
	parseVoiceEvaluationManifest,
	scheduleVoiceEvaluationRuns,
	scoreVoiceTranscript,
	VOICE_EVALUATION_MANIFEST_SCHEMA_VERSION,
} from "../../server/voice/evaluation.js";
import { DEFAULT_VOICE_VAD_CONFIG } from "../../server/audio/voice-vad.js";

const baseManifest = {
	schemaVersion: VOICE_EVALUATION_MANIFEST_SCHEMA_VERSION,
	name: "voice-evaluation-test",
	corpusVersion: "2026-07-21.1",
	description: "Deterministic scorer contract tests",
	coverageRequirements: {
		requiredSlices: [
			"common-zh",
			"common-en",
			"mixed-zh-en",
			"long-pause",
			"structured-values",
			"technical-terms",
			"glossary-negative-control",
			"background-noise",
		],
		minimumHumanSpeakers: 2,
		minimumMicrophones: 2,
	},
	qualityGate: {
		requireCaseAcceptance: true,
	},
	cases: [
		{
			id: "english-technical",
			description: "English technical terms",
			audio: {
				path: "fixtures/english-technical.wav",
				mime: "audio/wav",
				sha256: "a".repeat(64),
				durationSec: 2.5,
				source: {
					kind: "project-recording",
					name: "Telomi evaluation fixture",
					license: "CC0-1.0",
				},
			},
			referenceText: "OpenWhispr integrates MFlow",
			referenceProvenance: {
				kind: "human-verified",
				note: "Verified against the source recording by a human reviewer",
			},
			language: "en",
			metrics: ["wer"],
			slices: ["common-en", "technical-terms"],
			speaker: { id: "speaker-1", kind: "human" },
			microphone: {
				id: "microphone-1",
				verification: "hardware-verified",
				note: "Test fixture declares a known physical capture device",
			},
			terms: [
				{ canonical: "OpenWhispr", expectedOccurrences: 1 },
				{ canonical: "MFlow", expectedOccurrences: 1 },
			],
			forbiddenTerms: [],
			acceptance: {
				stage: "canonical",
				maxWer: 0.1,
				minTermRecall: 0.9,
				minExactCanonicalRate: 0.9,
			},
			pipeline: {
				languageHint: "en",
				glossary: [
					{
						id: "term_openwhispr",
						canonical: "OpenWhispr",
						enabled: true,
					},
					{
						id: "term_mflow",
						canonical: "MFlow",
						enabled: true,
					},
				],
			},
		},
	],
};

test("manifest parser rejects ambiguous or unsafe evaluation inputs", () => {
	const manifest = parseVoiceEvaluationManifest(baseManifest);
	assert.equal(manifest.cases[0]?.pipeline.glossary.length, 2);
	assert.equal(manifest.qualityGate.requireCaseAcceptance, true);
	assert.equal(manifest.cases[0]?.acceptance?.maxWer, 0.1);
	assert.equal(manifest.cases[0]?.audio.path, "fixtures/english-technical.wav");
	assert.deepEqual(manifest.cases[0]?.pipeline.vad, DEFAULT_VOICE_VAD_CONFIG);
	const onsetManifest = parseVoiceEvaluationManifest({
		...baseManifest,
		cases: [{
			...baseManifest.cases[0],
			audio: {
				...baseManifest.cases[0].audio,
				speechOnset: {
					startMs: 520,
					method: "waveform-spectrogram-reviewed",
					note: "Reviewed against the pinned waveform and spectrogram",
				},
			},
		}],
	});
	assert.deepEqual(onsetManifest.cases[0]?.audio.speechOnset, {
		startMs: 520,
		method: "waveform-spectrogram-reviewed",
		note: "Reviewed against the pinned waveform and spectrogram",
	});
	for (const startMs of [-1, 2_500]) {
		assert.throws(
			() => parseVoiceEvaluationManifest({
				...baseManifest,
				cases: [{
					...baseManifest.cases[0],
					audio: {
						...baseManifest.cases[0].audio,
						speechOnset: {
							startMs,
							method: "human-auditory",
							note: "Invalid onset boundary",
						},
					},
				}],
			}),
			/audio\.speechOnset\.startMs/i,
		);
	}
	assert.throws(
		() => parseVoiceEvaluationManifest({
			...baseManifest,
			cases: [{
				...baseManifest.cases[0],
				acceptance: {
					stage: "canonical",
					maxCer: 0.1,
				},
			}],
		}),
		/acceptance\.maxCer/i,
	);
	assert.throws(
		() => parseVoiceEvaluationManifest({
			...baseManifest,
			cases: [{
				...baseManifest.cases[0],
				pipeline: {
					...baseManifest.cases[0].pipeline,
					vad: { ...DEFAULT_VOICE_VAD_CONFIG, threshold: 99 },
				},
			}],
		}),
		/pipeline\.vad/i,
	);

	assert.throws(
		() =>
			parseVoiceEvaluationManifest({
				...baseManifest,
				cases: [
					...baseManifest.cases,
					{ ...baseManifest.cases[0], id: "english-technical" },
				],
			}),
		/duplicate case id/i,
	);
	assert.throws(
		() =>
			parseVoiceEvaluationManifest({
				...baseManifest,
				cases: [
					{
						...baseManifest.cases[0],
						audio: { ...baseManifest.cases[0].audio, path: "../secret.wav" },
					},
				],
			}),
		/audio.path/i,
	);
	assert.throws(
		() =>
			parseVoiceEvaluationManifest({
				...baseManifest,
				cases: [
					{
						...baseManifest.cases[0],
						audio: {
							...baseManifest.cases[0].audio,
							source: { ...baseManifest.cases[0].audio.source, license: "" },
						},
					},
				],
			}),
		/license/i,
	);
	assert.throws(
		() =>
			parseVoiceEvaluationManifest({
				...baseManifest,
				cases: [
					{
						...baseManifest.cases[0],
						microphone: {
							id: "unknown-capture-chain",
							verification: "assumed",
							note: "An unrecognized value must not satisfy the hardware gate",
						},
					},
				],
			}),
		/microphone\.verification/i,
	);
	assert.throws(
		() =>
			parseVoiceEvaluationManifest({
				...baseManifest,
				cases: [
					{
						...baseManifest.cases[0],
						referenceProvenance: undefined,
					},
				],
			}),
		/referenceProvenance/i,
	);
	assert.throws(
		() =>
			parseVoiceEvaluationManifest({
				...baseManifest,
				name: "../unsafe-report-name",
			}),
		/manifest.name/i,
	);
	assert.throws(
		() =>
			parseVoiceEvaluationManifest({
				...baseManifest,
				cases: [
					{
						...baseManifest.cases[0],
						audio: {
							...baseManifest.cases[0].audio,
							downloadUrl: "http://example.com/fixture.wav",
						},
					},
				],
			}),
		/audio.downloadUrl/i,
	);
});

test("manifest file loader composes included suites without duplicating case definitions", async () => {
	const workspace = mkdtempSync(resolve(tmpdir(), "voice-eval-manifest-"));
	const includedCase = {
		...baseManifest.cases[0],
		id: "included-english-technical",
	};
	try {
		await writeFile(
			resolve(workspace, "included.json"),
			JSON.stringify({
				...baseManifest,
				name: "included-suite",
				cases: [includedCase],
			}),
		);
		await writeFile(
			resolve(workspace, "release.json"),
			JSON.stringify({
				...baseManifest,
				name: "release-suite",
				includes: ["included.json"],
			}),
		);

		const manifest = loadVoiceEvaluationManifestFile(
			resolve(workspace, "release.json"),
		);
		assert.deepEqual(
			manifest.cases.map((evaluationCase) => evaluationCase.id),
			["english-technical", "included-english-technical"],
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("the VAD stress manifest includes every deterministic acoustic boundary pair", () => {
	const manifest = loadVoiceEvaluationManifestFile(
		resolve(process.cwd(), "voice-evals", "local-qwen-vad-stress-v1.json"),
	);
	assert.equal(manifest.cases.length, 10);
	assert.deepEqual(manifest.coverageRequirements.requiredSlices, [
		"long-pause",
		"background-noise",
		"weak-onset",
		"short-burst-noise",
		"keyboard-like-noise",
		"simulated-far-field",
		"technical-term-boundary",
		"traditional-script",
	]);
	for (const prefix of [
		"librispeech-weak-onset",
		"aishell-keyboard-impulses",
		"taimecs-001-simulated-far-field",
	]) {
		const pair = manifest.cases.filter((evaluationCase) =>
			evaluationCase.id.startsWith(prefix),
		);
		assert.equal(pair.length, 2);
		assert.deepEqual(
			pair.map((evaluationCase) => evaluationCase.pipeline.vad.enabled).sort(),
			[false, true],
		);
		assert.equal(pair[0]?.audio.sha256, pair[1]?.audio.sha256);
		assert.equal(pair[0]?.referenceText, pair[1]?.referenceText);
	}
	assert.equal(evaluateVoiceCorpusCoverage(manifest).complete, true);
});

test("remote fixtures require explicit permission, verify SHA and reuse local cache", async () => {
	const workspace = mkdtempSync(resolve(tmpdir(), "voice-eval-fixture-"));
	const audio = Buffer.from("verified evaluation audio");
	let fetchCalls = 0;
	const evaluationCase = parseVoiceEvaluationManifest({
		...baseManifest,
		cases: [
			{
				...baseManifest.cases[0],
				audio: {
					...baseManifest.cases[0].audio,
					path: "voice-evals/external/fixture.wav",
					sha256:
						"91567ade78cd9797eb46369217f22bc6d7e34deb99f4055189b0e44f3aab3e8b",
					downloadUrl: "https://fixtures.example.test/fixture.wav",
				},
			},
		],
	}).cases[0]!;
	const loader = new VoiceEvaluationFixtureLoader({
		repositoryRoot: workspace,
		cacheRoot: resolve(workspace, ".pi", "voice-eval-cache"),
		fetch: async () => {
			fetchCalls += 1;
			return new Response(audio, {
				status: 200,
				headers: { "content-length": String(audio.length) },
			});
		},
	});
	try {
		await assert.rejects(
			loader.load(evaluationCase, { allowRemote: false }),
			/remote fetching is disabled/i,
		);
		assert.deepEqual(
			await loader.load(evaluationCase, { allowRemote: true }),
			audio,
		);
		assert.equal(fetchCalls, 1);
		assert.deepEqual(
			await loader.load(evaluationCase, { allowRemote: false }),
			audio,
		);
		assert.equal(fetchCalls, 1, "second load must use the content-addressed cache");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("fixture loader never replaces a tampered repository fixture from the network", async () => {
	const workspace = mkdtempSync(resolve(tmpdir(), "voice-eval-tamper-"));
	const fixturePath = resolve(workspace, "fixtures", "english-technical.wav");
	await mkdir(resolve(workspace, "fixtures"), { recursive: true });
	await writeFile(fixturePath, "wrong local bytes", { flag: "wx" });
	const evaluationCase = parseVoiceEvaluationManifest(baseManifest).cases[0]!;
	const loader = new VoiceEvaluationFixtureLoader({
		repositoryRoot: workspace,
		cacheRoot: resolve(workspace, ".pi", "voice-eval-cache"),
		fetch: async () => {
			throw new Error("network must not be called");
		},
	});
	try {
		await assert.rejects(
			loader.load(evaluationCase, { allowRemote: true }),
			/SHA-256 mismatch/i,
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("WER and CER use edit counts instead of averaging per-case percentages", () => {
	const english = scoreVoiceTranscript({
		referenceText: "the quick brown fox",
		hypothesisText: "the quick blue fox",
		metrics: ["wer"],
		terms: [],
		forbiddenTerms: [],
	});
	assert.deepEqual(english.wer, {
		edits: 1,
		referenceUnits: 4,
		rate: 0.25,
	});
	assert.equal(english.cer, null);

	const chinese = scoreVoiceTranscript({
		referenceText: "今天语音输入很准确",
		hypothesisText: "今天语音输出很准确",
		metrics: ["cer"],
		terms: [],
		forbiddenTerms: [],
	});
	assert.equal(chinese.cer?.edits, 1);
	assert.equal(chinese.cer?.referenceUnits, 9);
	assert.equal(chinese.cer?.rate, 1 / 9);
	assert.equal(chinese.wer, null);
});

test("content CER separates recognition accuracy from Traditional Chinese glyph fidelity", () => {
	const score = scoreVoiceTranscript({
		referenceText: "我們推出新的語言模型與訓練資料。",
		hypothesisText: "我们推出新的语言模型与训练资料。",
		metrics: ["cer", "content-cer"],
		terms: [],
		forbiddenTerms: [],
	});

	assert.ok((score.cer?.rate ?? 0) > 0, "source-script CER must see glyph drift");
	assert.deepEqual(score.contentCer, {
		edits: 0,
		referenceUnits: 15,
		rate: 0,
	});
});

test("content CER is versioned in manifests, aggregated and enforced by the quality gate", () => {
	const referenceText = "我們推出新的語言模型與訓練資料。";
	const simplifiedText = "我们推出新的语言模型与训练资料。";
	const manifest = parseVoiceEvaluationManifest({
		...baseManifest,
		cases: [{
			...baseManifest.cases[0],
			id: "traditional-script",
			referenceText,
			language: "zh-TW",
			metrics: ["cer", "content-cer"],
			slices: ["common-zh"],
			terms: [],
			acceptance: {
				stage: "raw",
				maxContentCer: 0,
			},
			pipeline: {
				...baseManifest.cases[0].pipeline,
				languageHint: "zh",
				languagePreference: "zh-TW",
			},
		}],
	});
	assert.equal(manifest.cases[0]?.pipeline.languagePreference, "zh-TW");

	const report = buildVoiceEvaluationReport({
		manifest,
		runtime: {
			provider: "telomi-audio",
			platform: "test",
			hardware: "test",
			nodeVersion: "test",
		},
		observations: [{
			caseId: "traditional-script",
			runId: "traditional-script-warm-1",
			runClass: "warm",
			ok: true,
			provider: "telomi-audio",
			rawText: simplifiedText,
			canonicalText: referenceText,
			draftText: referenceText,
			latency: { pipelineMs: 10 },
		}],
	});

	assert.ok((report.stages.raw.cer?.rate ?? 0) > 0);
	assert.equal(report.stages.raw.contentCer?.rate, 0);
	assert.equal(report.stages.canonical.cer?.rate, 0);
	assert.equal(report.qualityGate.complete, true);
	assert.deepEqual(report.qualityGate.cases[0]?.metrics, [{
		metric: "contentCer",
		direction: "max",
		threshold: 0,
		actual: 0,
		passed: true,
	}]);

	assert.throws(
		() => parseVoiceEvaluationManifest({
			...baseManifest,
			cases: [{
				...baseManifest.cases[0],
				acceptance: { stage: "raw", maxContentCer: 0.1 },
			}],
		}),
		/maxContentCer requires the case content-cer metric/,
	);
});

test("term scoring distinguishes raw ASR, exact terminology and false positives", () => {
	const raw = scoreVoiceTranscript({
		referenceText: "OpenWhispr integrates MFlow",
		hypothesisText: "open whisper integrates M flow",
		metrics: ["wer"],
		terms: [
			{ canonical: "OpenWhispr", expectedOccurrences: 1 },
			{ canonical: "MFlow", expectedOccurrences: 1 },
		],
		forbiddenTerms: [],
	});
	assert.equal(raw.terms.recall, 0);
	assert.equal(raw.terms.exactCanonicalRate, 0);

	const canonical = scoreVoiceTranscript({
		referenceText: "OpenWhispr integrates MFlow",
		hypothesisText: "OpenWhispr integrates MFlow",
		metrics: ["wer"],
		terms: [
			{ canonical: "OpenWhispr", expectedOccurrences: 1 },
			{ canonical: "MFlow", expectedOccurrences: 1 },
		],
		forbiddenTerms: [],
	});
	assert.equal(canonical.terms.precision, 1);
	assert.equal(canonical.terms.recall, 1);
	assert.equal(canonical.terms.exactCanonicalRate, 1);

	const negativeControl = scoreVoiceTranscript({
		referenceText: "The open whisper is quiet",
		hypothesisText: "The OpenWhispr is quiet",
		metrics: ["wer"],
		terms: [],
		forbiddenTerms: ["OpenWhispr"],
	});
	assert.equal(negativeControl.terms.falseReplacementCount, 1);
	assert.equal(negativeControl.terms.falseReplacementRate, 1);
});

test("term scoring finds CJK terms inside continuous sentences", () => {
	const result = scoreVoiceTranscript({
		referenceText: "達成率只有六成，企業能自行調校大型語言模型。",
		hypothesisText: "達成率只有六成，企業能自行調校大型語言模型。",
		metrics: ["cer"],
		terms: [
			{ canonical: "六成", expectedOccurrences: 1 },
			{ canonical: "調校", expectedOccurrences: 1 },
		],
		forbiddenTerms: ["資料庫"],
	});
	assert.equal(result.terms.recall, 1);
	assert.equal(result.terms.exactCanonicalRate, 1);
	assert.equal(result.terms.falseReplacementRate, 0);
});

test("term scoring treats Han adjacency as a boundary for embedded Latin terms", () => {
	const result = scoreVoiceTranscript({
		referenceText: "新的base model与training data符合in house需求。",
		hypothesisText:
			"新的base model与training data符合in house需求，workflow不是目标词。",
		metrics: ["cer"],
		terms: [
			{ canonical: "base model", expectedOccurrences: 1 },
			{ canonical: "training data", expectedOccurrences: 1 },
			{ canonical: "in house", expectedOccurrences: 1 },
		],
		forbiddenTerms: ["flow"],
	});
	assert.equal(result.terms.recall, 1);
	assert.equal(result.terms.exactCanonicalRate, 1);
	assert.equal(result.terms.falseReplacementRate, 0);
});

test("coverage gate cannot mistake one synthetic or single-speaker clip for a corpus", () => {
	const manifest = parseVoiceEvaluationManifest(baseManifest);
	const coverage = evaluateVoiceCorpusCoverage(manifest);
	assert.equal(coverage.complete, false);
	assert.deepEqual(coverage.presentSlices, ["common-en", "technical-terms"]);
	assert.deepEqual(coverage.missingSlices, [
		"common-zh",
		"mixed-zh-en",
		"long-pause",
		"structured-values",
		"glossary-negative-control",
		"background-noise",
	]);
	assert.equal(coverage.humanSpeakers.actual, 1);
	assert.equal(coverage.microphones.actual, 1);
	assert.equal(coverage.referenceTranscripts.provisional, 0);
	assert.equal(coverage.referenceTranscripts.complete, true);

	const unverifiedRecording = parseVoiceEvaluationManifest({
		...baseManifest,
		cases: [
			baseManifest.cases[0],
			{
				...baseManifest.cases[0],
				id: "second-human-unverified-microphone",
				speaker: { id: "speaker-2", kind: "human" },
				microphone: {
					id: "public-corpus-recording-chain",
					verification: "recording-condition-only",
					note: "The public corpus does not identify its physical microphone",
				},
			},
		],
	});
	const unverifiedCoverage = evaluateVoiceCorpusCoverage(unverifiedRecording);
	assert.equal(unverifiedCoverage.humanSpeakers.actual, 2);
	assert.equal(unverifiedCoverage.microphones.actual, 1);
});

test("latency percentiles use deterministic nearest-rank semantics", () => {
	assert.equal(nearestRankPercentile([100, 10, 40, 20, 30], 0.5), 30);
	assert.equal(nearestRankPercentile([100, 10, 40, 20, 30], 0.95), 100);
	assert.equal(nearestRankPercentile([], 0.95), null);
	assert.throws(() => nearestRankPercentile([1], 0), /percentile/i);
});

test("evaluation schedule alternates AB and BA to reduce warm-order bias", () => {
	const manifest = parseVoiceEvaluationManifest({
		...baseManifest,
		cases: [
			baseManifest.cases[0],
			{
				...baseManifest.cases[0],
				id: "english-technical-glossary-off",
			},
		],
	});
	const schedule = scheduleVoiceEvaluationRuns(manifest.cases, 3, "warm");
	assert.deepEqual(
		schedule.map((item) => item.runId),
		[
			"english-technical-warm-1",
			"english-technical-glossary-off-warm-1",
			"english-technical-glossary-off-warm-2",
			"english-technical-warm-2",
			"english-technical-warm-3",
			"english-technical-glossary-off-warm-3",
		],
	);
});

test("report preserves raw and canonical evidence and aggregates edit counts", () => {
	const manifest = parseVoiceEvaluationManifest(baseManifest);
	const report = buildVoiceEvaluationReport({
		manifest,
		generatedAt: "2026-07-21T12:00:00.000Z",
		runtime: {
			provider: "telomi-audio",
			platform: "darwin-arm64",
			hardware: "test-machine",
			nodeVersion: "v22-test",
		},
		observations: [
			{
				caseId: "english-technical",
				runId: "english-technical-warm-1",
				runClass: "warm",
				ok: true,
				provider: "telomi-audio",
				model: "Qwen3-ASR-test",
				rawText: "open whisper integrates M flow",
				canonicalText: "OpenWhispr integrates MFlow",
				draftText: "OpenWhispr integrates MFlow",
				latency: {
					pipelineMs: 120,
					providerAudioDurationSec: 2.5,
				},
			},
		],
	});

	assert.equal(report.schemaVersion, 6);
	assert.equal(report.coverage.complete, false);
	assert.equal(report.qualityGate.required, true);
	assert.equal(report.qualityGate.complete, true);
	assert.equal(report.qualityGate.passingCaseCount, 1);
	assert.deepEqual(report.qualityGate.failingCaseIds, []);
	assert.equal(report.summary.completedRuns, 1);
	assert.equal(report.summary.failedRuns, 0);
	assert.equal(report.summary.executionComplete, true);
	assert.equal(report.summary.evaluatedCaseCount, 1);
	assert.deepEqual(report.summary.unevaluatedCaseIds, []);
	assert.equal(report.caseSummaries.length, 1);
	assert.equal(report.caseSummaries[0]?.caseId, "english-technical");
	assert.equal(report.caseSummaries[0]?.stages.canonical.wer?.rate, 0);
	assert.equal(report.caseSummaries[0]?.latency.warm.pipelineMs?.p50, 120);
	assert.equal(report.stages.raw.wer?.edits, 4);
	assert.equal(report.stages.canonical.wer?.rate, 0);
	assert.equal(report.stages.raw.terms.recall, 0);
	assert.equal(report.stages.canonical.terms.recall, 1);
	assert.deepEqual(report.latency.warm.pipelineMs, {
		count: 1,
		p50: 120,
		p95: 120,
		max: 120,
	});
	assert.equal(report.runs[0]?.rawText, "open whisper integrates M flow");
	assert.equal(report.runs[0]?.canonicalText, "OpenWhispr integrates MFlow");
});

test("report schema records auditable per-run cold isolation evidence", () => {
	const manifest = parseVoiceEvaluationManifest(baseManifest);
	const observation = {
		caseId: "english-technical",
		runId: "english-technical-cold-1",
		runClass: "cold" as const,
		ok: true,
		provider: "telomi-audio",
		rawText: "OpenWhispr integrates MFlow",
		canonicalText: "OpenWhispr integrates MFlow",
		draftText: "OpenWhispr integrates MFlow",
		latency: { pipelineMs: 1_250 },
		coldStart: {
			baseUrl: "http://127.0.0.1:4567/v1",
			sidecarPid: 4321,
			sidecarStartupMs: 250,
			asrLoadedBeforeRequest: false as const,
			asrModelId: "Qwen3-ASR-test",
			asrModelPath: "/models/qwen-test",
		},
	};
	const runtime = {
		provider: "telomi-audio",
		platform: "test",
		hardware: "test",
		nodeVersion: "test",
		isolatedSidecarPerRun: true,
	};
	const report = buildVoiceEvaluationReport({
		manifest,
		runtime,
		observations: [observation],
	});

	assert.equal(report.schemaVersion, 6);
	assert.deepEqual(report.runs[0]?.coldStart, observation.coldStart);
	assert.equal(report.latency.cold.pipelineMs?.p50, 1_250);
	assert.throws(
		() => buildVoiceEvaluationReport({
			manifest,
			runtime,
			observations: [{ ...observation, coldStart: undefined }],
		}),
		/claims isolated cold execution but observation .* has no cold-start evidence/,
	);
	assert.throws(
		() => buildVoiceEvaluationReport({
			manifest,
			runtime: { ...runtime, isolatedSidecarPerRun: false },
			observations: [{ ...observation, runClass: "warm" }],
		}),
		/cold-start evidence on a non-cold run/,
	);
});

test("report schema records auditable first-partial text and replay evidence", () => {
	const manifest = parseVoiceEvaluationManifest({
		...baseManifest,
		cases: [{
			...baseManifest.cases[0],
			audio: {
				...baseManifest.cases[0].audio,
				speechOnset: {
					startMs: 520,
					method: "waveform-spectrogram-reviewed",
					note: "Reviewed against the pinned waveform and spectrogram",
				},
			},
		}],
	});
	const observation = {
		caseId: "english-technical",
		runId: "english-technical-warm-preview-1",
		runClass: "warm" as const,
		ok: true,
		provider: "telomi-audio",
		rawText: "OpenWhispr integrates MFlow",
		canonicalText: "OpenWhispr integrates MFlow",
		draftText: "OpenWhispr integrates MFlow",
		latency: {
			pipelineMs: 420,
			firstPartialMs: 2_240,
			speechStartToFirstPartialMs: 1_720,
		},
		firstPartial: {
			provider: "telomi-audio-local-snapshot",
			model: "Qwen3-ASR-test",
			mode: "cumulative-snapshot" as const,
			text: "OpenWhispr",
			sampleRate: 16_000,
			snapshotSeconds: 2,
			replayChunkMs: 20,
			audioSentSec: 2.26,
			speechOnset: {
				startMs: 520,
				method: "waveform-spectrogram-reviewed" as const,
				note: "Reviewed against the pinned waveform and spectrogram",
			},
		},
	};
	const runtime = {
		provider: "telomi-audio",
		platform: "test",
		hardware: "test",
		nodeVersion: "test",
		firstPartialMeasurementEnabled: true,
	};
	const report = buildVoiceEvaluationReport({
		manifest,
		runtime,
		observations: [observation],
	});

	assert.equal(report.schemaVersion, 6);
	assert.deepEqual(report.runs[0]?.firstPartial, observation.firstPartial);
	assert.deepEqual(report.latency.warm.firstPartialMs, {
		count: 1,
		p50: 2_240,
		p95: 2_240,
		max: 2_240,
	});
	assert.deepEqual(report.latency.warm.speechStartToFirstPartialMs, {
		count: 1,
		p50: 1_720,
		p95: 1_720,
		max: 1_720,
	});
	assert.throws(
		() => buildVoiceEvaluationReport({
			manifest,
			runtime,
			observations: [{ ...observation, firstPartial: undefined }],
		}),
		/claims first-partial measurement but observation .* has no evidence/,
	);
	assert.throws(
		() => buildVoiceEvaluationReport({
			manifest,
			runtime: { ...runtime, firstPartialMeasurementEnabled: false },
			observations: [{
				...observation,
				latency: { pipelineMs: 420 },
			}],
		}),
		/first-partial evidence without firstPartialMs/,
	);
});

test("quality gate fails a case whose canonical accuracy misses its declared thresholds", () => {
	const manifest = parseVoiceEvaluationManifest(baseManifest);
	const report = buildVoiceEvaluationReport({
		manifest,
		runtime: {
			provider: "telomi-audio",
			platform: "test",
			hardware: "test",
			nodeVersion: "test",
		},
		observations: [
			{
				caseId: "english-technical",
				runId: "quality-regression-warm-1",
				runClass: "warm",
				ok: true,
				provider: "telomi-audio",
				rawText: "unrelated transcript",
				canonicalText: "unrelated transcript",
				draftText: "unrelated transcript",
				latency: { pipelineMs: 50 },
			},
		],
	});

	assert.equal(report.qualityGate.complete, false);
	assert.deepEqual(report.qualityGate.failingCaseIds, ["english-technical"]);
	assert.deepEqual(
		report.qualityGate.cases[0]?.metrics.map((metric) => ({
			metric: metric.metric,
			passed: metric.passed,
		})),
		[
			{ metric: "wer", passed: false },
			{ metric: "termRecall", passed: false },
			{ metric: "exactCanonicalRate", passed: false },
		],
	);
});

test("report marks a filtered or interrupted corpus run as execution-incomplete", () => {
	const manifest = parseVoiceEvaluationManifest({
		...baseManifest,
		cases: [
			baseManifest.cases[0],
			{
				...baseManifest.cases[0],
				id: "second-case",
			},
		],
	});
	const report = buildVoiceEvaluationReport({
		manifest,
		runtime: {
			provider: "telomi-audio",
			platform: "test",
			hardware: "test",
			nodeVersion: "test",
		},
		observations: [
			{
				caseId: "english-technical",
				runId: "partial-run-1",
				runClass: "warm",
				ok: false,
				provider: "telomi-audio",
				error: "intentional",
				latency: { pipelineMs: 10 },
			},
		],
	});
	assert.equal(report.summary.executionComplete, false);
	assert.equal(report.summary.evaluatedCaseCount, 1);
	assert.deepEqual(report.summary.unevaluatedCaseIds, ["second-case"]);
});
