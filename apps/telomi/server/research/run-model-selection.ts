import { pinTaskModelSelection, modelDefinitionHash, freezeModelDefinitions } from "../agent-runtime/model-policy.js";
/**
 * A Research Run's model selection, frozen at its start.
 *
 * Every later part of a Run resolves its model from the Run's own execution environment:
 * the Cornell Note Stage, the Prime Root, each RLM child, and the followup turns the parent
 * takes after its children go quiescent. Left to itself each of those would re-read the global
 * configuration, so changing a default halfway through would switch models inside a Run whose
 * earlier evidence came from another one, and the Trace would attribute all of it to whatever
 * the settings happen to say when someone reads them.
 *
 * The Run therefore resolves each role once, at the start, and pins the result into its
 * environment under the role's declared variable, which every resolver already prefers. That
 * also keeps an Attestation Replay's explicitly selected models intact: a Replay states its
 * identity through the same variables, and an existing pin is never replaced.
 *
 * Credentials are deliberately not part of this. A Run keeps its models and Providers; the
 * credential used to reach that Provider is resolved per request and follows activation.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	isThinkingLevel,
	resolveLLMConfig,
	resolveStageThinkingLevel,
	type ThinkingLevel,
} from "../agent-runtime/model-config/resolve.js";
import { writeFileAtomic } from "../lib/fs.js";
import { TASK_MODEL_ROLE_INFO, taskModelStages, type PiSettings } from "../config/settings.js";

/** The roles a Research Run freezes. Wiki maintenance is not part of a Run. */
export const RUN_MODEL_ROLES = ["cornellNote", "primeRoot", "primeChild"] as const;
export type RunModelRole = (typeof RUN_MODEL_ROLES)[number];

/**
 * What the Run runs on: `provider/model` per role, and the reasoning depth of each Run Stage.
 * Both are configuration the user manages, so both freeze together - a Run whose depth changed
 * halfway through would be as inconsistent as one whose model did.
 */
export interface RunModelSelection {
	readonly models: Readonly<Record<RunModelRole, string>>;
	/** Keyed `role.stage`, matching the declared Run Stages. */
	readonly stageThinkingLevels: Readonly<Record<string, ThinkingLevel>>;
	readonly modelDefinitionHashes: Readonly<Record<RunModelRole, string>>;
}

/** The Run Stages a Research Run freezes, declared with the roles they belong to. */
function runStages(): ReturnType<typeof taskModelStages> {
	return taskModelStages().filter((entry) =>
		entry.info.runScoped === true);
}

/**
 * Freeze the Run's selections and parameters into `env`.
 *
 * A value already pinned in `env` keeps it: an operator or a Replay stated it for this
 * execution. A role with no configured model fails here, before the Run starts, rather than
 * running on a model nobody chose.
 */
export function pinRunModelSelection(
	env: NodeJS.ProcessEnv,
	settingsOverride?: PiSettings,
): NodeJS.ProcessEnv {
	return pinTaskModelSelection(RUN_MODEL_ROLES, env, settingsOverride);
}

/** Reuse persisted selections when resuming the same Run, independent of global edits. */
export function freezeRunModelSelection(env: NodeJS.ProcessEnv, controlDirectory: string): NodeJS.ProcessEnv {
	const path = join(controlDirectory, "model-selection.json");
	let pinned: NodeJS.ProcessEnv;
	if (existsSync(path)) {
		const saved = JSON.parse(readFileSync(path, "utf-8")) as RunModelSelection;
		pinned = { ...env };
		for (const role of RUN_MODEL_ROLES) {
			const model = saved.models?.[role];
			if (typeof model !== "string" || !/^[^/]+\/.+$/u.test(model)) {
				throw new Error("Invalid persisted Run model selection");
			}
			pinned[TASK_MODEL_ROLE_INFO[role].legacyEnvVar] = model;
		}
		for (const { key, info } of runStages()) {
			const level = saved.stageThinkingLevels?.[key];
			if (!isThinkingLevel(level)) throw new Error("Invalid persisted Run thinking level");
			pinned[info.envVar] = level;
		}
	} else {
		pinned = pinRunModelSelection(env);
		mkdirSync(controlDirectory, { recursive: true });
		writeFileAtomic(path, `${JSON.stringify(runModelSelection(pinned), null, 2)}\n`);
	}
	return freezeModelDefinitions(pinned, controlDirectory);
}

export function runModelSelection(
	env: NodeJS.ProcessEnv,
	settingsOverride?: PiSettings,
): RunModelSelection {
	return {
		modelDefinitionHashes: Object.fromEntries(RUN_MODEL_ROLES.map((role) => [
			role, modelDefinitionHash(resolveRunModel(role, env, settingsOverride), env),
		])) as Record<RunModelRole, string>,
		models: Object.fromEntries(RUN_MODEL_ROLES.map((role) => [
			role,
			resolveRunModel(role, env, settingsOverride),
		])) as Record<RunModelRole, string>,
		stageThinkingLevels: Object.fromEntries(runStages().map(({ role, stage, key }) => [
			key,
			resolveStageThinkingLevel(role, stage, env, settingsOverride).thinkingLevel,
		])),
	};
}

function resolveRunModel(
	role: RunModelRole,
	env: NodeJS.ProcessEnv,
	settingsOverride?: PiSettings,
): string {
	const resolved = resolveLLMConfig({
		envVarName: TASK_MODEL_ROLE_INFO[role].legacyEnvVar,
		taskModelRole: role,
		envOverride: env,
		...(settingsOverride ? { settingsOverride } : {}),
	}).model;
	const slash = resolved?.indexOf("/") ?? -1;
	if (!resolved || slash <= 0 || slash === resolved.length - 1) {
		throw new Error(
			`${TASK_MODEL_ROLE_INFO[role].label} requires a configured provider/model: `
			+ "select a default model, or an override for this role, under 模型与服务",
		);
	}
	return resolved;
}

/** Runs executing right now, so the settings entry point can report what has not adopted a change. */
const activeRunSelections = new Set<RunModelSelection>();

/**
 * Register an executing Run's frozen selection. The returned function releases it, and must run
 * however the Run ends: a Run reported as still executing on an old model forever would make the
 * entry point's activation status useless.
 */
export function trackRunModelSelection(selection: RunModelSelection): () => void {
	activeRunSelections.add(selection);
	return () => activeRunSelections.delete(selection);
}

/** The selections Runs are executing on right now. */
export function activeRunModelSelections(): RunModelSelection[] {
	return [...activeRunSelections];
}
