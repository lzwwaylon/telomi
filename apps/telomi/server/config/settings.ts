import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { writeFileAtomic } from "../lib/fs.js";
import { resolveAgentPath } from "./agent-directory.js";
import { TASK_MODEL_ROLE_LABELS } from "../../shared/task-model-roles.js";
import type { ThinkingLevel } from "../agent-runtime/model-config/resolve.js";

function settingsPath(): string {
	return resolveAgentPath("settings.json");
}

export const TASK_MODEL_ROLES = [
	"cornellNote",
	"primeRoot",
	"primeChild",
	"wikiMaintainer",
	"browserEvolution",
] as const;
export type TaskModelRole = (typeof TASK_MODEL_ROLES)[number];
export type TaskModelSettings = Partial<Record<TaskModelRole, string>>;

/**
 * One Run Stage of a consuming role.
 *
 * A Stage's reasoning depth is configuration, not a property of the code: with no explicit
 * override it follows the activated capability default, so changing that default reaches every
 * Stage that inherits.
 */
interface TaskModelStageInfo {
	label: string;
	/** Only Research Run stages belong in its durable execution snapshot. */
	runScoped?: boolean;
	/** RLM children share this Root stage's thinking level. */
	usesRlmChild?: boolean;
	/** The explicit per-execution pin: a Run freezes this Stage's depth with it. */
	envVar: string;
}

interface TaskModelRoleInfo {
	label: string;
	description: string;
	/**
	 * Per-execution model pin for Runs and Attestation Replays. Startup clears ambient
	 * values so they cannot outrank the managed settings.
	 */
	legacyEnvVar: string;
	/** The Run Stages whose reasoning depth this role carries; empty where it has none of its own. */
	stages: Readonly<Record<string, TaskModelStageInfo>>;
}

/**
 * Every role inherits its capability default unless the user selects an override. There is no
 * built-in per-role model: without a configured selection the role fails where the user can see
 * it, rather than silently running a model nobody chose.
 */
export const TASK_MODEL_ROLE_INFO = {
	cornellNote: {
		label: TASK_MODEL_ROLE_LABELS.cornellNote,
		description: "将来源整理为证据笔记",
		legacyEnvVar: "TELOMI_RESEARCH_CORNELL_NOTE_MODEL",
		stages: {
			evidenceNote: {
				runScoped: true,
				label: "证据笔记",
				envVar: "TELOMI_RESEARCH_CORNELL_NOTE_THINKING_LEVEL",
			},
		},
	},
	primeRoot: {
		label: TASK_MODEL_ROLE_LABELS.primeRoot,
		description: "搜索、报告、Podcast 文稿与调度审核共享的主 Agent",
		legacyEnvVar: "TELOMI_PRIME_AGENT_ROOT_MODEL",
		stages: {
			searchAcquisition: {
				usesRlmChild: true,
				runScoped: true,
				label: "检索采集",
				envVar: "TELOMI_PRIME_SEARCH_THINKING_LEVEL",
			},
			podcastWriter: { usesRlmChild: true, label: "Podcast 文稿（不含音频合成）", envVar: "TELOMI_PODCAST_WRITER_THINKING_LEVEL" },
			scheduleReview: { label: "调度审核", envVar: "TELOMI_SCHEDULE_REVIEW_THINKING_LEVEL" },
			reportWriter: {
				usesRlmChild: true,
				runScoped: true,
				label: "报告写作",
				envVar: "TELOMI_PRIME_REPORT_THINKING_LEVEL",
			},
		},
	},
	primeChild: {
		label: TASK_MODEL_ROLE_LABELS.primeChild,
		description: "搜索、报告、Podcast 文稿与 Wiki 共享的 RLM child；thinking 跟随对应 Root 环节",
		legacyEnvVar: "TELOMI_PRIME_AGENT_CHILD_MODEL",
		stages: {},
	},
	wikiMaintainer: {
		label: TASK_MODEL_ROLE_LABELS.wikiMaintainer,
		description: "Wiki Root 维护；RLM child 使用共享 Prime Child 模型",
		legacyEnvVar: "TELOMI_WIKI_MAINTAINER_MODEL",
		stages: { maintenance: { usesRlmChild: true, label: "Wiki 维护", envVar: "TELOMI_WIKI_MAINTAINER_THINKING_LEVEL" } },
	},
	browserEvolution: {
		label: TASK_MODEL_ROLE_LABELS.browserEvolution,
		description: "Browser Provider Skill 演进",
		legacyEnvVar: "TELOMI_EVOLUTION_MODEL",
		stages: { evolution: { label: "Skill 演进", envVar: "TELOMI_EVOLUTION_THINKING_LEVEL" } },
	},
} as const satisfies Record<TaskModelRole, TaskModelRoleInfo>;

/** `role.stage`, the key an explicit Stage reasoning depth is stored under. */
export type TaskModelStageKey = string;

export function taskModelStageKey(role: TaskModelRole, stage: string): TaskModelStageKey {
	return `${role}.${stage}`;
}

/** Every declared Run Stage, in the order the entry point lists them. */
export function taskModelStages(): Array<{
	role: TaskModelRole;
	stage: string;
	key: TaskModelStageKey;
	info: TaskModelStageInfo;
}> {
	return TASK_MODEL_ROLES.flatMap((role) =>
		Object.entries(TASK_MODEL_ROLE_INFO[role].stages).map(([stage, info]) => ({
			role,
			stage,
			key: taskModelStageKey(role, stage),
			info,
		})));
}

export interface AudioSettings {
	sttLanguage?: string;
	audioCuesEnabled?: boolean;
	sttVad?: import("../audio/voice-vad.js").VoiceVadConfig;
	[key: string]: unknown;
}

/** Capability defaults the unified model-and-services entry point manages. */
export interface ModelDefaults {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
}

export interface PiSettings extends ModelDefaults {
	audioGeneration?: import("../../shared/audio-generation.js").AudioGenerationConfiguration;
	pendingAudioGeneration?: import("../../shared/audio-generation.js").AudioGenerationConfiguration;
	embedding?: import("../../shared/embedding-configuration.js").EmbeddingConfiguration;
	pendingEmbedding?: import("../../shared/embedding-configuration.js").EmbeddingConfiguration;
	memoryModels?: import("../goals/memory/model-settings.js").MemoryModelSettings;
	pendingMemoryModels?: import("../goals/memory/model-settings.js").MemoryModelSettings;
	speechRecognition?: import("../../shared/speech-configuration.js").SpeechConfiguration;
	pendingSpeechRecognition?: import("../../shared/speech-configuration.js").SpeechConfiguration;
	/**
	 * Providers whose credential the user deleted. Unified settings are the authority, so an
	 * environment variable must not bring a deleted credential back after a restart. Search
	 * credential fields appear here under the `search:` prefix.
	 */
	deletedProviderCredentials?: string[];
	/**
	 * Search credential fields adopted once from an environment variable rather than entered by the
	 * user. Field ids only; the values live in the credential store.
	 */
	importedSearchCredentials?: string[];
	/** External sources the user switched off; they leave the Provider Catalog and are not verified. */
	disabledSources?: string[];
	enabledModels?: string[];
	providerFallbackModels?: string[];
	taskModels?: TaskModelSettings;
	/**
	 * Explicit reasoning depth per Run Stage, keyed `role.stage`. An absent entry inherits the
	 * capability default, so restoring inheritance really does follow later changes.
	 */
	stageThinkingLevels?: Record<TaskModelStageKey, { level: ThinkingLevel }>;
	audio?: AudioSettings;
	memory?: {
		bankId?: string;
	};
	[key: string]: unknown;
}

export function loadSettings(): PiSettings {
	const SETTINGS_PATH = settingsPath();
	if (!existsSync(SETTINGS_PATH)) return {};
	const raw = readFileSync(SETTINGS_PATH, "utf-8");
	if (!raw.trim()) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("settings.json must contain an object");
	}
	return parsed as PiSettings;
}

export function saveSettings(settings: PiSettings): void {
	const SETTINGS_PATH = settingsPath();
	const dir = dirname(SETTINGS_PATH);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileAtomic(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function ensureHindsightBankId(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.HINDSIGHT_BANK_ID?.trim();
	if (explicit) return explicit;
	const settings = loadSettings();
	const stored = settings.memory?.bankId?.trim();
	const bankId = stored || `pi-user-${userInfo().username.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
	if (!stored) {
		settings.memory = { ...settings.memory, bankId };
		saveSettings(settings);
	}
	env.HINDSIGHT_BANK_ID = bankId;
	return bankId;
}
