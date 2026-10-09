import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isOutputLanguage } from "../../shared/languages.js";
import { renderMainAgentPrompt, type MainAgentPromptContext } from "../main-agent/system-prompts.js";
import type { NodeEvaluationCase } from "../agent-runtime/node-evaluation.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { isRecord } from "../lib/values.js";
import { liveInvestigationPrompts } from "./investigation-live-contract.js";
import { buildNoteReadingTaskPrompt } from "../research/note-reading.js";
import { renderNoteAgentSystemPrompt, renderNoteAgentUserPrompt } from "../research/pipeline/note-agent-prompt.js";
import { buildWikiReportWriterSystemPrompt, buildNotesReportWriterSystemPrompt,
	notesSelfDirectedWriterUserPrompt, wikiSelfDirectedWriterUserPrompt } from "../research/pipeline/report-prompts.js";

type CandidatePromptInput = Pick<NodeEvaluationCase, "agentId" | "recipeInput" | "mounts"> & {
	request: { promptConfig: Pick<NodeEvaluationCase["request"]["promptConfig"], "userVariant"> };
};

/** Re-render business Prompts from frozen structured inputs, never from rendered Prompt text. */
export function renderCapturedCandidatePrompts(value: CandidatePromptInput, sourceRunDirectory: string): {
	systemPrompt: string; userPrompt: string;
} {
	if (value.agentId === "prime-investigation") {
		if (isRecord(value.recipeInput) && value.recipeInput.mode === "live-investigation") return liveInvestigationPrompts();
		const prompt = renderAgentPrompt("research", "prime-search", "user", {
			run_input_json: JSON.stringify({ request_ref: "inputs/request.json" }),
		}, "investigate").content;
		return { systemPrompt: "", userPrompt: `${prompt}\n\n## Frozen coordination Replay\n\n`
			+ "This execution checks coordination and file handoffs against captured Tool results. It does not run a new search plan or a new Writer. Read inputs/replay-plan.json before invoking any investigation operation. The ordered steps contain the captured business assignments using this invocation's mapped evidence refs. Execute those operations in order, using the listed arguments. In particular, copy each write_answer evidence_refs and requirements exactly from its step; do not derive, paraphrase or guess replacement requirements. Their frozen Writer result belongs only to that exact assignment. Read the request and restored state normally, inspect relevant evidence and the returned Writer coverage, then deliver the latest Writer receipt through the usual output contract. Additional acquisition, reading or Writer assignments are outside this frozen Replay. If a planned step cannot run, report the specific contract failure rather than retrying guessed argument combinations." };
	}
	const context = isRecord(value.recipeInput) ? value.recipeInput : {};
	if (value.agentId === "main-agent") {
		const promptContext = capturedMainAgentPromptContext(context.promptContext);
		if (typeof context.question !== "string") throw new Error("Candidate Main Agent Prompt requires its frozen question; use observed or override for older Cases");
		return { systemPrompt: renderMainAgentPrompt(promptContext), userPrompt: context.question };
	}
	if (value.agentId === "note-agent") {
		if (context.mode === "question-reading") {
			const catalog = readInput(value, sourceRunDirectory, "/source", "catalog.json");
			if (typeof context.question !== "string" || !context.question.trim() || !Array.isArray(catalog.sources)) {
				throw new Error("Candidate Note Reading Prompt requires its frozen question and Source catalog");
			}
			return { systemPrompt: renderNoteAgentSystemPrompt(undefined, "question-reading").content,
				userPrompt: buildNoteReadingTaskPrompt(context.question, catalog.sources.length) };
		}
		if (typeof context.question !== "string" || !isRecord(context.goal)
			|| typeof context.goal.title !== "string" || typeof context.goal.description !== "string"
			|| typeof context.discoveryEnabled !== "boolean") {
			throw new Error("Candidate Note Agent Prompt requires its frozen request context; use observed or override for older Cases");
		}
		return { systemPrompt: renderNoteAgentSystemPrompt().content,
			userPrompt: renderNoteAgentUserPrompt(context as unknown as Parameters<typeof renderNoteAgentUserPrompt>[0]).content };
	}
	if (value.agentId === "report-writer") {
		if (context.mode === "investigation-answer") {
			if (value.request.promptConfig.userVariant !== "answer") throw new Error("Candidate Answer Prompt requires its frozen answer variant");
			return { systemPrompt: renderAgentPrompt("research", "report-writer", "system-append", {}, "answer").content,
				userPrompt: renderAgentPrompt("research", "report-writer", "user", {}, "answer").content };
		}
		const request = readInput(value, sourceRunDirectory, "/inputs", "request.json");
		const temporal = request.temporal_context;
		if (typeof request.language !== "string" || !request.language.trim() || !isRecord(temporal)
			|| typeof temporal.currentDate !== "string" || !temporal.currentDate.trim()
			|| typeof temporal.timeZone !== "string" || !temporal.timeZone.trim()) {
			throw new Error("Candidate Report Writer Prompt requires frozen language and temporal_context; use observed or override for older Cases");
		}
		const materials = readInput(value, sourceRunDirectory, "/inputs", "materials.json");
		if (materials.kind !== "wiki" && materials.kind !== "notes") throw new Error("Candidate Report Writer Prompt requires a frozen knowledge mode");
		const priorPath = join(inputRoot(value, sourceRunDirectory, "/inputs"), "prior-reports", "index.md");
		const variables = { language: request.language, currentDate: temporal.currentDate, timeZone: temporal.timeZone,
			priorReports: existsSync(priorPath) ? readFileSync(priorPath, "utf-8") : "" };
		return materials.kind === "notes"
			? { systemPrompt: buildNotesReportWriterSystemPrompt(), userPrompt: notesSelfDirectedWriterUserPrompt(variables) }
			: { systemPrompt: buildWikiReportWriterSystemPrompt(), userPrompt: wikiSelfDirectedWriterUserPrompt(variables) };
	}
	throw new Error(`Agent '${value.agentId}' does not use captured Candidate Prompt rendering`);
}

function inputRoot(value: CandidatePromptInput, sourceRunDirectory: string, guestPath: string): string {
	const mount = value.mounts.find((item) => item.kind === "run" && item.guestPath === guestPath);
	if (!mount || mount.kind !== "run") throw new Error(`Candidate Prompt requires frozen '${guestPath}' inputs`);
	// readNodeEvaluationCase verifies this directory and every contained byte before rendering.
	return join(sourceRunDirectory, mount.directory.ref);
}

function readInput(value: CandidatePromptInput, sourceRunDirectory: string, guestPath: string, file: string): Record<string, unknown> {
	const path = join(inputRoot(value, sourceRunDirectory, guestPath), file);
	if (!existsSync(path)) throw new Error(`Candidate Prompt requires frozen '${guestPath}/${file}'; use observed or override for older Cases`);
	const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (!isRecord(data)) throw new Error(`Candidate Prompt input '${file}' must be an object`);
	return data;
}

export function capturedMainAgentPromptContext(value: unknown): MainAgentPromptContext {
	if (!isRecord(value) || typeof value.title !== "string" || typeof value.description !== "string"
		|| !isOutputLanguage(value.outputLanguage) || typeof value.topicReady !== "boolean"
		|| typeof value.topicActive !== "boolean" || !Array.isArray(value.previousSearches)
		|| (value.globalPreferences !== null && typeof value.globalPreferences !== "string")) {
		throw new Error("Candidate Main Agent Prompt requires frozen structured Goal, language, Topic readiness, research history and preference context; use observed or override for older Cases");
	}
	return value as unknown as MainAgentPromptContext;
}
