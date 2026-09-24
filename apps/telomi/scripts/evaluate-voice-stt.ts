import { cpus, platform, arch, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { voiceDataRoot } from "../server/workspaces/server-runtime-paths.js";
import { writeFileAtomic } from "../server/lib/fs.js";
import { VoiceEvaluationFixtureLoader } from "../server/voice/evaluation-fixtures.js";
import {
	buildGlossaryPrompt,
	glossaryRevision,
} from "../server/voice/glossary.js";
import {
	buildVoiceEvaluationReport,
	evaluateVoiceCorpusCoverage,
	loadVoiceEvaluationManifestFile,
	scheduleVoiceEvaluationRuns,
	type VoiceEvaluationCase,
	type VoiceEvaluationObservation,
	type VoiceEvaluationRunClass,
} from "../server/voice/evaluation.js";
import {
	withIsolatedColdSidecar,
	type VoiceColdStartEvidence,
} from "../server/voice/isolated-cold-sidecar.js";
import {
	decodeEvaluationAudioToPcm16,
	measureLocalSnapshotFirstPartial,
	type VoiceFirstPartialMeasurement,
} from "../server/voice/evaluation-first-partial.js";
import { DEFAULT_SNAPSHOT_SECONDS, LocalSnapshotTranscriptionAdapter } from "../server/voice/local-snapshot-transcription.js";
import { resolveSpeechConfiguration } from "../server/voice/configuration.js";
import { runVoiceTranscriptionPipeline } from "../server/voice/transcription-pipeline.js";
import { audioEnv } from "../server/audio/environment.js";
import { isManagedAudioConnection, MANAGED_AUDIO_CONNECTION_ID } from "../shared/connections.js";

interface CliOptions {
	manifestPath: string;
	outputPath?: string;
	caseFilter?: string;
	runs: number;
	runClass: VoiceEvaluationRunClass;
	isolatedColdSidecar: boolean;
	measureFirstPartial: boolean;
	allowIncompleteCoverage: boolean;
	allowQualityRegressions: boolean;
	allowRemoteFixtures: boolean;
	validateOnly: boolean;
	list: boolean;
	json: boolean;
	help: boolean;
}

const FIRST_PARTIAL_SAMPLE_RATE = 16_000;
const FIRST_PARTIAL_REPLAY_CHUNK_MS = 20;
const appRoot = process.cwd();
const repositoryRoot = resolve(appRoot, "../..");
const options = parseArgs(process.argv.slice(2));

if (options.help) {
	printUsage();
	process.exit(0);
}

const manifestAbsolutePath = resolve(appRoot, options.manifestPath);
const manifest = loadVoiceEvaluationManifestFile(manifestAbsolutePath);
const selectedCases = selectCases(manifest.cases, options.caseFilter);
if (
	(options.isolatedColdSidecar || options.measureFirstPartial) &&
	selectedCases.some(
		(evaluationCase) =>
			!isManagedAudioConnection(evaluationCase.pipeline.provider ?? MANAGED_AUDIO_CONNECTION_ID),
	)
) {
	throw new Error(
		`${options.isolatedColdSidecar ? "--isolated-cold-sidecar" : "--measure-first-partial"} supports only telomi-audio evaluation cases`,
	);
}
const coverage = evaluateVoiceCorpusCoverage(manifest);
const missingAcceptanceCaseIds = manifest.qualityGate.requireCaseAcceptance
	? manifest.cases
			.filter((evaluationCase) => evaluationCase.acceptance === undefined)
			.map((evaluationCase) => evaluationCase.id)
	: [];
const fixtureLoader = new VoiceEvaluationFixtureLoader({
	repositoryRoot,
	cacheRoot: resolve(voiceDataRoot(appRoot), "evaluation-fixtures"),
});

if (options.list || options.validateOnly) {
	const result = {
		manifest: manifest.name,
		corpusVersion: manifest.corpusVersion,
		caseCount: manifest.cases.length,
		selectedCaseCount: selectedCases.length,
		coverage,
		qualityGate: {
			required: manifest.qualityGate.requireCaseAcceptance,
			configuredCaseCount: manifest.cases.length - missingAcceptanceCaseIds.length,
			missingAcceptanceCaseIds,
		},
		cases: selectedCases.map((evaluationCase) => ({
			id: evaluationCase.id,
			slices: evaluationCase.slices,
			speaker: evaluationCase.speaker,
			microphone: evaluationCase.microphone,
			audioPath: evaluationCase.audio.path,
		})),
	};
	console.log(JSON.stringify(result, null, 2));
	if (options.validateOnly) {
		for (const evaluationCase of selectedCases) {
			await fixtureLoader.load(evaluationCase, {
				allowRemote: options.allowRemoteFixtures,
			});
		}
	}
	if (!coverage.complete && !options.allowIncompleteCoverage) process.exitCode = 2;
	if (
		process.exitCode === undefined &&
		manifest.qualityGate.requireCaseAcceptance &&
		missingAcceptanceCaseIds.length > 0 &&
		!options.allowQualityRegressions
	) {
		process.exitCode = 3;
	}
} else {
	const observations: VoiceEvaluationObservation[] = [];
	const audioByCaseId = new Map(
		await Promise.all(
			selectedCases.map(async (evaluationCase) => [
				evaluationCase.id,
				await fixtureLoader.load(evaluationCase, {
					allowRemote: options.allowRemoteFixtures,
				}),
			] as const),
		),
	);
	const previewPcmByCaseId = options.measureFirstPartial
		? new Map(
				[...audioByCaseId].map(([caseId, audio]) => [
					caseId,
					decodeEvaluationAudioToPcm16(audio, FIRST_PARTIAL_SAMPLE_RATE),
				] as const),
			)
		: null;
	for (const scheduled of scheduleVoiceEvaluationRuns(
		selectedCases,
		options.runs,
		options.runClass,
	)) {
		const { evaluationCase, runId } = scheduled;
		const audio = audioByCaseId.get(evaluationCase.id)!;
		const runObservation = async (
			coldStart?: VoiceColdStartEvidence,
		): Promise<void> => {
			process.stderr.write(
				`[voice-eval] ${runId}: ${audio.length} bytes via ${evaluationCase.pipeline.provider ?? MANAGED_AUDIO_CONNECTION_ID}${coldStart ? `; isolated cold pid ${coldStart.sidecarPid}` : ""}\n`,
			);
			let firstPartial: VoiceFirstPartialMeasurement | undefined;
			if (options.measureFirstPartial) {
				try {
					const snapshotSeconds = DEFAULT_SNAPSHOT_SECONDS;
					const glossaryPrompt = buildGlossaryPrompt(evaluationCase.pipeline.glossary);
					firstPartial = await measureLocalSnapshotFirstPartial({
						pcm: previewPcmByCaseId!.get(evaluationCase.id)!,
						sampleRate: FIRST_PARTIAL_SAMPLE_RATE,
						snapshotSeconds,
						replayChunkMs: FIRST_PARTIAL_REPLAY_CHUNK_MS,
						speechOnset: evaluationCase.audio.speechOnset,
						adapterFactory: (callbacks) =>
							new LocalSnapshotTranscriptionAdapter({
								inputSampleRate: FIRST_PARTIAL_SAMPLE_RATE,
								...(evaluationCase.pipeline.languageHint
									? { language: evaluationCase.pipeline.languageHint }
									: {}),
								...(glossaryPrompt ? { prompt: glossaryPrompt } : {}),
								vad: evaluationCase.pipeline.vad,
								model: resolveSpeechConfiguration().local.model,
								snapshotSeconds,
								callbacks,
							}),
					});
				} catch (error) {
					observations.push({
						caseId: evaluationCase.id,
						runId,
						runClass: options.runClass,
						ok: false,
						provider: evaluationCase.pipeline.provider ?? MANAGED_AUDIO_CONNECTION_ID,
						error: `first-partial measurement failed: ${error instanceof Error ? error.message : String(error)}`,
						latency: { pipelineMs: 0 },
					});
					return;
				}
			}
			const startedAt = performance.now();
			try {
				const result = await runVoiceTranscriptionPipeline({
					buffer: audio,
					mime: evaluationCase.audio.mime,
					language: evaluationCase.pipeline.languageHint,
					languagePreference: evaluationCase.pipeline.languagePreference,
					provider: evaluationCase.pipeline.provider ?? MANAGED_AUDIO_CONNECTION_ID,
					cleanupRequested: evaluationCase.pipeline.cleanupRequested,
					vad: evaluationCase.pipeline.vad,
					glossary: {
						revision: glossaryRevision(evaluationCase.pipeline.glossary),
						updatedAt: null,
						entries: evaluationCase.pipeline.glossary,
					},
				});
				const pipelineMs = roundMilliseconds(performance.now() - startedAt);
				if (!result.ok) {
					observations.push({
						caseId: evaluationCase.id,
						runId,
						runClass: options.runClass,
						ok: false,
						provider: result.provider,
						error: result.reason,
						latency: {
							pipelineMs,
							...firstPartialLatency(firstPartial),
						},
						...(firstPartial ? { firstPartial: firstPartial.evidence } : {}),
						...(coldStart ? { coldStart } : {}),
					});
					return;
				}
				const requiredProvider = evaluationCase.pipeline.provider ?? MANAGED_AUDIO_CONNECTION_ID;
				if (result.provider !== requiredProvider) {
					observations.push({
						caseId: evaluationCase.id,
						runId,
						runClass: options.runClass,
						ok: false,
						provider: result.provider,
						model: result.model,
						error: `expected Provider ${requiredProvider}, received ${result.provider}`,
						latency: {
							pipelineMs,
							...firstPartialLatency(firstPartial),
							providerAudioDurationSec: result.durationSec,
						},
						...(firstPartial ? { firstPartial: firstPartial.evidence } : {}),
						...(coldStart ? { coldStart } : {}),
						...(result.vad ? { vad: result.vad } : {}),
					});
					return;
				}
				observations.push({
					caseId: evaluationCase.id,
					runId,
					runClass: options.runClass,
					ok: true,
					provider: result.provider,
					model: result.model,
					language: result.language,
					rawText: result.rawText,
					canonicalText: result.canonicalText,
					draftText: result.text,
					latency: {
						pipelineMs,
						...firstPartialLatency(firstPartial),
						providerAudioDurationSec: result.durationSec,
					},
					...(firstPartial ? { firstPartial: firstPartial.evidence } : {}),
					...(coldStart ? { coldStart } : {}),
					...(result.vad ? { vad: result.vad } : {}),
				});
			} catch (error) {
				observations.push({
					caseId: evaluationCase.id,
					runId,
					runClass: options.runClass,
					ok: false,
					provider: evaluationCase.pipeline.provider ?? MANAGED_AUDIO_CONNECTION_ID,
					error: error instanceof Error ? error.message : String(error),
					latency: {
						pipelineMs: roundMilliseconds(performance.now() - startedAt),
						...firstPartialLatency(firstPartial),
					},
					...(firstPartial ? { firstPartial: firstPartial.evidence } : {}),
					...(coldStart ? { coldStart } : {}),
				});
			}
		};
		if (options.isolatedColdSidecar) {
			await withIsolatedColdSidecar(runObservation);
		} else {
			await runObservation();
		}
	}

	const report = buildVoiceEvaluationReport({
		manifest,
		runtime: runtimeMetadata(options, selectedCases),
		observations,
	});
	const outputPath = resolveOutputPath(options.outputPath, manifest.name);
	writeFileAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`);

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(
			JSON.stringify(
				{
					outputPath,
					coverage: report.coverage,
					summary: report.summary,
					caseSummaries: report.caseSummaries.filter(
						(summary) => summary.totalRuns > 0,
					),
					stages: report.stages,
					latency: report.latency,
					qualityGate: report.qualityGate,
				},
				null,
				2,
			),
		);
	}
	if (report.summary.failedRuns > 0) process.exitCode = 1;
	if (
		process.exitCode === undefined &&
		report.qualityGate.required &&
		!report.qualityGate.complete &&
		!options.allowQualityRegressions
	) {
		process.exitCode = 3;
	}
	if (
		process.exitCode === undefined &&
		(!report.coverage.complete || !report.summary.executionComplete) &&
		!options.allowIncompleteCoverage
	) {
		process.exitCode = 2;
	}
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		manifestPath: "voice-evals/local-qwen-v1.json",
		runs: 5,
		runClass: "warm",
		isolatedColdSidecar: false,
		measureFirstPartial: false,
		allowIncompleteCoverage: false,
		allowQualityRegressions: false,
		allowRemoteFixtures: false,
		validateOnly: false,
		list: false,
		json: false,
		help: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--manifest") {
			options.manifestPath = requiredArg(args, ++index, argument);
		} else if (argument === "--output") {
			options.outputPath = requiredArg(args, ++index, argument);
		} else if (argument === "--case") {
			options.caseFilter = requiredArg(args, ++index, argument);
		} else if (argument === "--runs") {
			const runs = Number(requiredArg(args, ++index, argument));
			if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
				throw new Error("--runs must be an integer from 1 to 100");
			}
			options.runs = runs;
		} else if (argument === "--run-class") {
			const runClass = requiredArg(args, ++index, argument);
			if (runClass !== "cold" && runClass !== "warm") {
				throw new Error("--run-class must be cold or warm");
			}
			options.runClass = runClass;
		} else if (argument === "--isolated-cold-sidecar") {
			options.isolatedColdSidecar = true;
		} else if (argument === "--measure-first-partial") {
			options.measureFirstPartial = true;
		} else if (argument === "--allow-incomplete-coverage") {
			options.allowIncompleteCoverage = true;
		} else if (argument === "--allow-quality-regressions") {
			options.allowQualityRegressions = true;
		} else if (argument === "--fetch-remote-fixtures") {
			options.allowRemoteFixtures = true;
		} else if (argument === "--validate-only") {
			options.validateOnly = true;
		} else if (argument === "--list") {
			options.list = true;
		} else if (argument === "--json") {
			options.json = true;
		} else if (argument === "--help" || argument === "-h") {
			options.help = true;
		} else {
			throw new Error(`unknown argument: ${argument}`);
		}
	}
	if (options.isolatedColdSidecar && options.runClass !== "cold") {
		throw new Error("--isolated-cold-sidecar requires --run-class cold");
	}
	if (options.measureFirstPartial && options.runClass !== "warm") {
		throw new Error("--measure-first-partial requires --run-class warm");
	}
	if (
		options.runClass === "cold" &&
		options.runs !== 1 &&
		!options.isolatedColdSidecar
	) {
		throw new Error(
			"cold runs require --runs 1 so one warm process is not mislabeled as repeated cold starts",
		);
	}
	return options;
}

function requiredArg(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function selectCases(
	cases: VoiceEvaluationCase[],
	filter: string | undefined,
): VoiceEvaluationCase[] {
	if (!filter) return cases;
	const needle = filter.toLocaleLowerCase();
	const selected = cases.filter(
		(evaluationCase) =>
			evaluationCase.id.toLocaleLowerCase().includes(needle) ||
			evaluationCase.description.toLocaleLowerCase().includes(needle),
	);
	if (selected.length === 0) throw new Error(`no cases matched ${filter}`);
	return selected;
}

function runtimeMetadata(
	options: CliOptions,
	cases: VoiceEvaluationCase[],
): Record<string, string | number | boolean | null> & {
	provider: string;
	platform: string;
	hardware: string;
	nodeVersion: string;
} {
	const processors = cpus();
	const providers = [
		...new Set(cases.map((item) => item.pipeline.provider ?? MANAGED_AUDIO_CONNECTION_ID)),
	];
	return {
		provider: providers.length === 1 ? providers[0]! : "per-case",
		platform: `${platform()}-${arch()}-${release()}`,
		hardware: processors[0]?.model ?? "unknown",
		nodeVersion: process.version,
		logicalCpuCount: processors.length,
		totalMemoryBytes: totalmem(),
		runClass: options.runClass,
		isolatedSidecarPerRun: options.isolatedColdSidecar,
		firstPartialMeasurementEnabled: options.measureFirstPartial,
		firstPartialSpeechOnsetAnnotation: options.measureFirstPartial
			? "per-case-when-present"
			: null,
		runsPerCase: options.runs,
		remoteFixtureFetchAllowed: options.allowRemoteFixtures,
		telomiAudioBaseUrl: options.isolatedColdSidecar
			? "isolated-loopback-per-observation"
			: audioEnv("STT_BASE_URL") ?? "http://127.0.0.1:9595/v1",
		telomiAudioModelPath: audioEnv("ASR_MODEL_PATH") ?? null,
		coldBootstrapMode: options.isolatedColdSidecar
			? "reuse-config/environmentironment-without-install-or-download"
			: null,
		firstPartialMode: options.measureFirstPartial
			? "warm-ready-state-cumulative-snapshot-real-time-replay"
			: null,
		firstPartialSampleRate: options.measureFirstPartial
			? FIRST_PARTIAL_SAMPLE_RATE
			: null,
		firstPartialSnapshotSeconds: options.measureFirstPartial
			? DEFAULT_SNAPSHOT_SECONDS
			: null,
		firstPartialReplayChunkMs: options.measureFirstPartial
			? FIRST_PARTIAL_REPLAY_CHUNK_MS
			: null,
	};
}

function resolveOutputPath(candidate: string | undefined, name: string): string {
	if (candidate) return resolve(appRoot, candidate);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return resolve(voiceDataRoot(appRoot), "evaluations", `${name}-${timestamp}.json`);
}

function roundMilliseconds(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function firstPartialLatency(
	measurement: VoiceFirstPartialMeasurement | undefined,
): {
	firstPartialMs?: number;
	speechStartToFirstPartialMs?: number;
} {
	if (!measurement) return {};
	return {
		firstPartialMs: measurement.firstPartialMs,
		...(measurement.speechStartToFirstPartialMs === undefined
			? {}
			: {
					speechStartToFirstPartialMs:
						measurement.speechStartToFirstPartialMs,
				}),
	};
}

function printUsage(): void {
	console.log(`Usage:
  npm run eval:voice-stt -- [options]

Options:
  --manifest <path>              Manifest relative to apps/telomi
  --output <path>                JSON report path; defaults under .pi/voice/evaluations
  --case <fragment>              Run matching case IDs or descriptions
  --runs <1-100>                 Repetitions per case; default 5
  --run-class <cold|warm>        Label the measured process state; default warm
  --isolated-cold-sidecar        Start, prove unloaded and stop one private sidecar per cold observation
  --measure-first-partial        Replay decoded PCM in real time through the production local snapshot preview
  --allow-incomplete-coverage    Produce a provisional report without coverage exit code 2
  --allow-quality-regressions    Produce a diagnostic report without quality exit code 3
  --fetch-remote-fixtures        Explicitly fetch missing HTTPS fixtures into the local .pi cache
  --validate-only                Validate manifest, audio existence and hashes without ASR
  --list                         List selected cases and corpus coverage
  --json                         Print the complete report to stdout
  -h, --help                     Show this help

Without --isolated-cold-sidecar, cold measurements require one run per manually restarted
sidecar invocation. Isolated mode permits repeated cold samples because every observation owns
a new loopback process and records proof that ASR was unloaded immediately before inference.

First-partial mode is warm-only and telomi-audio-only. It connects the production cumulative-snapshot
Adapter before starting the timer, then replays decoded PCM at a real 20 ms wall-clock cadence.
The metric excludes fixture decoding, installation and warmup, and starts at the first audio frame,
not an inferred speech-onset timestamp. When a reviewed per-case speech-onset annotation exists,
the report also includes the onset-relative latency and preserves the annotation provenance.`);
}
