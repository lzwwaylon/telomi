import { TASK_MODEL_ROLES, TASK_MODEL_ROLE_INFO, taskModelStages } from "./settings.js";

/** Settings own startup choices; Runs and Replays still pass explicit pins in their own environments. */
export function clearAmbientTaskModelOverrides(env: NodeJS.ProcessEnv = process.env): void {
	for (const role of TASK_MODEL_ROLES) delete env[TASK_MODEL_ROLE_INFO[role].legacyEnvVar];
	for (const { info } of taskModelStages()) delete env[info.envVar];
}
