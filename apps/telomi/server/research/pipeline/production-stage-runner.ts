import { type AgentStageRunner, SrtStageRuntime } from "../../agent-runtime/agent-stage-runtime.js";
import { PrimeNoteAgentStageRunner } from "./prime-note-agent.js";
import { PrimeReportWriterStageRunner } from "./prime-report-writer.js";

export function createProductionResearchStageRunner(
	options: { env?: NodeJS.ProcessEnv } = {},
	delegate: AgentStageRunner = new SrtStageRuntime(),
): AgentStageRunner {
	return new PrimeReportWriterStageRunner(
		new PrimeNoteAgentStageRunner(delegate, options),
		options,
	);
}
