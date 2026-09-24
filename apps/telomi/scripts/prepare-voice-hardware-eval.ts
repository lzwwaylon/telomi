import { resolve } from "node:path";
import { resolveDataDir } from "../server/config/data-dir.js";
import {
	VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
	VOICE_HARDWARE_EVALUATION_CONDITIONS,
	VoiceHardwareEvaluationStore,
	type VoiceHardwareEvaluationCondition,
} from "../server/voice/hardware-evaluation.js";
import { VoiceHistoryStore } from "../server/voice/history.js";

interface CliOptions {
	historyId?: string;
	hardwareName?: string;
	removeCaseId?: string;
	rematerialize: boolean;
	speakerId: string;
	condition: VoiceHardwareEvaluationCondition;
	conditionNote?: string;
	baseManifestPath: string;
	confirmPhysicalHardware: boolean;
	confirmExactPrompt: boolean;
	confirmPrivateAudioCopy: boolean;
	confirmRealCondition: boolean;
	help: boolean;
}

const appRoot = process.cwd();
const repositoryRoot = resolve(appRoot, "../..");
const options = parseArgs(process.argv.slice(2));

if (options.help) {
	printUsage();
	process.exit(0);
}

const store = new VoiceHardwareEvaluationStore({
	historyStore: new VoiceHistoryStore(resolveDataDir()),
	repositoryRoot,
	appRoot,
	baseManifestPath: resolve(appRoot, options.baseManifestPath),
});
if (options.rematerialize) {
	if (
		options.removeCaseId ||
		options.historyId ||
		options.hardwareName ||
		options.confirmPhysicalHardware ||
		options.confirmExactPrompt ||
		options.confirmPrivateAudioCopy ||
		options.confirmRealCondition ||
		options.condition !== "baseline" ||
		options.conditionNote
	) {
		throw new Error("--rematerialize cannot be combined with promotion or removal options");
	}
	const result = store.rematerialize();
	console.log(
		JSON.stringify(
			{
				action: "rematerialized",
				coverage: result.coverage,
				registryPath: result.registryPath,
				manifestPath: result.manifestPath,
				nextCommand: `npm run eval:voice-stt -- --manifest ${relativeToApp(result.manifestPath)} --runs 5`,
			},
			null,
			2,
		),
	);
} else if (options.removeCaseId) {
	if (
		options.historyId ||
		options.hardwareName ||
		options.confirmPhysicalHardware ||
		options.confirmExactPrompt ||
		options.confirmPrivateAudioCopy ||
		options.confirmRealCondition ||
		options.condition !== "baseline" ||
		options.conditionNote
	) {
		throw new Error("--remove-case-id cannot be combined with promotion options");
	}
	const result = store.remove(options.removeCaseId);
	console.log(
		JSON.stringify(
			{
				action: "removed",
				capture: result.removed,
				privateFixtureDeleted: result.privateFixtureDeleted,
				coverage: result.coverage,
				registryPath: result.registryPath,
				manifestPath: result.manifestPath,
			},
			null,
			2,
		),
	);
} else {
	if (!options.historyId) throw new Error("--history-id is required");
	if (!options.hardwareName) throw new Error("--hardware-name is required");
	const result = store.promote({
		historyId: options.historyId,
		hardwareName: options.hardwareName,
		speakerId: options.speakerId,
		condition: options.condition,
		conditionNote: options.conditionNote,
		confirmations: {
			physicalHardware: options.confirmPhysicalHardware,
			exactPrompt: options.confirmExactPrompt,
			privateAudioCopy: options.confirmPrivateAudioCopy,
			realCondition: options.confirmRealCondition,
		},
	});
	console.log(
		JSON.stringify(
			{
				action: "promoted",
				prompt: VOICE_HARDWARE_EVALUATION_PROMPT_ZH,
				capture: result.capture,
				coverage: result.coverage,
				registryPath: result.registryPath,
				manifestPath: result.manifestPath,
				nextCommand: `npm run eval:voice-stt -- --manifest ${relativeToApp(result.manifestPath)} --runs 5`,
				privacyNotice:
					"The content-addressed audio copy is local and ignored by Git. Deleting Voice History does not delete this evaluation copy. Use --remove-case-id to delete it.",
			},
			null,
			2,
		),
	);
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		speakerId: "local-operator",
		condition: "baseline",
		baseManifestPath: "voice-evals/local-qwen-v1.json",
		rematerialize: false,
		confirmPhysicalHardware: false,
		confirmExactPrompt: false,
		confirmPrivateAudioCopy: false,
		confirmRealCondition: false,
		help: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--history-id") {
			options.historyId = requiredArg(args, ++index, argument);
		} else if (argument === "--hardware-name") {
			options.hardwareName = requiredArg(args, ++index, argument);
		} else if (argument === "--remove-case-id") {
			options.removeCaseId = requiredArg(args, ++index, argument);
		} else if (argument === "--rematerialize") {
			options.rematerialize = true;
		} else if (argument === "--speaker-id") {
			options.speakerId = requiredArg(args, ++index, argument);
		} else if (argument === "--condition") {
			const condition = requiredArg(args, ++index, argument);
			if (
				!VOICE_HARDWARE_EVALUATION_CONDITIONS.includes(
					condition as VoiceHardwareEvaluationCondition,
				)
			) {
				throw new Error(
					`--condition must be one of ${VOICE_HARDWARE_EVALUATION_CONDITIONS.join(", ")}`,
				);
			}
			options.condition = condition as VoiceHardwareEvaluationCondition;
		} else if (argument === "--condition-note") {
			options.conditionNote = requiredArg(args, ++index, argument);
		} else if (argument === "--base-manifest") {
			options.baseManifestPath = requiredArg(args, ++index, argument);
		} else if (argument === "--confirm-physical-hardware") {
			options.confirmPhysicalHardware = true;
		} else if (argument === "--confirm-exact-prompt") {
			options.confirmExactPrompt = true;
		} else if (argument === "--confirm-private-audio-copy") {
			options.confirmPrivateAudioCopy = true;
		} else if (argument === "--confirm-real-condition") {
			options.confirmRealCondition = true;
		} else if (argument === "--help" || argument === "-h") {
			options.help = true;
		} else {
			throw new Error(`unknown argument: ${argument}`);
		}
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

function relativeToApp(path: string): string {
	const prefix = `${appRoot}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function printUsage(): void {
	console.log(`Usage:
  npm run eval:voice-stt:promote-hardware -- [promotion options]
  npm run eval:voice-stt:remove-hardware -- --remove-case-id <case-id>
  npm run eval:voice-stt:rematerialize-hardware -- --rematerialize

Record this exact sentence through the Telomi ChatComposer before promotion:
  ${VOICE_HARDWARE_EVALUATION_PROMPT_ZH}

Promotion mode, required:
  --history-id <voice_...>          Completed retained Voice History capture
  --hardware-name <make/model>      Human-confirmed physical device identity
  --confirm-physical-hardware       Confirm the OS input and actual speaking path
  --confirm-exact-prompt            Confirm the speaker read the sentence above exactly
  --confirm-private-audio-copy      Allow a local ignored evaluation copy of the audio

Real-condition promotion:
  --condition <condition>           baseline, room-noise, keyboard-noise or far-field
  --condition-note <description>    Required evidence note for a non-baseline condition
  --confirm-real-condition          Confirm the named acoustic condition really occurred

Optional:
  --speaker-id <id>                 Stable human speaker ID; default local-operator
  --base-manifest <path>            Default voice-evals/local-qwen-v1.json

Removal mode:
  --remove-case-id <case-id>        Remove registry entry and its unshared private audio

Rematerialization mode:
  --rematerialize                   Rebuild the manifest from validated private evidence

General:
  -h, --help                        Show this help

The command rejects missing audio, missing capture evidence, fallback devices,
ambiguous or missing selection, repeated History entries and fingerprints reused
across different hardware identities. It never commits audio or marks hardware
verified without the three base confirmations, and non-baseline captures also
require an explicit real-condition confirmation.`);
}
