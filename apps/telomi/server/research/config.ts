import {
	resolveLLMConfig,
	resolveStageThinkingLevel,
} from "../agent-runtime/model-config/resolve.js";
import { TASK_MODEL_ROLE_INFO, type PiSettings } from "../config/settings.js";
import type { ResearchRuntimeConfig } from "./research-types.js";
import type { ResolvedOutputLanguage } from "../../shared/languages.js";

/** Everything a Research Run needs beyond its model selection, which is always configured. */
export const DEFAULT_RESEARCH_CONFIG: Omit<ResearchRuntimeConfig, "cornellNoteModel" | "cornellNoteThinkingLevel"> = {
	outputLanguage: "en",
	documentConcurrency: 4,
};

export function researchConfigFromEnv(
	env: NodeJS.ProcessEnv,
	settingsOverride?: PiSettings,
): ResearchRuntimeConfig {
	const base = { ...DEFAULT_RESEARCH_CONFIG };
	const cornellNoteModel = resolveLLMConfig({
		envVarName: TASK_MODEL_ROLE_INFO.cornellNote.legacyEnvVar,
		taskModelRole: "cornellNote",
		envOverride: env,
		...(settingsOverride ? { settingsOverride } : {}),
	}).model;
	if (!cornellNoteModel?.includes("/")) {
		throw new Error("Cornell Note requires a configured provider/model");
	}
	const outputLanguage = (): ResolvedOutputLanguage => {
		const explicit = env.TELOMI_RESEARCH_OUTPUT_LANGUAGE?.trim();
		if (explicit === "en" || explicit === "zh-CN") return explicit;
		if (explicit) throw new Error("TELOMI_RESEARCH_OUTPUT_LANGUAGE must be 'en' or 'zh-CN'");
		return base.outputLanguage;
	};
	const integer = (name: string, fallback: number, min: number, max: number) => {
		if (env[name] === undefined || env[name]?.trim() === "") return fallback;
		const value = Number(env[name]);
		if (!Number.isInteger(value) || value < min || value > max) {
			throw new Error(`${name} must be an integer from ${min} to ${max}`);
		}
		return value;
	};
	return {
		...base,
		outputLanguage: outputLanguage(),
		cornellNoteModel,
		cornellNoteThinkingLevel: resolveStageThinkingLevel("cornellNote", "evidenceNote", env, settingsOverride).thinkingLevel,
		documentConcurrency: integer("TELOMI_RESEARCH_DOCUMENT_CONCURRENCY", base.documentConcurrency, 1, 32),
	};
}
