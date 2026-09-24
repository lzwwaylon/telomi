import { readFileSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { VoiceGlossaryEntry } from "../../shared/voice-stt.js";
import {
	isVoiceLanguagePreference,
	type VoiceLanguagePreference,
} from "../../shared/voice-languages.js";
import { hashJson, stableJson } from "../lib/hash.js";
import {
	isNormalizedVoiceVadConfig,
	normalizeVoiceVadConfig,
	type VoiceVadConfig,
	type VoiceVadMetadata,
} from "../audio/voice-vad.js";
import { normalizeGlossaryEntries } from "./glossary.js";
import { normalizeChineseContentForScoring } from "./chinese-script.js";
import type { VoiceColdStartEvidence } from "./isolated-cold-sidecar.js";
import type {
	VoiceFirstPartialEvidence,
	VoiceSpeechOnsetAnnotation,
} from "./evaluation-first-partial.js";
import { toErrorMessage } from "../lib/values.js";

export const VOICE_EVALUATION_MANIFEST_SCHEMA_VERSION = 2;
export const VOICE_EVALUATION_REPORT_SCHEMA_VERSION = 6;

export type VoiceEvaluationMetric = "wer" | "cer" | "content-cer";
export type VoiceEvaluationStage = "raw" | "canonical" | "draft";
export type VoiceEvaluationRunClass = "cold" | "warm";
export type VoiceEvaluationMicrophoneVerification =
	| "hardware-verified"
	| "recording-condition-only"
	| "synthetic";

export interface VoiceEvaluationTerm {
	canonical: string;
	expectedOccurrences: number;
}

export interface VoiceEvaluationAcceptance {
	stage: VoiceEvaluationStage;
	maxWer?: number;
	maxCer?: number;
	maxContentCer?: number;
	minTermPrecision?: number;
	minTermRecall?: number;
	minExactCanonicalRate?: number;
	maxFalseReplacementRate?: number;
}

export interface VoiceEvaluationCase {
	id: string;
	description: string;
	audio: {
		path: string;
		mime: string;
		sha256: string;
		durationSec?: number;
		speechOnset?: VoiceSpeechOnsetAnnotation;
		downloadUrl?: string;
		source: {
			kind: string;
			name: string;
			license: string;
			url?: string;
		};
	};
	referenceText: string;
	referenceProvenance: {
		kind: "source-authored" | "human-verified" | "model-derived-provisional";
		note: string;
	};
	language: string;
	metrics: VoiceEvaluationMetric[];
	slices: string[];
	speaker: {
		id: string;
		kind: "human" | "synthetic";
	};
	microphone: {
		id: string;
		verification: VoiceEvaluationMicrophoneVerification;
		note: string;
	};
	terms: VoiceEvaluationTerm[];
	forbiddenTerms: string[];
	acceptance?: VoiceEvaluationAcceptance;
	pipeline: {
		languageHint?: string;
		languagePreference?: VoiceLanguagePreference;
		provider?: string;
		cleanupRequested: boolean;
		vad: VoiceVadConfig;
		glossary: VoiceGlossaryEntry[];
	};
}

export interface VoiceEvaluationManifest {
	schemaVersion: typeof VOICE_EVALUATION_MANIFEST_SCHEMA_VERSION;
	name: string;
	corpusVersion: string;
	description: string;
	coverageRequirements: {
		requiredSlices: string[];
		minimumHumanSpeakers: number;
		minimumMicrophones: number;
	};
	qualityGate: {
		requireCaseAcceptance: boolean;
	};
	cases: VoiceEvaluationCase[];
}

export interface VoiceCorpusCoverage {
	complete: boolean;
	presentSlices: string[];
	missingSlices: string[];
	humanSpeakers: { required: number; actual: number; complete: boolean };
	microphones: { required: number; actual: number; complete: boolean };
	referenceTranscripts: {
		verified: number;
		provisional: number;
		complete: boolean;
	};
}

export interface VoiceEditMetric {
	edits: number;
	referenceUnits: number;
	rate: number | null;
}

export interface VoiceTermMetrics {
	truePositiveOccurrences: number;
	expectedOccurrences: number;
	observedOccurrences: number;
	precision: number | null;
	recall: number | null;
	exactCanonicalOccurrences: number;
	exactCanonicalRate: number | null;
	forbiddenTermCount: number;
	falseReplacementTermCount: number;
	falseReplacementCount: number;
	falseReplacementRate: number | null;
}

export interface VoiceTranscriptScore {
	wer: VoiceEditMetric | null;
	cer: VoiceEditMetric | null;
	contentCer: VoiceEditMetric | null;
	terms: VoiceTermMetrics;
}

export type VoiceQualityMetricName =
	| "wer"
	| "cer"
	| "contentCer"
	| "termPrecision"
	| "termRecall"
	| "exactCanonicalRate"
	| "falseReplacementRate";

export interface VoiceQualityMetricResult {
	metric: VoiceQualityMetricName;
	direction: "max" | "min";
	threshold: number;
	actual: number | null;
	passed: boolean;
}

export interface VoiceQualityGateResult {
	required: boolean;
	complete: boolean;
	passingCaseCount: number;
	failingCaseIds: string[];
	missingAcceptanceCaseIds: string[];
	unevaluatedCaseIds: string[];
	cases: Array<{
		caseId: string;
		stage: VoiceEvaluationStage;
		passed: boolean;
		metrics: VoiceQualityMetricResult[];
	}>;
}

export interface VoiceEvaluationObservation {
	caseId: string;
	runId: string;
	runClass: VoiceEvaluationRunClass;
	ok: boolean;
	provider: string;
	model?: string;
	language?: string;
	rawText?: string;
	canonicalText?: string;
	draftText?: string;
	error?: string;
	latency: {
		pipelineMs: number;
		firstPartialMs?: number;
		speechStartToFirstPartialMs?: number;
		providerAudioDurationSec?: number;
	};
	coldStart?: VoiceColdStartEvidence;
	firstPartial?: VoiceFirstPartialEvidence;
	vad?: VoiceVadMetadata;
}

export interface VoiceEvaluationRuntimeMetadata {
	provider: string;
	platform: string;
	hardware: string;
	nodeVersion: string;
	[key: string]: string | number | boolean | null | undefined;
}

interface VoiceAggregateStageMetrics {
	wer: VoiceEditMetric | null;
	cer: VoiceEditMetric | null;
	contentCer: VoiceEditMetric | null;
	terms: VoiceTermMetrics;
}

interface VoiceLatencySummary {
	count: number;
	p50: number;
	p95: number;
	max: number;
}

export interface VoiceEvaluationReport {
	schemaVersion: typeof VOICE_EVALUATION_REPORT_SCHEMA_VERSION;
	generatedAt: string;
	manifest: {
		name: string;
		corpusVersion: string;
		digest: string;
		caseCount: number;
	};
	runtime: VoiceEvaluationRuntimeMetadata;
	coverage: VoiceCorpusCoverage;
	qualityGate: VoiceQualityGateResult;
	summary: {
		totalRuns: number;
		completedRuns: number;
		failedRuns: number;
		executionComplete: boolean;
		evaluatedCaseCount: number;
		unevaluatedCaseIds: string[];
	};
	caseSummaries: Array<{
		caseId: string;
		description: string;
		glossaryEntryCount: number;
		totalRuns: number;
		completedRuns: number;
		failedRuns: number;
		stages: {
			raw: VoiceAggregateStageMetrics;
			canonical: VoiceAggregateStageMetrics;
			draft: VoiceAggregateStageMetrics;
		};
		latency: Record<VoiceEvaluationRunClass, {
			pipelineMs: VoiceLatencySummary | null;
			firstPartialMs: VoiceLatencySummary | null;
			speechStartToFirstPartialMs: VoiceLatencySummary | null;
		}>;
	}>;
	stages: {
		raw: VoiceAggregateStageMetrics;
		canonical: VoiceAggregateStageMetrics;
		draft: VoiceAggregateStageMetrics;
	};
	latency: Record<VoiceEvaluationRunClass, {
		pipelineMs: VoiceLatencySummary | null;
		firstPartialMs: VoiceLatencySummary | null;
		speechStartToFirstPartialMs: VoiceLatencySummary | null;
	}>;
	runs: Array<
		VoiceEvaluationObservation & {
			scores?: {
				raw: VoiceTranscriptScore;
				canonical: VoiceTranscriptScore;
				draft: VoiceTranscriptScore;
			};
		}
	>;
}

export interface VoiceEvaluationRunScheduleItem {
	evaluationCase: VoiceEvaluationCase;
	runIndex: number;
	runId: string;
	runClass: VoiceEvaluationRunClass;
}

export function loadVoiceEvaluationManifestFile(
	manifestPath: string,
): VoiceEvaluationManifest {
	const rootPath = resolve(manifestPath);
	const suiteRoot = dirname(rootPath);
	const visiting = new Set<string>();

	const loadCases = (currentPath: string): VoiceEvaluationCase[] => {
		if (visiting.has(currentPath)) {
			throw new Error(`voice evaluation manifest include cycle: ${currentPath}`);
		}
		visiting.add(currentPath);
		try {
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(currentPath, "utf8"));
			} catch (error) {
				throw new Error(
					`failed to read voice evaluation manifest ${currentPath}: ${toErrorMessage(error)}`,
				);
			}
			const root = objectValue(raw, `manifest file ${currentPath}`);
			const parsed = parseVoiceEvaluationManifest(root);
			const includes = parseManifestIncludes(root.includes);
			const cases = [...parsed.cases];
			for (const include of includes) {
				const includedPath = resolve(dirname(currentPath), include);
				const relativeToSuite = relative(suiteRoot, includedPath);
				if (
					isAbsolute(include) ||
					relativeToSuite === ".." ||
					relativeToSuite.startsWith(`..${sep}`) ||
					!includedPath.endsWith(".json")
				) {
					throw new Error(
						`manifest.includes entry must reference a JSON file inside ${suiteRoot}: ${include}`,
					);
				}
				cases.push(...loadCases(includedPath));
			}
			return cases;
		} finally {
			visiting.delete(currentPath);
		}
	};

	const rawRoot = objectValue(
		JSON.parse(readFileSync(rootPath, "utf8")),
		"manifest",
	);
	return parseVoiceEvaluationManifest({
		...rawRoot,
		cases: loadCases(rootPath),
	});
}

export function parseVoiceEvaluationManifest(
	value: unknown,
): VoiceEvaluationManifest {
	const root = objectValue(value, "manifest");
	if (root.schemaVersion !== VOICE_EVALUATION_MANIFEST_SCHEMA_VERSION) {
		throw new Error(
			`manifest.schemaVersion must be ${VOICE_EVALUATION_MANIFEST_SCHEMA_VERSION}`,
		);
	}
	const requirements = objectValue(
		root.coverageRequirements,
		"manifest.coverageRequirements",
	);
	const requiredSlices = uniqueStrings(
		requirements.requiredSlices,
		"coverageRequirements.requiredSlices",
		{ minItems: 1, slug: true },
	);
	const qualityGate = root.qualityGate === undefined
		? undefined
		: objectValue(root.qualityGate, "manifest.qualityGate");
	if (
		qualityGate !== undefined &&
		typeof qualityGate.requireCaseAcceptance !== "boolean"
	) {
		throw new Error(
			"manifest.qualityGate.requireCaseAcceptance must be a boolean",
		);
	}
	const casesRaw = arrayValue(root.cases, "manifest.cases");
	if (casesRaw.length === 0) throw new Error("manifest.cases must not be empty");
	const seenCaseIds = new Set<string>();
	const cases = casesRaw.map((candidate, index) => {
		const evaluationCase = parseEvaluationCase(candidate, index);
		if (seenCaseIds.has(evaluationCase.id)) {
			throw new Error(`duplicate case id: ${evaluationCase.id}`);
		}
		seenCaseIds.add(evaluationCase.id);
		return evaluationCase;
	});

	return {
		schemaVersion: VOICE_EVALUATION_MANIFEST_SCHEMA_VERSION,
		name: identifier(root.name, "manifest.name"),
		corpusVersion: boundedString(
			root.corpusVersion,
			"manifest.corpusVersion",
			80,
		),
		description: boundedString(
			root.description,
			"manifest.description",
			2_000,
		),
		coverageRequirements: {
			requiredSlices,
			minimumHumanSpeakers: nonNegativeInteger(
				requirements.minimumHumanSpeakers,
				"coverageRequirements.minimumHumanSpeakers",
			),
			minimumMicrophones: nonNegativeInteger(
				requirements.minimumMicrophones,
				"coverageRequirements.minimumMicrophones",
			),
		},
		qualityGate: {
			requireCaseAcceptance:
				qualityGate?.requireCaseAcceptance === true,
		},
		cases,
	};
}

export function evaluateVoiceCorpusCoverage(
	manifest: VoiceEvaluationManifest,
): VoiceCorpusCoverage {
	const presentSlices = [
		...new Set(manifest.cases.flatMap((evaluationCase) => evaluationCase.slices)),
	].sort((left, right) => left.localeCompare(right));
	const presentSet = new Set(presentSlices);
	const missingSlices = manifest.coverageRequirements.requiredSlices.filter(
		(slice) => !presentSet.has(slice),
	);
	const humanSpeakerIds = new Set(
		manifest.cases
			.filter((evaluationCase) => evaluationCase.speaker.kind === "human")
			.map((evaluationCase) => evaluationCase.speaker.id),
	);
	const microphoneIds = new Set(
		manifest.cases
			.filter(
				(evaluationCase) =>
					evaluationCase.speaker.kind === "human" &&
					evaluationCase.microphone.verification === "hardware-verified",
			)
			.map((evaluationCase) => evaluationCase.microphone.id),
	);
	const humanSpeakers = {
		required: manifest.coverageRequirements.minimumHumanSpeakers,
		actual: humanSpeakerIds.size,
		complete:
			humanSpeakerIds.size >=
			manifest.coverageRequirements.minimumHumanSpeakers,
	};
	const microphones = {
		required: manifest.coverageRequirements.minimumMicrophones,
		actual: microphoneIds.size,
		complete:
			microphoneIds.size >= manifest.coverageRequirements.minimumMicrophones,
	};
	const provisionalReferences = manifest.cases.filter(
		(evaluationCase) =>
			evaluationCase.referenceProvenance.kind === "model-derived-provisional",
	).length;
	const referenceTranscripts = {
		verified: manifest.cases.length - provisionalReferences,
		provisional: provisionalReferences,
		complete: provisionalReferences === 0,
	};
	return {
		complete:
			missingSlices.length === 0 &&
			humanSpeakers.complete &&
			microphones.complete &&
			referenceTranscripts.complete,
		presentSlices,
		missingSlices,
		humanSpeakers,
		microphones,
		referenceTranscripts,
	};
}

export function evaluateVoiceQualityGate(
	manifest: VoiceEvaluationManifest,
	caseSummaries: VoiceEvaluationReport["caseSummaries"],
): VoiceQualityGateResult {
	const summariesById = new Map(
		caseSummaries.map((summary) => [summary.caseId, summary]),
	);
	const missingAcceptanceCaseIds = manifest.qualityGate.requireCaseAcceptance
		? manifest.cases
				.filter((evaluationCase) => evaluationCase.acceptance === undefined)
				.map((evaluationCase) => evaluationCase.id)
		: [];
	const unevaluatedCaseIds: string[] = [];
	const cases: VoiceQualityGateResult["cases"] = [];

	for (const evaluationCase of manifest.cases) {
		const acceptance = evaluationCase.acceptance;
		if (!acceptance) continue;
		const summary = summariesById.get(evaluationCase.id);
		if (!summary || summary.completedRuns === 0) {
			unevaluatedCaseIds.push(evaluationCase.id);
			continue;
		}
		const stage = summary.stages[acceptance.stage];
		const metrics: VoiceQualityMetricResult[] = [];
		addQualityMetric(metrics, "wer", "max", acceptance.maxWer, stage.wer?.rate ?? null);
		addQualityMetric(metrics, "cer", "max", acceptance.maxCer, stage.cer?.rate ?? null);
		addQualityMetric(
			metrics,
			"contentCer",
			"max",
			acceptance.maxContentCer,
			stage.contentCer?.rate ?? null,
		);
		addQualityMetric(
			metrics,
			"termPrecision",
			"min",
			acceptance.minTermPrecision,
			stage.terms.precision,
		);
		addQualityMetric(
			metrics,
			"termRecall",
			"min",
			acceptance.minTermRecall,
			stage.terms.recall,
		);
		addQualityMetric(
			metrics,
			"exactCanonicalRate",
			"min",
			acceptance.minExactCanonicalRate,
			stage.terms.exactCanonicalRate,
		);
		addQualityMetric(
			metrics,
			"falseReplacementRate",
			"max",
			acceptance.maxFalseReplacementRate,
			stage.terms.falseReplacementRate,
		);
		cases.push({
			caseId: evaluationCase.id,
			stage: acceptance.stage,
			passed: metrics.every((metric) => metric.passed),
			metrics,
		});
	}

	const failingCaseIds = cases
		.filter((evaluationCase) => !evaluationCase.passed)
		.map((evaluationCase) => evaluationCase.caseId);
	return {
		required: manifest.qualityGate.requireCaseAcceptance,
		complete:
			missingAcceptanceCaseIds.length === 0 &&
			unevaluatedCaseIds.length === 0 &&
			failingCaseIds.length === 0,
		passingCaseCount: cases.length - failingCaseIds.length,
		failingCaseIds,
		missingAcceptanceCaseIds,
		unevaluatedCaseIds,
		cases,
	};
}

function addQualityMetric(
	results: VoiceQualityMetricResult[],
	metric: VoiceQualityMetricName,
	direction: "max" | "min",
	threshold: number | undefined,
	actual: number | null,
): void {
	if (threshold === undefined) return;
	results.push({
		metric,
		direction,
		threshold,
		actual,
		passed:
			actual !== null &&
			(direction === "max" ? actual <= threshold : actual >= threshold),
	});
}

export function scoreVoiceTranscript(input: {
	referenceText: string;
	hypothesisText: string;
	metrics: VoiceEvaluationMetric[];
	terms: VoiceEvaluationTerm[];
	forbiddenTerms: string[];
}): VoiceTranscriptScore {
	const metrics = new Set(input.metrics);
	const referenceWords = wordUnits(input.referenceText);
	const hypothesisWords = wordUnits(input.hypothesisText);
	const referenceCharacters = characterUnits(input.referenceText);
	const hypothesisCharacters = characterUnits(input.hypothesisText);
	const referenceContentCharacters = characterUnits(
		normalizeChineseContentForScoring(input.referenceText),
	);
	const hypothesisContentCharacters = characterUnits(
		normalizeChineseContentForScoring(input.hypothesisText),
	);
	return {
		wer: metrics.has("wer")
			? editMetric(referenceWords, hypothesisWords)
			: null,
		cer: metrics.has("cer")
			? editMetric(referenceCharacters, hypothesisCharacters)
			: null,
		contentCer: metrics.has("content-cer")
			? editMetric(referenceContentCharacters, hypothesisContentCharacters)
			: null,
		terms: scoreTerms(
			input.hypothesisText,
			input.terms,
			input.forbiddenTerms,
		),
	};
}

export function nearestRankPercentile(
	values: number[],
	percentile: number,
): number | null {
	if (!(percentile > 0 && percentile <= 1)) {
		throw new Error("percentile must be greater than 0 and at most 1");
	}
	if (values.length === 0) return null;
	if (values.some((value) => !Number.isFinite(value) || value < 0)) {
		throw new Error("percentile values must be finite non-negative numbers");
	}
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
}

export function scheduleVoiceEvaluationRuns(
	cases: VoiceEvaluationCase[],
	runsPerCase: number,
	runClass: VoiceEvaluationRunClass,
): VoiceEvaluationRunScheduleItem[] {
	if (!Number.isInteger(runsPerCase) || runsPerCase < 1 || runsPerCase > 100) {
		throw new Error("runsPerCase must be an integer from 1 to 100");
	}
	if (runClass !== "cold" && runClass !== "warm") {
		throw new Error("runClass must be cold or warm");
	}
	const schedule: VoiceEvaluationRunScheduleItem[] = [];
	for (let runIndex = 1; runIndex <= runsPerCase; runIndex += 1) {
		const orderedCases = runIndex % 2 === 0 ? [...cases].reverse() : cases;
		for (const evaluationCase of orderedCases) {
			schedule.push({
				evaluationCase,
				runIndex,
				runId: `${evaluationCase.id}-${runClass}-${runIndex}`,
				runClass,
			});
		}
	}
	return schedule;
}

export function buildVoiceEvaluationReport(input: {
	manifest: VoiceEvaluationManifest;
	generatedAt?: string;
	runtime: VoiceEvaluationRuntimeMetadata;
	observations: VoiceEvaluationObservation[];
}): VoiceEvaluationReport {
	if (input.runtime.isolatedSidecarPerRun === true) {
		for (const observation of input.observations) {
			if (observation.runClass !== "cold") {
				throw new Error(
					`runtime claims isolated cold execution but observation ${observation.runId} is not cold`,
				);
			}
			if (!observation.coldStart) {
				throw new Error(
					`runtime claims isolated cold execution but observation ${observation.runId} has no cold-start evidence`,
				);
			}
		}
	}
	if (input.runtime.firstPartialMeasurementEnabled === true) {
		for (const observation of input.observations) {
			if (observation.runClass !== "warm") {
				throw new Error(
					`runtime claims first-partial measurement but observation ${observation.runId} is not warm`,
				);
			}
			if (observation.ok && !observation.firstPartial) {
				throw new Error(
					`runtime claims first-partial measurement but observation ${observation.runId} has no evidence`,
				);
			}
		}
	}
	const casesById = new Map(
		input.manifest.cases.map((evaluationCase) => [
			evaluationCase.id,
			evaluationCase,
		]),
	);
	const seenRunIds = new Set<string>();
	const scoredRuns: VoiceEvaluationReport["runs"] = input.observations.map(
		(observation) => {
			if (seenRunIds.has(observation.runId)) {
				throw new Error(`duplicate observation runId: ${observation.runId}`);
			}
			seenRunIds.add(observation.runId);
			const evaluationCase = casesById.get(observation.caseId);
			if (!evaluationCase) {
				throw new Error(`unknown observation caseId: ${observation.caseId}`);
			}
			validateObservation(observation, evaluationCase);
			if (!observation.ok) return { ...observation };
			if (
				observation.rawText === undefined ||
				observation.canonicalText === undefined ||
				observation.draftText === undefined
			) {
				throw new Error(
					`successful observation ${observation.runId} must include all transcript stages`,
				);
			}
			return {
				...observation,
				scores: {
					raw: scoreCase(evaluationCase, observation.rawText),
					canonical: scoreCase(
						evaluationCase,
						observation.canonicalText,
					),
					draft: scoreCase(evaluationCase, observation.draftText),
				},
			};
		},
	);
	const completed = scoredRuns.filter(
		(run): run is typeof run & { scores: NonNullable<typeof run.scores> } =>
			run.ok && run.scores !== undefined,
	);
	const evaluatedCaseIds = new Set(scoredRuns.map((run) => run.caseId));
	const unevaluatedCaseIds = input.manifest.cases
		.map((evaluationCase) => evaluationCase.id)
		.filter((caseId) => !evaluatedCaseIds.has(caseId));
	const caseSummaries: VoiceEvaluationReport["caseSummaries"] =
		input.manifest.cases.map((evaluationCase) => {
			const caseRuns = scoredRuns.filter(
				(run) => run.caseId === evaluationCase.id,
			);
			const completedCaseRuns = caseRuns.filter(
				(
					run,
				): run is typeof run & {
					scores: NonNullable<typeof run.scores>;
				} => run.ok && run.scores !== undefined,
			);
			return {
				caseId: evaluationCase.id,
				description: evaluationCase.description,
				glossaryEntryCount: evaluationCase.pipeline.glossary.filter(
					(entry) => entry.enabled,
				).length,
				totalRuns: caseRuns.length,
				completedRuns: completedCaseRuns.length,
				failedRuns: caseRuns.length - completedCaseRuns.length,
				stages: {
					raw: aggregateScores(
						completedCaseRuns.map((run) => run.scores.raw),
					),
					canonical: aggregateScores(
						completedCaseRuns.map((run) => run.scores.canonical),
					),
					draft: aggregateScores(
						completedCaseRuns.map((run) => run.scores.draft),
					),
				},
				latency: {
					cold: latencyForClass(caseRuns, "cold"),
					warm: latencyForClass(caseRuns, "warm"),
				},
			};
		});
	const qualityGate = evaluateVoiceQualityGate(input.manifest, caseSummaries);

	return {
		schemaVersion: VOICE_EVALUATION_REPORT_SCHEMA_VERSION,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		manifest: {
			name: input.manifest.name,
			corpusVersion: input.manifest.corpusVersion,
			digest: voiceEvaluationManifestDigest(input.manifest),
			caseCount: input.manifest.cases.length,
		},
		runtime: { ...input.runtime },
		coverage: evaluateVoiceCorpusCoverage(input.manifest),
		qualityGate,
		summary: {
			totalRuns: scoredRuns.length,
			completedRuns: completed.length,
			failedRuns: scoredRuns.length - completed.length,
			executionComplete: unevaluatedCaseIds.length === 0,
			evaluatedCaseCount: evaluatedCaseIds.size,
			unevaluatedCaseIds,
		},
		caseSummaries,
		stages: {
			raw: aggregateScores(completed.map((run) => run.scores.raw)),
			canonical: aggregateScores(
				completed.map((run) => run.scores.canonical),
			),
			draft: aggregateScores(completed.map((run) => run.scores.draft)),
		},
		latency: {
			cold: latencyForClass(scoredRuns, "cold"),
			warm: latencyForClass(scoredRuns, "warm"),
		},
		runs: scoredRuns,
	};
}

export function voiceEvaluationManifestDigest(
	manifest: VoiceEvaluationManifest,
): string {
	return hashJson(manifest);
}

function parseEvaluationCase(
	value: unknown,
	index: number,
): VoiceEvaluationCase {
	const field = `manifest.cases[${index}]`;
	const candidate = objectValue(value, field);
	const audio = objectValue(candidate.audio, `${field}.audio`);
	const source = objectValue(audio.source, `${field}.audio.source`);
	const speaker = objectValue(candidate.speaker, `${field}.speaker`);
	const microphone = objectValue(
		candidate.microphone,
		`${field}.microphone`,
	);
	const referenceProvenance = objectValue(
		candidate.referenceProvenance,
		`${field}.referenceProvenance`,
	);
	const pipeline = candidate.pipeline === undefined
		? {}
		: objectValue(candidate.pipeline, `${field}.pipeline`);
	const audioPath = boundedString(audio.path, `${field}.audio.path`, 500);
	if (
		audioPath.includes("\\") ||
		posix.isAbsolute(audioPath) ||
		posix.normalize(audioPath) !== audioPath ||
		audioPath.split("/").some((part) => part === ".." || part === ".")
	) {
		throw new Error(`${field}.audio.path must be a normalized safe relative path`);
	}
	const sha256 = boundedString(audio.sha256, `${field}.audio.sha256`, 64);
	if (!/^[a-f0-9]{64}$/.test(sha256)) {
		throw new Error(`${field}.audio.sha256 must be lowercase hexadecimal`);
	}
	const downloadUrl = audio.downloadUrl === undefined
		? undefined
		: boundedString(audio.downloadUrl, `${field}.audio.downloadUrl`, 2_000);
	if (downloadUrl) {
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(downloadUrl);
		} catch {
			throw new Error(`${field}.audio.downloadUrl must be a valid HTTPS URL`);
		}
		if (parsedUrl.protocol !== "https:") {
			throw new Error(`${field}.audio.downloadUrl must use HTTPS`);
		}
	}
	const audioDurationSec = audio.durationSec === undefined
		? undefined
		: positiveFiniteNumber(
				audio.durationSec,
				`${field}.audio.durationSec`,
			);
	const speechOnset = audio.speechOnset === undefined
		? undefined
		: parseSpeechOnsetAnnotation(
				audio.speechOnset,
				`${field}.audio.speechOnset`,
				audioDurationSec,
			);
	const metrics = uniqueStrings(candidate.metrics, `${field}.metrics`, {
		minItems: 1,
	}) as VoiceEvaluationMetric[];
	if (
		metrics.some(
			(metric) =>
				metric !== "wer" && metric !== "cer" && metric !== "content-cer",
		)
	) {
		throw new Error(`${field}.metrics only supports wer, cer and content-cer`);
	}
	const terms = arrayValue(candidate.terms ?? [], `${field}.terms`).map(
		(term, termIndex) => {
			const parsed = objectValue(term, `${field}.terms[${termIndex}]`);
			return {
				canonical: boundedString(
					parsed.canonical,
					`${field}.terms[${termIndex}].canonical`,
					120,
				),
				expectedOccurrences: positiveInteger(
					parsed.expectedOccurrences,
					`${field}.terms[${termIndex}].expectedOccurrences`,
				),
			};
		},
	);
	const forbiddenTerms = uniqueStrings(
		candidate.forbiddenTerms ?? [],
		`${field}.forbiddenTerms`,
	);
	const acceptance = candidate.acceptance === undefined
		? undefined
		: parseVoiceEvaluationAcceptance({
				value: candidate.acceptance,
				field: `${field}.acceptance`,
				metrics,
				terms,
				forbiddenTerms,
			});
	const sourceLicense = boundedString(
		source.license,
		`${field}.audio.source.license`,
		120,
	);
	const languageHint = pipeline.languageHint === undefined
		? undefined
		: boundedString(
				pipeline.languageHint,
				`${field}.pipeline.languageHint`,
				24,
			);
	if (
		languageHint &&
		!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(languageHint)
	) {
		throw new Error(`${field}.pipeline.languageHint is invalid`);
	}
	const languagePreference = pipeline.languagePreference === undefined
		? undefined
		: pipeline.languagePreference;
	if (
		languagePreference !== undefined &&
		!isVoiceLanguagePreference(languagePreference)
	) {
		throw new Error(`${field}.pipeline.languagePreference is invalid`);
	}
	if (
		pipeline.vad !== undefined &&
		!isNormalizedVoiceVadConfig(pipeline.vad)
	) {
		throw new Error(`${field}.pipeline.vad must use normalized bounded values`);
	}
	const speakerKind = speaker.kind;
	if (speakerKind !== "human" && speakerKind !== "synthetic") {
		throw new Error(`${field}.speaker.kind must be human or synthetic`);
	}
	const microphoneVerification = microphone.verification;
	if (
		microphoneVerification !== "hardware-verified" &&
		microphoneVerification !== "recording-condition-only" &&
		microphoneVerification !== "synthetic"
	) {
		throw new Error(
			`${field}.microphone.verification must be hardware-verified, recording-condition-only or synthetic`,
		);
	}
	if (
		(speakerKind === "synthetic") !==
		(microphoneVerification === "synthetic")
	) {
		throw new Error(
			`${field}.microphone.verification must be synthetic exactly when speaker.kind is synthetic`,
		);
	}
	const referenceProvenanceKind = referenceProvenance.kind;
	if (
		referenceProvenanceKind !== "source-authored" &&
		referenceProvenanceKind !== "human-verified" &&
		referenceProvenanceKind !== "model-derived-provisional"
	) {
		throw new Error(
			`${field}.referenceProvenance.kind must be source-authored, human-verified or model-derived-provisional`,
		);
	}

	return {
		id: identifier(candidate.id, `${field}.id`),
		description: boundedString(candidate.description, `${field}.description`, 500),
		audio: {
			path: audioPath,
			mime: boundedString(audio.mime, `${field}.audio.mime`, 120),
			sha256,
			...(downloadUrl ? { downloadUrl } : {}),
			...(audioDurationSec === undefined
				? {}
				: { durationSec: audioDurationSec }),
			...(speechOnset ? { speechOnset } : {}),
			source: {
				kind: identifier(source.kind, `${field}.audio.source.kind`),
				name: boundedString(
					source.name,
					`${field}.audio.source.name`,
					300,
				),
				license: sourceLicense,
				...(source.url === undefined
					? {}
					: {
							url: boundedString(
								source.url,
								`${field}.audio.source.url`,
								1_000,
							),
						}),
			},
		},
		referenceText: boundedString(
			candidate.referenceText,
			`${field}.referenceText`,
			20_000,
		),
		referenceProvenance: {
			kind: referenceProvenanceKind,
			note: boundedString(
				referenceProvenance.note,
				`${field}.referenceProvenance.note`,
				1_000,
			),
		},
		language: boundedString(candidate.language, `${field}.language`, 24),
		metrics,
		slices: uniqueStrings(candidate.slices, `${field}.slices`, {
			minItems: 1,
			slug: true,
		}),
		speaker: {
			id: identifier(speaker.id, `${field}.speaker.id`),
			kind: speakerKind,
		},
		microphone: {
			id: identifier(microphone.id, `${field}.microphone.id`),
			verification: microphoneVerification,
			note: boundedString(
				microphone.note,
				`${field}.microphone.note`,
				500,
			),
		},
		terms,
		forbiddenTerms,
		...(acceptance ? { acceptance } : {}),
		pipeline: {
			...(languageHint ? { languageHint } : {}),
			...(languagePreference ? { languagePreference } : {}),
			...(pipeline.provider === undefined
				? {}
				: {
						provider: identifier(
							pipeline.provider,
							`${field}.pipeline.provider`,
						),
					}),
			cleanupRequested: pipeline.cleanupRequested === true,
			vad: normalizeVoiceVadConfig(pipeline.vad),
			glossary: normalizeGlossaryEntries(pipeline.glossary ?? []),
		},
	};
}

function parseVoiceEvaluationAcceptance(input: {
	value: unknown;
	field: string;
	metrics: VoiceEvaluationMetric[];
	terms: VoiceEvaluationTerm[];
	forbiddenTerms: string[];
}): VoiceEvaluationAcceptance {
	const candidate = objectValue(input.value, input.field);
	const allowedFields = new Set([
		"stage",
		"maxWer",
		"maxCer",
		"maxContentCer",
		"minTermPrecision",
		"minTermRecall",
		"minExactCanonicalRate",
		"maxFalseReplacementRate",
	]);
	const unknownField = Object.keys(candidate).find(
		(field) => !allowedFields.has(field),
	);
	if (unknownField) {
		throw new Error(`${input.field}.${unknownField} is not supported`);
	}
	const stage = candidate.stage;
	if (stage !== "raw" && stage !== "canonical" && stage !== "draft") {
		throw new Error(`${input.field}.stage must be raw, canonical or draft`);
	}
	const thresholds = {
		maxWer: optionalUnitIntervalNumber(candidate.maxWer, `${input.field}.maxWer`),
		maxCer: optionalUnitIntervalNumber(candidate.maxCer, `${input.field}.maxCer`),
		maxContentCer: optionalUnitIntervalNumber(
			candidate.maxContentCer,
			`${input.field}.maxContentCer`,
		),
		minTermPrecision: optionalUnitIntervalNumber(
			candidate.minTermPrecision,
			`${input.field}.minTermPrecision`,
		),
		minTermRecall: optionalUnitIntervalNumber(
			candidate.minTermRecall,
			`${input.field}.minTermRecall`,
		),
		minExactCanonicalRate: optionalUnitIntervalNumber(
			candidate.minExactCanonicalRate,
			`${input.field}.minExactCanonicalRate`,
		),
		maxFalseReplacementRate: optionalUnitIntervalNumber(
			candidate.maxFalseReplacementRate,
			`${input.field}.maxFalseReplacementRate`,
		),
	};
	if (Object.values(thresholds).every((threshold) => threshold === undefined)) {
		throw new Error(`${input.field} must declare at least one threshold`);
	}
	if (thresholds.maxWer !== undefined && !input.metrics.includes("wer")) {
		throw new Error(`${input.field}.maxWer requires the case wer metric`);
	}
	if (thresholds.maxCer !== undefined && !input.metrics.includes("cer")) {
		throw new Error(`${input.field}.maxCer requires the case cer metric`);
	}
	if (
		thresholds.maxContentCer !== undefined &&
		!input.metrics.includes("content-cer")
	) {
		throw new Error(
			`${input.field}.maxContentCer requires the case content-cer metric`,
		);
	}
	if (
		input.terms.length === 0 &&
		(thresholds.minTermPrecision !== undefined ||
			thresholds.minTermRecall !== undefined ||
			thresholds.minExactCanonicalRate !== undefined)
	) {
		throw new Error(
			`${input.field} term thresholds require at least one expected term`,
		);
	}
	if (
		thresholds.maxFalseReplacementRate !== undefined &&
		input.forbiddenTerms.length === 0
	) {
		throw new Error(
			`${input.field}.maxFalseReplacementRate requires forbiddenTerms`,
		);
	}
	return {
		stage,
		...Object.fromEntries(
			Object.entries(thresholds).filter(([, value]) => value !== undefined),
		),
	};
}

function scoreCase(
	evaluationCase: VoiceEvaluationCase,
	hypothesisText: string,
): VoiceTranscriptScore {
	return scoreVoiceTranscript({
		referenceText: evaluationCase.referenceText,
		hypothesisText,
		metrics: evaluationCase.metrics,
		terms: evaluationCase.terms,
		forbiddenTerms: evaluationCase.forbiddenTerms,
	});
}

function scoreTerms(
	hypothesisText: string,
	terms: VoiceEvaluationTerm[],
	forbiddenTerms: string[],
): VoiceTermMetrics {
	let truePositiveOccurrences = 0;
	let expectedOccurrences = 0;
	let observedOccurrences = 0;
	let exactCanonicalOccurrences = 0;
	for (const term of terms) {
		const observed = countTerm(hypothesisText, term.canonical, false);
		const exact = countTerm(hypothesisText, term.canonical, true);
		expectedOccurrences += term.expectedOccurrences;
		observedOccurrences += observed;
		truePositiveOccurrences += Math.min(observed, term.expectedOccurrences);
		exactCanonicalOccurrences += Math.min(exact, term.expectedOccurrences);
	}
	let falseReplacementTermCount = 0;
	let falseReplacementCount = 0;
	for (const term of forbiddenTerms) {
		const observed = countTerm(hypothesisText, term, true);
		if (observed > 0) falseReplacementTermCount += 1;
		falseReplacementCount += observed;
	}
	return {
		truePositiveOccurrences,
		expectedOccurrences,
		observedOccurrences,
		precision:
			observedOccurrences === 0
				? expectedOccurrences === 0
					? null
					: 0
				: truePositiveOccurrences / observedOccurrences,
		recall:
			expectedOccurrences === 0
				? null
				: truePositiveOccurrences / expectedOccurrences,
		exactCanonicalOccurrences,
		exactCanonicalRate:
			expectedOccurrences === 0
				? null
				: exactCanonicalOccurrences / expectedOccurrences,
		forbiddenTermCount: forbiddenTerms.length,
		falseReplacementTermCount,
		falseReplacementCount,
		falseReplacementRate:
			forbiddenTerms.length === 0
				? null
				: falseReplacementTermCount / forbiddenTerms.length,
	};
}

function countTerm(text: string, term: string, exactCase: boolean): number {
	const normalizedText = text.normalize("NFKC");
	const normalizedTerm = term.normalize("NFKC").trim();
	if (!normalizedTerm) return 0;
	const escaped = normalizedTerm
		.split(/\s+/u)
		.map(escapeRegExp)
		.join("\\s+");
	const termCharacters = [...normalizedTerm];
	const startBoundary = lexicalBoundaryClass(termCharacters[0]);
	const endBoundary = lexicalBoundaryClass(termCharacters.at(-1));
	const expression = `${startBoundary ? `(?<![${startBoundary}])` : ""}${escaped}${endBoundary ? `(?![${endBoundary}])` : ""}`;
	const flags = exactCase ? "gu" : "giu";
	return [...normalizedText.matchAll(new RegExp(expression, flags))].length;
}

function lexicalBoundaryClass(character: string | undefined): string | null {
	if (!character || !/[\p{L}\p{N}_]/u.test(character)) return null;
	if (
		/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
			character,
		)
	) {
		return null;
	}
	if (/\p{Script=Latin}/u.test(character)) {
		return "\\p{Script=Latin}\\p{N}_";
	}
	return "\\p{L}\\p{N}_";
}

function wordUnits(text: string): string[] {
	const normalized = text.normalize("NFKC").toLocaleLowerCase();
	const segmenter = new Intl.Segmenter("und", { granularity: "word" });
	return [...segmenter.segment(normalized)]
		.filter((segment) => segment.isWordLike)
		.map((segment) => segment.segment);
}

function characterUnits(text: string): string[] {
	return [
		...text
			.normalize("NFKC")
			.toLocaleLowerCase()
			.replace(/[\s\p{P}\p{S}]+/gu, ""),
	];
}

function editMetric(reference: string[], hypothesis: string[]): VoiceEditMetric {
	const edits = levenshteinDistance(reference, hypothesis);
	return {
		edits,
		referenceUnits: reference.length,
		rate: reference.length === 0 ? null : edits / reference.length,
	};
}

function levenshteinDistance(reference: string[], hypothesis: string[]): number {
	let previous = Array.from(
		{ length: hypothesis.length + 1 },
		(_, index) => index,
	);
	for (let referenceIndex = 1; referenceIndex <= reference.length; referenceIndex += 1) {
		const current = [referenceIndex];
		for (
			let hypothesisIndex = 1;
			hypothesisIndex <= hypothesis.length;
			hypothesisIndex += 1
		) {
			const substitutionCost =
				reference[referenceIndex - 1] === hypothesis[hypothesisIndex - 1]
					? 0
					: 1;
			current[hypothesisIndex] = Math.min(
				(previous[hypothesisIndex] ?? 0) + 1,
				(current[hypothesisIndex - 1] ?? 0) + 1,
				(previous[hypothesisIndex - 1] ?? 0) + substitutionCost,
			);
		}
		previous = current;
	}
	return previous[hypothesis.length] ?? reference.length;
}

function aggregateScores(
	scores: VoiceTranscriptScore[],
): VoiceAggregateStageMetrics {
	return {
		wer: aggregateEditMetric(scores.map((score) => score.wer)),
		cer: aggregateEditMetric(scores.map((score) => score.cer)),
		contentCer: aggregateEditMetric(scores.map((score) => score.contentCer)),
		terms: aggregateTermMetrics(scores.map((score) => score.terms)),
	};
}

function aggregateEditMetric(
	metrics: Array<VoiceEditMetric | null>,
): VoiceEditMetric | null {
	const available = metrics.filter(
		(metric): metric is VoiceEditMetric => metric !== null,
	);
	if (available.length === 0) return null;
	const edits = available.reduce((sum, metric) => sum + metric.edits, 0);
	const referenceUnits = available.reduce(
		(sum, metric) => sum + metric.referenceUnits,
		0,
	);
	return {
		edits,
		referenceUnits,
		rate: referenceUnits === 0 ? null : edits / referenceUnits,
	};
}

function aggregateTermMetrics(metrics: VoiceTermMetrics[]): VoiceTermMetrics {
	const sums = metrics.reduce(
		(total, metric) => ({
			truePositiveOccurrences:
				total.truePositiveOccurrences + metric.truePositiveOccurrences,
			expectedOccurrences:
				total.expectedOccurrences + metric.expectedOccurrences,
			observedOccurrences:
				total.observedOccurrences + metric.observedOccurrences,
			exactCanonicalOccurrences:
				total.exactCanonicalOccurrences + metric.exactCanonicalOccurrences,
			forbiddenTermCount:
				total.forbiddenTermCount + metric.forbiddenTermCount,
			falseReplacementTermCount:
				total.falseReplacementTermCount + metric.falseReplacementTermCount,
			falseReplacementCount:
				total.falseReplacementCount + metric.falseReplacementCount,
		}),
		{
			truePositiveOccurrences: 0,
			expectedOccurrences: 0,
			observedOccurrences: 0,
			exactCanonicalOccurrences: 0,
			forbiddenTermCount: 0,
			falseReplacementTermCount: 0,
			falseReplacementCount: 0,
		},
	);
	return {
		...sums,
		precision:
			sums.observedOccurrences === 0
				? sums.expectedOccurrences === 0
					? null
					: 0
				: sums.truePositiveOccurrences / sums.observedOccurrences,
		recall:
			sums.expectedOccurrences === 0
				? null
				: sums.truePositiveOccurrences / sums.expectedOccurrences,
		exactCanonicalRate:
			sums.expectedOccurrences === 0
				? null
				: sums.exactCanonicalOccurrences / sums.expectedOccurrences,
		falseReplacementRate:
			sums.forbiddenTermCount === 0
				? null
				: sums.falseReplacementTermCount / sums.forbiddenTermCount,
	};
}

function latencyForClass(
	runs: VoiceEvaluationReport["runs"],
	runClass: VoiceEvaluationRunClass,
): {
	pipelineMs: VoiceLatencySummary | null;
	firstPartialMs: VoiceLatencySummary | null;
	speechStartToFirstPartialMs: VoiceLatencySummary | null;
} {
	const matching = runs.filter((run) => run.runClass === runClass);
	return {
		pipelineMs: summarizeLatency(
			matching.map((run) => run.latency.pipelineMs),
		),
		firstPartialMs: summarizeLatency(
			matching.flatMap((run) =>
				run.latency.firstPartialMs === undefined
					? []
					: [run.latency.firstPartialMs],
			),
		),
		speechStartToFirstPartialMs: summarizeLatency(
			matching.flatMap((run) =>
				run.latency.speechStartToFirstPartialMs === undefined
					? []
					: [run.latency.speechStartToFirstPartialMs],
			),
		),
	};
}

function summarizeLatency(values: number[]): VoiceLatencySummary | null {
	if (values.length === 0) return null;
	return {
		count: values.length,
		p50: nearestRankPercentile(values, 0.5)!,
		p95: nearestRankPercentile(values, 0.95)!,
		max: Math.max(...values),
	};
}

function validateObservation(
	observation: VoiceEvaluationObservation,
	evaluationCase: VoiceEvaluationCase,
): void {
	identifier(observation.runId, "observation.runId");
	if (observation.runClass !== "cold" && observation.runClass !== "warm") {
		throw new Error(`observation ${observation.runId} has invalid runClass`);
	}
	positiveOrZeroFiniteNumber(
		observation.latency.pipelineMs,
		`observation ${observation.runId} pipelineMs`,
	);
	if (observation.latency.firstPartialMs !== undefined) {
		positiveOrZeroFiniteNumber(
			observation.latency.firstPartialMs,
			`observation ${observation.runId} firstPartialMs`,
		);
	}
	if (observation.latency.speechStartToFirstPartialMs !== undefined) {
		positiveOrZeroFiniteNumber(
			observation.latency.speechStartToFirstPartialMs,
			`observation ${observation.runId} speechStartToFirstPartialMs`,
		);
	}
	if (
		observation.latency.firstPartialMs !== undefined &&
		observation.firstPartial === undefined
	) {
		throw new Error(
			`observation ${observation.runId} has firstPartialMs without first-partial evidence`,
		);
	}
	if (
		observation.firstPartial !== undefined &&
		observation.latency.firstPartialMs === undefined
	) {
		throw new Error(
			`observation ${observation.runId} has first-partial evidence without firstPartialMs`,
		);
	}
	if (
		observation.latency.speechStartToFirstPartialMs !== undefined &&
		observation.firstPartial?.speechOnset === undefined
	) {
		throw new Error(
			`observation ${observation.runId} has speechStartToFirstPartialMs without speech-onset evidence`,
		);
	}
	if (
		observation.firstPartial?.speechOnset !== undefined &&
		observation.latency.speechStartToFirstPartialMs === undefined
	) {
		throw new Error(
			`observation ${observation.runId} has speech-onset evidence without speechStartToFirstPartialMs`,
		);
	}
	if (observation.firstPartial !== undefined) {
		if (observation.runClass !== "warm") {
			throw new Error(
				`observation ${observation.runId} has ready-state first-partial evidence on a non-warm run`,
			);
		}
		validateFirstPartialEvidence(observation.runId, observation.firstPartial);
		const expectedSpeechOnset = evaluationCase.audio.speechOnset;
		const observedSpeechOnset = observation.firstPartial.speechOnset;
		if (
			stableJson(expectedSpeechOnset) !== stableJson(observedSpeechOnset)
		) {
			throw new Error(
				`observation ${observation.runId} speech-onset evidence does not match its manifest case`,
			);
		}
		if (
			observedSpeechOnset &&
			observation.latency.firstPartialMs !== undefined &&
			observation.latency.speechStartToFirstPartialMs !== undefined
		) {
			const expectedLatency = roundMilliseconds(
				observation.latency.firstPartialMs - observedSpeechOnset.startMs,
			);
			if (expectedLatency !== observation.latency.speechStartToFirstPartialMs) {
				throw new Error(
					`observation ${observation.runId} has inconsistent speechStartToFirstPartialMs`,
				);
			}
		}
	}
	if (observation.coldStart !== undefined) {
		if (observation.runClass !== "cold") {
			throw new Error(
				`observation ${observation.runId} has cold-start evidence on a non-cold run`,
			);
		}
		validateColdStartEvidence(observation.runId, observation.coldStart);
	}
}

function validateFirstPartialEvidence(
	runId: string,
	evidence: VoiceFirstPartialEvidence,
): void {
	identifier(evidence.provider, `observation ${runId} first-partial provider`);
	identifier(evidence.model, `observation ${runId} first-partial model`);
	if (evidence.mode !== "cumulative-snapshot") {
		throw new Error(`observation ${runId} has an invalid first-partial mode`);
	}
	boundedString(evidence.text, `observation ${runId} first-partial text`, 20_000);
	if (
		!Number.isSafeInteger(evidence.sampleRate) ||
		evidence.sampleRate < 8_000 ||
		evidence.sampleRate > 96_000
	) {
		throw new Error(`observation ${runId} has an invalid first-partial sample rate`);
	}
	if (
		!Number.isFinite(evidence.snapshotSeconds) ||
		evidence.snapshotSeconds < 0.1 ||
		evidence.snapshotSeconds > 30
	) {
		throw new Error(`observation ${runId} has an invalid first-partial snapshot window`);
	}
	if (
		!Number.isFinite(evidence.replayChunkMs) ||
		evidence.replayChunkMs < 5 ||
		evidence.replayChunkMs > 1_000
	) {
		throw new Error(`observation ${runId} has an invalid first-partial replay chunk`);
	}
	positiveFiniteNumber(
		evidence.audioSentSec,
		`observation ${runId} first-partial audioSentSec`,
	);
	if (evidence.speechOnset) {
		parseSpeechOnsetAnnotation(
			evidence.speechOnset,
			`observation ${runId} first-partial speechOnset`,
		);
	}
}

function validateColdStartEvidence(
	runId: string,
	evidence: VoiceColdStartEvidence,
): void {
	if (!Number.isInteger(evidence.sidecarPid) || evidence.sidecarPid <= 0) {
		throw new Error(`observation ${runId} has an invalid cold sidecar pid`);
	}
	positiveOrZeroFiniteNumber(
		evidence.sidecarStartupMs,
		`observation ${runId} sidecarStartupMs`,
	);
	if (evidence.asrLoadedBeforeRequest !== false) {
		throw new Error(`observation ${runId} did not prove an unloaded ASR`);
	}
	identifier(evidence.asrModelId, `observation ${runId} cold asrModelId`);
	if (!isAbsolute(evidence.asrModelPath)) {
		throw new Error(`observation ${runId} cold ASR model path is not absolute`);
	}
	let url: URL;
	try {
		url = new URL(evidence.baseUrl);
	} catch {
		throw new Error(`observation ${runId} has an invalid cold sidecar URL`);
	}
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/v1" ||
		!url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(`observation ${runId} cold sidecar URL is not isolated loopback`);
	}
}


function objectValue(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function arrayValue(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	return value;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const normalized = value.trim().normalize("NFC");
	if (!normalized) throw new Error(`${field} must not be empty`);
	if (normalized.length > maxLength) {
		throw new Error(`${field} must contain at most ${maxLength} characters`);
	}
	return normalized;
}

function identifier(value: unknown, field: string): string {
	const normalized = boundedString(value, field, 120);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalized)) {
		throw new Error(`${field} must be a safe identifier`);
	}
	return normalized;
}

function uniqueStrings(
	value: unknown,
	field: string,
	options: { minItems?: number; slug?: boolean } = {},
): string[] {
	const values = arrayValue(value, field).map((candidate, index) =>
		boundedString(candidate, `${field}[${index}]`, 160),
	);
	if (values.length < (options.minItems ?? 0)) {
		throw new Error(`${field} must contain at least ${options.minItems} item(s)`);
	}
	if (new Set(values).size !== values.length) {
		throw new Error(`${field} must not contain duplicates`);
	}
	if (options.slug && values.some((candidate) => !/^[a-z0-9][a-z0-9-]*$/.test(candidate))) {
		throw new Error(`${field} values must be lowercase slugs`);
	}
	return values;
}

function parseManifestIncludes(value: unknown): string[] {
	if (value === undefined) return [];
	return uniqueStrings(value, "manifest.includes").map((include, index) => {
		if (include.includes("\\")) {
			throw new Error(`manifest.includes[${index}] must use forward slashes`);
		}
		return include;
	});
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
	return value;
}

function positiveInteger(value: unknown, field: string): number {
	const parsed = nonNegativeInteger(value, field);
	if (parsed === 0) throw new Error(`${field} must be greater than zero`);
	return parsed;
}

function positiveFiniteNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${field} must be a positive finite number`);
	}
	return value;
}

function positiveOrZeroFiniteNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a finite non-negative number`);
	}
	return value;
}

function parseSpeechOnsetAnnotation(
	value: unknown,
	field: string,
	durationSec?: number,
): VoiceSpeechOnsetAnnotation {
	const annotation = objectValue(value, field);
	const startMs = positiveOrZeroFiniteNumber(
		annotation.startMs,
		`${field}.startMs`,
	);
	if (startMs > 6 * 60 * 60 * 1_000) {
		throw new Error(`${field}.startMs must not exceed six hours`);
	}
	if (durationSec !== undefined && startMs >= durationSec * 1_000) {
		throw new Error(`${field}.startMs must be earlier than audio.durationSec`);
	}
	const method = annotation.method;
	if (
		method !== "human-auditory" &&
		method !== "waveform-spectrogram-reviewed"
	) {
		throw new Error(
			`${field}.method must be human-auditory or waveform-spectrogram-reviewed`,
		);
	}
	return {
		startMs,
		method,
		note: boundedString(annotation.note, `${field}.note`, 1_000),
	};
}

function roundMilliseconds(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function optionalUnitIntervalNumber(
	value: unknown,
	field: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${field} must be a finite number from 0 to 1`);
	}
	return value;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
