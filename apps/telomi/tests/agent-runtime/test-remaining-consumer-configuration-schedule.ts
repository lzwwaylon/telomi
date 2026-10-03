/** Configuration API to the Schedule reviewer through native Prime transport, using only local HTTP. */
import { startConsumerConfiguration } from "./fixtures/consumer-configuration.js";

const harness = await startConsumerConfiguration();
const { root, env, signal, apply, configure, stopped } = harness;
const { runPrimeScheduleReviewer } = await import("../../server/research/schedules/reviewer.js");
try {
	await apply("second", "high");
	await configure({ stageThinkingLevels: { "primeRoot.scheduleReview": "low" } });
	await stopped(() => runPrimeScheduleReviewer({ language: "en", goalId: "test", workspaceDir: root, reviewId: "review", root: `${root}/review`,
		schedule: { id: "schedule", question: "Question", monitoringScope: "Scope", reportContext: "Context", runs: [] },
		previousReview: null, answerTool: async () => ({}), signal, env }), "second", "low");
	console.log("Schedule reviewer adopts API task models and stage depth, and reaches native local transport");
} finally {
	await harness.close();
}
