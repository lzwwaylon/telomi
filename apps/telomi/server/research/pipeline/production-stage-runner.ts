import { type AgentStageRunner, SrtStageRuntime } from "../../agent-runtime/agent-stage-runtime.js";
import { PrimeCornellNoteStageRunner } from "./prime-cornell-note.js";
import { PrimeReportWriterStageRunner } from "./prime-report-writer.js";

export function createProductionResearchStageRunner(
	options: { env?: NodeJS.ProcessEnv } = {},
	delegate: AgentStageRunner = new SrtStageRuntime(),
): AgentStageRunner {
	return new PrimeReportWriterStageRunner(
		new PrimeCornellNoteStageRunner(delegate, options),
		options,
	);
}
