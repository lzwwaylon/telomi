/**
 * **Unified LLM configuration resolver** for all *background* LLM tasks.
 *
 * 背景：telomi 历史上后台 LLM 任务会用
 * 自己专属的 `TELOMI_*_MODEL` 环境变量决定 model，跟前端 SettingsPage 写到
 * 项目 Agent 目录 `settings.json` 的 `defaultProvider/defaultModel/
 * defaultThinkingLevel/providerFallbackModels` 完全脱钩。结果：
 *
 *   1. 用户在前端把 thinking 改成 `high`，后台 pi CLI 子进程 *看不到*；
 *   2. 用户在前端切了 model，后台仍跑老 model；
 *   3. 6 个 env var 名字各不相同，运维要查每个调用方源码才能搞清楚谁用哪个。
 *
 * 这个模块只做一件事：给定一个调用方的 *标识*（envVarName + 可选硬兜底），
 * 返回一份"现在该用什么 LLM"的解析结果。**不**实际启动 LLM、**不**做 fallback
 * 调度由 SRT Stage Runtime 负责。
 *
 * **优先级**：env var > taskModels 角色覆盖 > 全局默认 > missing。没有任何配置时结果是
 * `missing`：调用方显式失败并告诉用户去设置默认模型，不悄悄换一个没人选过的内置 model。
 *
 * env var 现在只承担一件事：**本次执行显式钉住的 model**。Run 启动时把解析结果写进自己的
 * 执行环境，后续阶段和后代因此拿到同一个选择；Attestation Replay 用同一个变量声明它的
 * model identity。环境里残留的旧值不再参与：启动时一次性导入统一设置后就被清掉。
 *
 * Main Agent（前端对话）走 `resolveMainAgentModel`：同一份全局默认，继承与显式
 * 覆盖的差别由调用方传入的 override 表达，不再由会话记录或 env 决定。产品不内置任何
 * 模型名：Provider 会下线模型，写死的名字迟早让对话和连接测试一起失效。
 *
 * **不服务的场景**：
 *   - agent-runtime/model-connectivity 探针 —— 它的 model 是 UI 显式选的，本来就不依赖默认配置。
 */

import {
	TASK_MODEL_ROLE_INFO,
	loadSettings,
	taskModelStageKey,
	type PiSettings,
	type TaskModelRole,
} from "../../config/settings.js";

/** The thinking levels the product accepts anywhere: settings, API validation and Agent state. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(s: unknown): s is ThinkingLevel {
	return typeof s === "string" && (THINKING_LEVELS as readonly string[]).includes(s);
}

export interface ResolveLLMConfigInput {
	/**
	 * 调用方专属 env var 名（如 `TELOMI_RESEARCH_CORNELL_NOTE_MODEL`）。设了就优先。
	 * 值的格式：`provider/model` 或纯 `model`（后者会与 settings.defaultProvider
	 * 拼接补全）。例：`provider/model-id` 或 `model-id`。
	 */
	readonly envVarName?: string;
	/** 可选任务角色覆盖，读取 settings.json 的 taskModels[taskModelRole]。 */
	readonly taskModelRole?: TaskModelRole;
	/**
	 * 注入 settings (测试用)。默认走 `loadSettings()`。
	 */
	readonly settingsOverride?: PiSettings;
	/**
	 * 注入 env (测试用)。默认 `process.env`。
	 */
	readonly envOverride?: NodeJS.ProcessEnv;
}

export interface ResolvedLLM {
	/** `provider/model` 字符串。null 表示没任何配置；调用方据此显式失败。 */
	readonly model: string | null;
	/** 来自 settings.defaultThinkingLevel。undefined 表示不传 `--thinking`，pi CLI 走默认。 */
	readonly thinkingLevel?: ThinkingLevel;
	/**
	 * `providerFallbackModels`：交给 SRT Stage Runtime 的 Provider fallback 链。
	 */
	readonly fallbackChain: ReadonlyArray<string>;
	/** 来源标记，用于日志/排错 —— 让运维一眼看出"现在为什么是这个 model"。 */
	readonly source: "env" | "taskSettings" | "settings" | "missing";
}

/**
 * 解析一次 LLM 配置。同步、无副作用（只读 settings.json + env）。
 *
 * 调用方典型用法：
 *
 *   const llm = resolveLLMConfig({
 *     envVarName: "TELOMI_RESEARCH_CORNELL_NOTE_MODEL",
 *     taskModelRole: "cornellNote",
 *   });
 *   // Use llm.model, llm.fallbackChain and llm.thinkingLevel in the Stage model policy.
 */
export function resolveLLMConfig(opts: ResolveLLMConfigInput = {}): ResolvedLLM {
	const env = opts.envOverride ?? process.env;
	const settings = opts.settingsOverride ?? loadSettings();

	// 1) env var 优先
	if (opts.envVarName) {
		const raw = env[opts.envVarName];
		if (typeof raw === "string" && raw.trim().length > 0) {
			const model = normalizeModel(raw.trim(), settings);
			return {
				model,
				thinkingLevel: resolveThinkingLevel(settings),
				fallbackChain: resolveFallbackChain(settings),
				source: "env",
			};
		}
	}

	// 2) settings.json 的任务角色覆盖
	const taskModel = opts.taskModelRole
		? settings.taskModels?.[opts.taskModelRole]?.trim()
		: "";
	if (taskModel) {
		return {
			model: normalizeModel(taskModel, settings),
			thinkingLevel: resolveThinkingLevel(settings),
			fallbackChain: resolveFallbackChain(settings),
			source: "taskSettings",
		};
	}

	// 3) settings.json 的 defaultProvider/defaultModel
	const sp = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
	const sm = typeof settings.defaultModel === "string" ? settings.defaultModel.trim() : "";
	if (sp && sm) {
		return {
			model: `${sp}/${sm}`,
			thinkingLevel: resolveThinkingLevel(settings),
			fallbackChain: resolveFallbackChain(settings),
			source: "settings",
		};
	}

	// 4) 啥都没有
	return {
		model: null,
		thinkingLevel: resolveThinkingLevel(settings),
		fallbackChain: resolveFallbackChain(settings),
		source: "missing",
	};
}

/** A Run Stage's reasoning depth, and why it is that value. */
export interface EffectiveStageThinkingLevel {
	readonly thinkingLevel: ThinkingLevel;
	/** `pinned` = frozen for this execution; `override` = the user chose it for this Stage. */
	readonly source: "pinned" | "override" | "settings" | "unset";
}

/**
 * A Run Stage's reasoning depth, resolved the same way its model is.
 *
 * The Stage follows the activated capability default unless the user chose a depth for it, so
 * changing the default reaches every Stage that inherits. An execution that pinned the depth -
 * a Run freezing its parameters at the start, an Attestation Replay stating them - keeps that
 * value. With nothing configured anywhere the Stage reasons at `off` rather than at a depth
 * nobody selected.
 */
export function resolveStageThinkingLevel(
	role: TaskModelRole,
	stage: string,
	env: NodeJS.ProcessEnv = process.env,
	settingsOverride?: PiSettings,
): EffectiveStageThinkingLevel {
	const info = (TASK_MODEL_ROLE_INFO[role].stages as Record<string, { envVar: string } | undefined>)[stage];
	if (!info) throw new Error(`Unknown Run Stage '${role}.${stage}'`);
	const pinned = env[info.envVar]?.trim();
	if (isThinkingLevel(pinned)) return { thinkingLevel: pinned, source: "pinned" };
	const settings = settingsOverride ?? loadSettings();
	const explicit = settings.stageThinkingLevels?.[taskModelStageKey(role, stage)]?.level;
	if (isThinkingLevel(explicit)) return { thinkingLevel: explicit, source: "override" };
	const inherited = resolveThinkingLevel(settings);
	return inherited
		? { thinkingLevel: inherited, source: "settings" }
		: { thinkingLevel: NO_THINKING_LEVEL, source: "unset" };
}

/** 什么都没配置时的推理深度：明确的"不思考"，而不是某个没人选过的深度。 */
const NO_THINKING_LEVEL: ThinkingLevel = "off";

/**
 * 没有全局默认也没有覆盖时 Main Agent 的思考深度。这里必须是一个具体值：返回
 * "不指定" 会让已经加载的 Runner 停在上一次的深度上，恢复继承就不再是恢复。
 */
export const MAIN_AGENT_FALLBACK_THINKING_LEVEL: ThinkingLevel = "off";

/** 一个消费者当前实际使用的选择，以及它为什么是这个值。 */
export interface EffectiveModelSelection {
	/** `provider/model`；`null` 表示用户还没选全局默认，消费者不能开始。 */
	readonly model: string | null;
	/** 始终是具体值，消费者据此把状态重置到当前权威配置。 */
	readonly thinkingLevel: ThinkingLevel;
	/** `override` = 用户为这个消费者显式选择；`settings` = 继承全局默认；`missing` = 两者都没有。 */
	readonly source: "override" | "settings" | "missing";
}

/** 一个消费者的显式覆盖；`null`/`undefined` 表示继承全局默认。 */
export interface ConsumerModelOverride {
	readonly model?: string | null;
	readonly thinkingLevel?: string | null;
}

/**
 * Main Agent（前端对话）在执行边界上的有效配置。
 *
 * 继承全局默认，显式覆盖优先，两者都缺时 `model` 为 null：调用方在用户看得见的地方失败。
 * 会话记录和环境变量都不参与，这样"恢复继承"之后的下一轮真的会跟随新的全局默认。
 */
export function resolveMainAgentModel(
	override: ConsumerModelOverride = {},
	settingsOverride?: PiSettings,
): EffectiveModelSelection {
	const settings = settingsOverride ?? loadSettings();
	const thinkingLevel = isThinkingLevel(override.thinkingLevel)
		? override.thinkingLevel
		: resolveThinkingLevel(settings) ?? MAIN_AGENT_FALLBACK_THINKING_LEVEL;
	const explicit = typeof override.model === "string" ? override.model.trim() : "";
	if (explicit) {
		return { model: normalizeModel(explicit, settings), thinkingLevel, source: "override" };
	}
	const inherited = resolveLLMConfig({ settingsOverride: settings });
	return {
		model: inherited.model,
		thinkingLevel,
		source: inherited.model ? "settings" : "missing",
	};
}

/**
 * 如果 raw 已经是 `provider/model` 形态原样返回；否则与 settings.defaultProvider
 * 拼接（缺 provider 时退化为返回纯 model，由 pi CLI 自己用默认 provider）。
 */
function normalizeModel(raw: string, settings: PiSettings): string {
	if (raw.includes("/")) return raw;
	const sp = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
	return sp ? `${sp}/${raw}` : raw;
}

function resolveThinkingLevel(settings: PiSettings): ThinkingLevel | undefined {
	const v = settings.defaultThinkingLevel;
	return isThinkingLevel(v) ? v : undefined;
}

function resolveFallbackChain(settings: PiSettings): ReadonlyArray<string> {
	const arr = settings.providerFallbackModels;
	if (!Array.isArray(arr)) return [];
	return arr.filter((s): s is string => typeof s === "string" && s.includes("/"));
}
