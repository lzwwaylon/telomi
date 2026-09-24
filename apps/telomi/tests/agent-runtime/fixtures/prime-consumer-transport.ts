import { join } from "node:path";
/** Native transport against test-owned local HTTP endpoints, without a Python kernel. */
import { writeFileSync } from "node:fs";
import * as prime from "prime-agent";
export * from "prime-agent";

export async function createAgentSession(options: NonNullable<Parameters<typeof prime.createAgentSession>[0]>) {
	writeFileSync(join(options.cwd!, "consumer-selection.json"), `${JSON.stringify({
		model: options.model?.id,
		thinking: options.thinkingLevel,
		scoped: options.scopedModels?.map((entry) => ({ model: entry.model.id, thinking: entry.thinkingLevel })),
	})}\n`);
	const settingsManager = options.settingsManager ?? prime.SettingsManager.create(options.cwd!, options.agentDir);
	// Keep native retry counts and credential refresh, without seconds of fixture backoff.
	settingsManager.applyOverrides({ retry: { baseDelayMs: 1 } });
	return prime.createAgentSession({ ...options, settingsManager, tools: [], noTools: "all", prewarmIpythonKernel: false });
}
