import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordedStageReplayPreparation } from "../../agent-runtime/recorded-stage-replay.js";
import { renderAgentPrompt } from "../../agent-runtime/prompt-registry.js";
import { writeJsonAtomic } from "../../lib/fs.js";
import { isRecord } from "../../lib/values.js";
import { readQuestionReaderConfiguration } from "./reader-configuration.js";
import { renderNoteAgentSystemPrompt, renderPiReaderChildPrompt, renderPiReaderSystemPrompt } from "./note-agent-prompt.js";

/** Research owns Reader profiles; historical unsupported runtimes fail before model execution. */
export const prepareNoteReaderReplay: RecordedStageReplayPreparation = ({ value, promptMode, promptOverride, recordDirectory, readonlyMounts }) => {
	const context = value.recipeInput;
	if (value.agentId !== "note-agent") return;
	if (!isRecord(context) || context.mode !== "question-reading") {
		if (promptMode !== "candidate") {
			if (value.request.executionProfile === "pi_builtin" || value.request.promptConfig.systemVariant === "source-reading-pi") {
				throw new Error("Historical Source Pi Reader is not supported in observed or override Replay; use candidate Replay for the current Prime Source Reader");
			}
			return;
		}
		const system = renderNoteAgentSystemPrompt();
		return { systemPrompt: system.content, executionProfile: "prime_ipython", promptConfig: {
			systemVariant: "default", userVariant: "prime-execution", revisions: { ...value.request.promptConfig.revisions, system: system.revision },
		} };
	}
	if (promptMode !== "candidate") {
		if (value.request.executionProfile === "pi_builtin") {
			const inputs = readonlyMounts.find(item => item.guestPath === "/inputs")?.hostPath;
			if (value.request.promptConfig?.systemVariant !== "question-reading-pi" || !inputs
				|| ["reader-child-system.md", "reader-child-prompt.md"].some(name => !existsSync(join(inputs, name)))) {
				throw new Error("Observed Pi Question Reader requires frozen child Prompts in a supported profile; use candidate Replay");
			}
		}
		return;
	}
	const mount = readonlyMounts.find(item => item.guestPath === "/inputs");
	const configuration = readQuestionReaderConfiguration(mount?.hostPath,
		typeof context.question === "string" ? context.question : undefined, process.env,
		readonlyMounts.find(item => item.guestPath === "/source")?.hostPath);
	const systemPrompt = renderPiReaderSystemPrompt(configuration.childModel);
	if (promptOverride?.systemPrompt !== undefined && promptOverride.systemPrompt !== systemPrompt) {
		throw new Error("Candidate Question Reader configuration changed after its Prompt Bundle was frozen");
	}
	const configurationSource = mount && existsSync(join(mount.hostPath, "reader-config.json")) ? "captured" : "candidate-settings";
	const inputs = join(recordDirectory, "reader-inputs");
	mkdirSync(inputs, { recursive: true });
	if (mount) cpSync(mount.hostPath, inputs, { recursive: true });
	else writeFileSync(join(inputs, "context.md"), "");
	writeJsonAtomic(join(inputs, "reader-config.json"), configuration);
	writeFileSync(join(inputs, "reader-child-system.md"), renderNoteAgentSystemPrompt(undefined, "question-reading-pi").content);
	writeFileSync(join(inputs, "reader-child-prompt.md"), renderPiReaderChildPrompt(configuration.language));
	if (mount) mount.hostPath = inputs;
	else readonlyMounts.push({ hostPath: inputs, guestPath: "/inputs", access: "read-only" });
	writeJsonAtomic(join(recordDirectory, "reader-config-origin.json"), { source: configurationSource, ...configuration });
	return { systemPrompt, executionProfile: "pi_builtin", promptConfig: {
		systemVariant: "question-reading-pi", userVariant: "question-reading", revisions: { ...value.request.promptConfig.revisions,
			system: renderAgentPrompt("research", "note-agent", "system-append", {}, "question-reading-pi").revision },
	}, recipeInput: { ...context, readerConfigurationSource: configurationSource } };
};
