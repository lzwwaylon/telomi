import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/fs.js";
import { PRIME_MODEL_DEFINITIONS_ENV, primeModelDefinitions } from "./prime-agent-paths.js";
import { sha256 } from "../lib/hash.js";
import { isRecord } from "../lib/values.js";
import { resolveLLMConfig, resolveStageThinkingLevel } from "./model-config/resolve.js";
import {
	TASK_MODEL_ROLE_INFO,
	loadSettings,
	taskModelStages,
	type PiSettings,
	type TaskModelRole,
} from "../config/settings.js";

export interface PrimeAgentModel {
	provider: string;
	modelId: string;
	selector: string;
}

export function resolvePrimeAgentModels(
	env: NodeJS.ProcessEnv = process.env,
	settingsOverride?: PiSettings,
): { root: PrimeAgentModel; child: PrimeAgentModel } {
	return {
		root: resolvePrimeModel("primeRoot", env, settingsOverride),
		child: resolvePrimeModel("primeChild", env, settingsOverride),
	};
}

export function resolvePrimeModel(
	role: TaskModelRole,
	env: NodeJS.ProcessEnv,
	settingsOverride?: PiSettings,
): PrimeAgentModel {
	const selector = resolveLLMConfig({
		envVarName: TASK_MODEL_ROLE_INFO[role].legacyEnvVar,
		taskModelRole: role,
		envOverride: env,
		...(settingsOverride ? { settingsOverride } : {}),
	}).model;
	const slash = selector?.indexOf("/") ?? -1;
	if (!selector || slash <= 0 || slash === selector.length - 1) {
		throw new Error(`${TASK_MODEL_ROLE_INFO[role].label} requires a configured provider/model`);
	}
	return {
		provider: selector.slice(0, slash),
		modelId: selector.slice(slash + 1),
		selector,
	};
}

/** Resolve once before an independent operation, preserving explicit Run/Replay pins. */
export function pinTaskModelSelection(
	roles: readonly TaskModelRole[],
	env: NodeJS.ProcessEnv = process.env,
	settings: PiSettings = loadSettings(),
): NodeJS.ProcessEnv {
	const pinned = { ...env };
	for (const role of roles) {
		pinned[TASK_MODEL_ROLE_INFO[role].legacyEnvVar] = resolvePrimeModel(role, env, settings).selector;
	}
	for (const { role, stage, info } of taskModelStages()) {
		if (roles.includes(role)) pinned[info.envVar] = resolveStageThinkingLevel(role, stage, env, settings).thinkingLevel;
	}
	return pinned;
}

/** Independent Activities still using their starting configuration. No credentials are retained. */
const activeTaskSelections = new Set<Array<{ role: TaskModelRole; model: string; definitionHash: string; stages: Record<string, string> }>>();

export function trackTaskModelSelection(roles: readonly TaskModelRole[], env: NodeJS.ProcessEnv, stageKeys: readonly string[]): () => void {
	const selection = roles.map((role) => {
		const model = resolvePrimeModel(role, env).selector;
		return {
			role,
			model,
			definitionHash: modelDefinitionHash(model, env),
			stages: Object.fromEntries(taskModelStages().filter((entry) => stageKeys.includes(entry.key) && (role === "primeChild" || entry.role === role)).map(({ key, info }) => [key, env[info.envVar] ?? "off"])),
		};
	});
	activeTaskSelections.add(selection);
	return () => { activeTaskSelections.delete(selection); };
}

export function pendingTaskModelSelections(role: TaskModelRole, model: string, stages: Array<{ key: string; thinkingLevel: string }>, definitionHash: string): number {
	return [...activeTaskSelections].filter((selection) => selection.some((entry) => entry.role === role
		&& (entry.model !== model || entry.definitionHash !== definitionHash || stages.some((stage) => stage.key in entry.stages && entry.stages[stage.key] !== stage.thinkingLevel)))).length;
}

/** Stable identity of the selected model and its connection, excluding credentials. */
export function modelDefinitionHash(selector: string, env: NodeJS.ProcessEnv = process.env): string {
	const definitions = primeModelDefinitions(env);
	const [provider, ...parts] = selector.split("/");
	const modelId = parts.join("/");
	const entry = isRecord(definitions) && isRecord(definitions.providers) ? definitions.providers[provider!] : undefined;
	if (!isRecord(entry)) return sha256("{}");
	const { models, modelOverrides, ...connection } = entry;
	return sha256(JSON.stringify({
		...connection,
		model: Array.isArray(models) ? models.find((model) => isRecord(model) && model.id === modelId) : undefined,
		override: isRecord(modelOverrides) ? modelOverrides[modelId] : undefined,
	}));
}

/**
 * Freeze the connections an execution resolves its models through, alongside the models themselves.
 *
 * A model reference names a Provider; it does not say which endpoint that Provider is. Without
 * this, a later Stage would rebuild the Provider definitions from the canonical file and could
 * reach a different service under the same name than the Stages before it. The frozen copy
 * carries definitions only: credentials stay live and are resolved per request, so nothing
 * secret is written where an execution's artifacts are collected.
 */
export function freezeModelDefinitions(
	env: NodeJS.ProcessEnv,
	controlDirectory: string,
): NodeJS.ProcessEnv {
	if (env[PRIME_MODEL_DEFINITIONS_ENV]?.trim()) return env;
	const path = join(controlDirectory, "model-definitions.json");
	mkdirSync(controlDirectory, { recursive: true });
	if (!existsSync(path)) {
		writeFileAtomic(path, `${JSON.stringify(primeModelDefinitions(env), null, 2)}\n`);
	}
	return { ...env, [PRIME_MODEL_DEFINITIONS_ENV]: path };
}
