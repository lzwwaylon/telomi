import { validateInvestigationResult, type InvestigationResult } from "../citations/contracts.js";
import { appendFileSync, cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOutputLanguage, type OutputLanguage } from "../../shared/languages.js";
import type { AgentStageActivity } from "../agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { resolvePrimeModel, pinTaskModelSelection } from "../agent-runtime/model-policy.js";
import { resolveStageThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { primeAgentModulePath } from "../agent-runtime/prime-agent-paths.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { materializeSkills, snapshotSkills } from "../agent-runtime/skill-registry.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { sha256 } from "../lib/hash.js";
import { isRecord, toErrorMessage } from "../lib/values.js";
import { publish } from "../events/event-bus.js";
import { appendNodeExecutionRecord, appendRuntimeContext } from "../observability/run-records.js";
import { serverRuntimeDirForGoalDir } from "../workspaces/server-runtime-paths.js";
import { caseCapture } from "../observability/case-capture.js";
import { snapshotWikiEdition as snapshotInvestigationKnowledge } from "../wiki/editions.js";
export { snapshotWikiEdition as snapshotInvestigationKnowledge } from "../wiki/editions.js";
import { createGoalLlmWikiTools } from "../wiki/tools.js";
import { createWikiReferenceAdapterFromRoot } from "./pipeline/wiki-report-references.js";
import { runPrime, startPrimeSourceBridge } from "./pipeline/prime-search-batch.js";
import { ResearchSourceRegistry } from "./sources/registry.js";
import { executeNoteReading, listSavedNoteReadingCues } from "./note-reading.js";
import { listSavedNoteCues, rankSavedNoteCues } from "./note-retrieval.js";
import { resolveSavedNoteCue } from "./note-retrieval.js";
import { resolveNoteReadingCue } from "./note-reading.js";
import { readExternalSources } from "./external-search.js";
import { createInvestigationCitationScope, type InvestigationCitationCue } from "./investigation-citations.js";
import { executeInvestigationAnswer, writeInvestigationAnswerInput, type InvestigationAnswer,
	type InvestigationAnswerEvidence } from "./investigation-answer.js";
import { readLatestInvestigationWriter } from "./investigation-handoff.js";
import { writeTaskContext } from "./task-context.js";
import { runInInvestigationThread, writeInvestigationThreadInput, validateInvestigationProgress } from "./investigation-threads.js";


/** Resolve a completed investigation for Main's explicit delivery decision. */
export function readInvestigationResult(goalDir: string, id: string): InvestigationResult {
	if (!/^[a-f0-9]{24}$/u.test(id)) throw new Error("Invalid investigation id");
	const durablePath = `investigations/${id}/result.json`;
	if (existsSync(join(goalDir, "artifacts", durablePath))) {
		const store = new RunArtifactStore(join(goalDir, "artifacts"));
		const saved: unknown = store.readJson(store.describeFile(durablePath));
		if (!isRecord(saved) || typeof saved.question !== "string") throw new Error("Investigation result is invalid");
		return validateInvestigationResult(saved, id, saved.question);
	}
	const runDir = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", id);
	const request = JSON.parse(readFileSync(join(runDir, "request.json"), "utf8")) as { id?: string; question?: string };
	if (request.id !== id || typeof request.question !== "string") throw new Error("Investigation request is invalid");
	return validateInvestigationResult(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")), id, request.question);
}

/** Main's local question returns only after Prime's answer and every new Cue are durable. */
export async function executeInvestigation(input: {
	goalDir: string;
	goalId: string;
	invocationId: string;
	threadId?: string;
	title?: string;
	question: string;
	context?: string;
	allowExternal?: boolean;
	outputLanguage?: OutputLanguage;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onActivity?: (activity: AgentStageActivity) => void;
	/** Verified Reader evidence is durable before this notification. */
	onCuesPersisted?: (origin: { invocationId: string; investigationId: string; threadId: string }) => void;
}): Promise<InvestigationResult> {
	const question = input.question.trim();
	if (!question || question.length > 20_000) throw new Error("Investigation requires a question of at most 20000 characters");
	const context = input.context?.trim() ?? "";
	if (context.length > 40_000) throw new Error("Investigation context exceeds 40000 characters");
	const signal = input.signal ?? new AbortController().signal;
	signal.throwIfAborted();
	const language = resolveOutputLanguage(input.outputLanguage ?? "auto", question);
	const id = sha256(`${input.goalId}\0${input.invocationId}`).slice(0, 24);
	let lastProgressEventAt = 0;
	const onActivity = (activity: AgentStageActivity) => {
		input.onActivity?.(activity);
		const now = Date.now();
		if (activity.kind === "status" || now - lastProgressEventAt >= 1_000) {
			lastProgressEventAt = now;
			publish({ type: "activity-projection:changed", goalId: input.goalId });
		}
	};
	const runDir = join(serverRuntimeDirForGoalDir(input.goalDir), "research", "investigations", id);
	mkdirSync(runDir, { recursive: true });
	const allowExternal = input.allowExternal === true;
	const request = { goalId: input.goalId, id, question, context, language, allowExternal,
		...(input.threadId ? { threadId: input.threadId } : {}), ...(input.title !== undefined ? { title: input.title } : {}) };
	const requestPath = join(runDir, "request.json");
	if (existsSync(requestPath)) {
		if (JSON.stringify(JSON.parse(readFileSync(requestPath, "utf8"))) !== JSON.stringify(request)) {
			throw new Error("Investigation invocation already belongs to a different request");
		}
	} else writeJsonAtomic(requestPath, request);
	const savedPath = join(runDir, "result.json");
	// Legacy completed invocations have no thread binding and keep their original idempotent result.
	if (existsSync(savedPath) && !existsSync(join(runDir, "thread-binding.json"))) {
		const saved = readInvestigationResult(input.goalDir, id);
		if (saved.thread_id === undefined) return saved;
	}
	return runInInvestigationThread({ goalDir: input.goalDir, executionId: id, question, context: input.context,
		threadId: input.threadId, title: input.title, allowExternal, signal }, async (thread) => {
	if (existsSync(savedPath)) return readInvestigationResult(input.goalDir, id);
	const context = thread.context ?? "";

	const knowledgeRoot = join(runDir, "input", "wiki");
	const wikiSha256 = snapshotInvestigationKnowledge(input.goalDir, input.goalId, knowledgeRoot);
	const catalog = [...new Map([
		...listSavedNoteCues(knowledgeRoot),
		...listSavedNoteReadingCues(input.goalDir).map((cue) => ({ ...cue, kind: "note_reading" as const })),
	].reverse().map((cue) => [cue.ref, cue])).values()];
	writeJsonAtomic(join(runDir, "input", "knowledge-cues.json"), catalog);
	const wikiAdapter = createWikiReferenceAdapterFromRoot(knowledgeRoot,
		createGoalLlmWikiTools({ goalDir: input.goalDir, knowledgeRoot }));
	const searchTool = wikiAdapter.tools.find((tool) => tool.name === "wiki_search")!;
	const readTool = wikiAdapter.tools.find((tool) => tool.name === "wiki_read_page")!;
	const citationsScope = createInvestigationCitationScope();
	let noteReadingCount = 0;
	let externalSearchCount = 0;
	let answerCount = 0;
	const writerState: { lastAnswer?: InvestigationAnswer } = {};
	const availableCues = new Map<string, InvestigationCitationCue>();
	const projectCues = (cues: readonly InvestigationCitationCue[]) => {
		const projected = citationsScope.projectCues(cues);
		for (const [index, cue] of cues.entries()) availableCues.set(projected[index]!.ref, cue);
		return projected;
	};
	let firstKnowledgeSearch: { key: string; result: unknown; recorded: unknown } | undefined;
	const recordInteraction = (operation: string, request: unknown, response: unknown) => {
		appendFileSync(join(runDir, "interactions.jsonl"), `${JSON.stringify({ operation, request, response })}\n`);
	};
	const runtimeRoot = join(runDir, "runtime");
	const root = join(runDir, "workspace");
	const sdkRoot = join(runDir, "sdk");
	mkdirSync(root, { recursive: true });
	mkdirSync(join(root, "work"), { recursive: true });
	const inputsRoot = join(root, "inputs");
	const taskContextFile = writeTaskContext(inputsRoot, context);
	writeJsonAtomic(join(inputsRoot, "request.json"), { question, context_ref: "inputs/context.md", language, external_allowed: allowExternal,
		thread_id: thread.threadId, thread_ref: "inputs/thread.json", previous_evidence_ref: "inputs/thread-evidence.json" });
	writeInvestigationThreadInput(input.goalDir, thread, join(runDir, "input"));
	copyFileSync(join(runDir, "input", "thread.json"), join(inputsRoot, "thread.json"));
	const historyRoot = join(runDir, "input", "history");
	if (existsSync(historyRoot)) cpSync(historyRoot, join(inputsRoot, "history"), { recursive: true });
	// Register prior durable Cue identities in this invocation's fresh citation scope.
	const previousRefs = new Set<string>();
	const unresolvedWikiRefs: string[] = [];
	for (const execution of thread.executions) {
		if (!execution.result) continue;
		const store = new RunArtifactStore(join(input.goalDir, "artifacts"));
		const prior = store.readJson<InvestigationResult>(store.openFile(execution.result));
		for (const ref of prior.citation_refs) {
			if (ref.startsWith("deep-search:") || ref.startsWith("note:")) { previousRefs.add(ref); continue; }
			if (/^C[1-9][0-9]*$/u.test(ref)) {
				const citationsPath = join(serverRuntimeDirForGoalDir(input.goalDir), "research", "investigations", execution.execution_id, "citations.json");
				const citations = existsSync(citationsPath) ? JSON.parse(readFileSync(citationsPath, "utf8")) as {
					citations?: Array<{ ref: string; wiki?: { entry?: { id?: string } } }> } : {};
				const entryId = citations.citations?.find((row) => row.ref === ref)?.wiki?.entry?.id?.replace(/^entry:/u, "");
				const cue = entryId ? catalog.find((item) => ("wiki_entry_id" in item && item.wiki_entry_id === `entry:${entryId}`)
					|| item.ref.startsWith("note:") && item.ref.split(":")[2] === entryId) : undefined;
				if (cue) previousRefs.add(cue.ref);
				else unresolvedWikiRefs.push(`Historical ${execution.execution_id}/${ref} cannot be remapped to the current allowed Wiki evidence; search and verify it again.`);
			}
		}
	}
	const recoveryGaps: string[] = [...unresolvedWikiRefs];
	const previousCues: InvestigationCitationCue[] = [];
	for (const ref of previousRefs) {
		const cue = catalog.find((item) => item.ref === ref);
		if (!cue) { recoveryGaps.push(`Prior evidence ${ref} is absent from the current allowed knowledge snapshot; verify it again.`); continue; }
		try {
			if (cue.ref.startsWith("note:")) {
				const original = resolveSavedNoteCue(input.goalDir, cue.ref);
				if (!original) throw new Error("Prior Cornell Cue is unavailable");
				previousCues.push({ ...cue, evidence: original.evidence });
			} else previousCues.push(...enrichInvestigationCues(input.goalDir, [cue]));
		}
		catch { recoveryGaps.push(`Prior evidence ${ref} could not be verified against saved original bytes; verify it again.`); }
	}
	writeJsonAtomic(join(runDir, "input", "thread-evidence.json"), { schema_version: 1, cues: previousCues, recovery_gaps: recoveryGaps });
	writeJsonAtomic(join(inputsRoot, "thread-evidence.json"), { schema_version: 1, cues: projectCues(previousCues), recovery_gaps: recoveryGaps });
	mkdirSync(sdkRoot, { recursive: true });
	copyFileSync(fileURLToPath(new URL("./python-tools/research_runtime.py", import.meta.url)), join(sdkRoot, "research_runtime.py"));
	const skillSource = fileURLToPath(new URL("../../agents/research/prime-search/skills/note-investigation", import.meta.url));
	const skillRoot = join(root, "skills", "root-agent");
	const skills = [...materializeSkills(snapshotSkills([skillSource]), skillRoot).values()];
	const env = pinTaskModelSelection(["primeRoot", "primeChild"], { ...process.env, ...input.env });
	const prompt = renderAgentPrompt("research", "prime-search", "user", {
		run_input_json: JSON.stringify({ request_ref: "inputs/request.json" }),
	}, "investigate").content;
	writeFileSync(join(runDir, "prompt.md"), prompt);
	const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(), {
		workspaceDirectory: root,
		temporalContext: { schemaVersion: 1, currentDate: new Date().toISOString().slice(0, 10), timeZone: "UTC" },
		signal,
		onActivity,
	}, root, { runDir, nodeId: "prime-investigation", attemptId: "1" }, {
		investigation: {
			wikiTool: async (operation, args) => {
				signal.throwIfAborted();
				const tool = wikiAdapter.tools.find(tool => tool.name === operation);
				if (!tool) throw new Error(`Unsupported Wiki operation '${operation}'`);
				const response = await tool.execute(`investigation-${operation}`, args, signal);
				const result = response.details as { evidence?: Array<{ cite_ref?: string }> };
				if (operation === "wiki_read_page") for (const entry of result.evidence ?? []) {
					if (entry.cite_ref) citationsScope.allowWikiRef(entry.cite_ref);
				}
				recordInteraction(operation, args, result);
				return result;
			},
			knowledgeSearch: async (query, limit) => {
				signal.throwIfAborted();
				const key = JSON.stringify({ query, limit });
				if (firstKnowledgeSearch) {
					if (firstKnowledgeSearch.key !== key) throw new Error("This investigation already searched Goal knowledge; use its result or read_sources for a missing detail");
					recordInteraction("knowledge_search", { query, limit }, firstKnowledgeSearch.recorded);
					return firstKnowledgeSearch.result;
				}
				const searched = await searchTool.execute("investigation-search", { query, top_k: limit }, signal);
				const wiki = searched.details as { results?: Array<{ page_ref?: string }> };
				const pages = await Promise.all((wiki.results ?? []).slice(0, 2).flatMap((hit) => hit.page_ref
					? [readTool.execute("investigation-read", { path: hit.page_ref }, signal).then((result) => result.details)]
					: []));
				const projectedPages = pages.map((value) => {
					const page = value as { page_ref: string; title: string; content: string; evidence?: Array<{ cite_ref?: string }> };
				for (const evidence of page.evidence ?? []) if (evidence.cite_ref) citationsScope.allowWikiRef(evidence.cite_ref);
					return { page_ref: page.page_ref, title: page.title, content: page.content.slice(0, 6_000),
						evidence: (page.evidence ?? []).slice(0, 12).map((item) => {
						const { cite_ref, cue, note } = item as { cite_ref?: string; cue?: string; note?: string };
						return { cite_ref, cue, note };
						}) };
				});
				const cues = enrichInvestigationCues(input.goalDir, rankSavedNoteCues(catalog, query, limit));
				const result = { wiki: { ...wiki, results: (wiki.results ?? []).slice(0, limit) },
					pages: projectedPages, cues: projectCues(cues) };
				const recorded = { ...result, cues };
				firstKnowledgeSearch = { key, result, recorded };
				recordInteraction("knowledge_search", { query, limit }, recorded);
				return result;
			},
			readSources: async (readingQuestion) => {
				signal.throwIfAborted();
				const reading = await executeNoteReading({ goalDir: input.goalDir, goalId: input.goalId,
					question: readingQuestion, originalQuestion: question, taskContextFile, knownCues: [...availableCues.values()],
					invocationId: `${id}-${++noteReadingCount}`, signal, env, onActivity });
				if (reading.cues.length) input.onCuesPersisted?.({ invocationId: `${id}-${noteReadingCount}`, investigationId: id, threadId: thread.threadId });
				const note = { ...reading, cues: enrichInvestigationCues(input.goalDir, reading.cues) };
				recordInteraction("read_sources", { question: readingQuestion }, note);
				return { ...note, cues: projectCues(note.cues) };
			},
			externalSearch: async (externalQuestion) => {
				signal.throwIfAborted();
				if (!allowExternal) throw new Error("This user question is limited to saved Goal materials");
				if (noteReadingCount === 0 && previousCues.length === 0) throw new Error("Search saved original materials before acquiring external evidence");
				const acquired = await readExternalSources({ goalDir: input.goalDir, goalId: input.goalId,
					runDir, investigationId: id, sequence: ++externalSearchCount,
					question: externalQuestion, originalQuestion: question, taskContextFile, knownCues: [...availableCues.values()],
					signal, env, onActivity });
				if (acquired.cues.length) input.onCuesPersisted?.({ invocationId: `${id}-external-${externalSearchCount}`, investigationId: id, threadId: thread.threadId });
				const result = { ...acquired, cues: enrichInvestigationCues(input.goalDir, acquired.cues) };
				recordInteraction("external_search", { question: externalQuestion }, result);
				return { ...result, cues: projectCues(result.cues),
					sources: result.sources.map(({ title, url }) => ({ title, url })) };
			},
			writeAnswer: async (refs, requirements) => {
				signal.throwIfAborted();
				const evidence: InvestigationAnswerEvidence[] = [];
				for (const ref of refs) {
					const durable = citationsScope.resolve(ref);
					if (durable === ref && /^C[1-9][0-9]*$/u.test(ref)) {
						await wikiAdapter.hydrateCitationRefs([ref], signal);
						const citation = wikiAdapter.resolveCitationRef(ref);
						const saved = catalog.find((cue) => cue.ref.startsWith("note:")
							&& cue.ref.split(":")[2] === citation.entry.id.replace(/^entry:/u, "")
							|| "wiki_entry_id" in cue && cue.wiki_entry_id === citation.entry.id);
						const original = saved ? saved.ref.startsWith("deep-search:")
							? resolveNoteReadingCue(input.goalDir, saved.ref) : resolveSavedNoteCue(input.goalDir, saved.ref) : undefined;
						evidence.push({ ref, section_title: citation.entry.section, cue: citation.entry.cue, note: citation.entry.note,
							evidence: original ? original.evidence.map((anchor) => ({ ...anchor,
								title: "title" in anchor ? anchor.title : citation.entry.source.title,
								url: "url" in anchor ? anchor.url : citation.entry.source.url }))
								: citation.entry.anchors.map((anchor) => ({ source_path: anchor.path,
									start_line: anchor.startLine, end_line: anchor.endLine, excerpt: anchor.content,
									title: citation.entry.source.title, url: citation.entry.source.url })) });
					} else {
						const cue = availableCues.get(ref);
						const resolved = durable.startsWith("deep-search:")
							? resolveNoteReadingCue(input.goalDir, durable) : resolveSavedNoteCue(input.goalDir, durable);
						if (!cue || !resolved) throw new Error(`Answer received unread Cue '${ref}'`);
						evidence.push({ ref, section_title: cue.section_title, cue: cue.cue, note: cue.note,
							evidence: resolved.evidence.map((anchor) => ({ ...anchor,
								title: "title" in anchor && typeof anchor.title === "string" ? anchor.title : cue.source_title,
								url: "url" in anchor && typeof anchor.url === "string" ? anchor.url : cue.canonical_locator })) });
					}
				}
				const writerDir = join(runDir, `answer-${++answerCount}`);
				const inputRoot = join(writerDir, "input");
				writeInvestigationAnswerInput({ inputRoot, goalDir: input.goalDir, evidence,
					request: { schema_version: 1, question, context, language,
						requirements: requirements.map((part, index) => ({ id: `Q${index + 1}`, question: part })), evidence_refs: refs } });
				writerState.lastAnswer = await executeInvestigationAnswer({ inputRoot, goalDir: input.goalDir,
					recordDirectory: runDir, invocationId: `${id}-answer-${answerCount}`, env, signal, onActivity });
				const recorded = citationsScope.restore(writerState.lastAnswer);
				recordInteraction("write_answer", { evidence_refs: refs.map((ref) => citationsScope.resolve(ref)), requirements },
					{ ...recorded, coverage: writerState.lastAnswer.coverage.map((row) => ({ ...row,
						citation_refs: row.citation_refs.map((ref) => citationsScope.resolve(ref)) })) });
				return writerState.lastAnswer;
			},
		},
	});
	const model = resolvePrimeModel("primeRoot", env);
	const thinking = resolveStageThinkingLevel("primeRoot", "searchAcquisition", env).thinkingLevel;
	const captureMetrics: { usage?: ResearchModelUsage; toolCalls?: number } = {};
	const startedAt = new Date().toISOString();
	const tracePath = join(runDir, "trace.jsonl");
	writeJsonAtomic(`${tracePath}.sessions.json`, { schemaVersion: 1,
		sessions: [{ path: relative(runDir, join(runtimeRoot, "session", "session")), label: "Investigate Root" }] });
	appendRuntimeContext(runDir, "research", { type: "runtime.agent_bound", stage_id: "prime-investigation",
		execution_id: id, agent: "prime_search", session_file: basename(tracePath), created_at: startedAt });
	let status: "succeeded" | "failed" | "cancelled" = "failed";
	let failure: string | undefined;
	try {
		const execute = async (): Promise<InvestigationResult> => {
		const run = await runPrime({
			module: primeAgentModulePath(env), cwd: root, runtimeRoot,
			readonlyRoots: [sdkRoot, skillRoot, inputsRoot], privateRoots: [input.goalDir],
			sessionDir: join(runtimeRoot, "session", "session"),
			provider: model.provider, model: model.modelId, prompt, skills, tools: ["ipython"],
			thinking,
			scopedModels: [], rlmMaxDepth: 0,
			extraEnv: { PRIME_AGENT_SOURCE_URL: bridge.baseUrl, PRIME_AGENT_SOURCE_TOKEN: bridge.token,
				PRIME_AGENT_SOURCE_IDS: "", PRIME_AGENT_ARTIFACT_WORKSPACE: root, PYTHONPATH: sdkRoot,
				PYTHONDONTWRITEBYTECODE: "1", RLM_MAX_DEPTH: "0", PRIME_INVESTIGATION_HANDOFF_MODE: "file" },
			env, signal, onActivity,
			activity: { stageId: "prime-investigation", attemptId: "1", role: "prime_search" },
			tracePath, conditionsPath: join(runDir, "execution-conditions.jsonl"),
			launchKind: "local_investigation",
		});
		captureMetrics.usage = run.usage;
		captureMetrics.toolCalls = run.toolCalls;
		if (run.rootError) throw new Error(run.rootError);
		signal.throwIfAborted();
		const outputPath = join(root, "work", "result.json");
		const stat = lstatSync(outputPath, { throwIfNoEntry: false });
		if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000) {
			throw new Error(run.rootError ?? "Prime investigation did not write a valid result file");
		}
		const value = JSON.parse(readFileSync(outputPath, "utf8"));
		if (!isRecord(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(["answer_ref"])) {
			throw new Error("Prime investigation must submit only its Writer handoff reference");
		}
		const answer = readLatestInvestigationWriter(root, value.answer_ref) as InvestigationAnswer;
		const draft = validateInvestigationResult({ answer: answer.answer, citation_refs: answer.citation_refs,
			gaps: answer.gaps, id, question, wiki_sha256: wikiSha256, thread_id: thread.threadId }, id, question);
		if (!writerState.lastAnswer || JSON.stringify({ answer: draft.answer, citation_refs: draft.citation_refs, gaps: draft.gaps })
			!== JSON.stringify({ answer: writerState.lastAnswer.answer, citation_refs: writerState.lastAnswer.citation_refs, gaps: writerState.lastAnswer.gaps })) {
			throw new Error("Prime must deliver the delegated Writer's answer without rewriting it");
		}
		const result = validateInvestigationResult(citationsScope.restore(draft), id, question);
		const wikiRefs = result.citation_refs.filter((ref) => /^C[1-9][0-9]*$/u.test(ref));
		if (wikiRefs.length) await wikiAdapter.hydrateCitationRefs(wikiRefs, signal);
		const citations = result.citation_refs.map((ref) => {
			if (wikiRefs.includes(ref)) return { ref, wiki: wikiAdapter.resolveCitationRef(ref) };
			const cue = ref.startsWith("note:")
				? resolveSavedNoteCue(input.goalDir, ref)
				: resolveNoteReadingCue(input.goalDir, ref);
			if (!cue) throw new Error(`Prime cited unavailable Cue '${ref}'`);
			return { ref, cue };
		});
		const progressPath = join(root, "work", "progress.json");
		if (existsSync(progressPath)) {
			const progressStore = new RunArtifactStore(join(root, "work"));
			const artifact = progressStore.describeFile("progress.json");
			if (artifact.byteLength > 64_000) throw new Error("Investigation progress exceeds its bounded size");
			validateInvestigationProgress(progressStore.readJson(artifact));
		}
		writeJsonAtomic(join(runDir, "citations.json"), { schema_version: 1, citations });
		writeJsonAtomic(savedPath, result);
		return result;
		};
		const capture = caseCapture()?.investigation;
		const result = capture ? await capture({ goalDir: input.goalDir, goalId: input.goalId, runDir,
			question, context, language, allowExternal, wikiSha256, model: model.selector, thinking, metrics: captureMetrics,
			handoffMode: "file", threadId: thread.threadId, execute }) : await execute();
		status = "succeeded";
		return result;
	} catch (error) {
		status = signal.aborted ? "cancelled" : "failed";
		failure = toErrorMessage(error);
		throw error;
	} finally {
		const finishedAt = new Date().toISOString();
		appendNodeExecutionRecord(runDir, "research", { node_id: "prime-investigation", node_type: "agent",
			agent: "prime_search", execution_id: id, status, depends_on: [], input: {},
			output: { ...(failure ? { error: failure } : {}), ...(captureMetrics.usage ? {
				metrics: { model_calls: captureMetrics.usage.calls, tool_calls: captureMetrics.toolCalls,
					cost_usd: captureMetrics.usage.costUsd },
			} : {}) },
			time: { started_at: startedAt, finished_at: finishedAt, duration_ms: Date.parse(finishedAt) - Date.parse(startedAt) },
			trace_ref: basename(tracePath) });
		await bridge.close();
	}
	});
}

/** Resolve only the Cues returned to Prime, preserving durable fields for Capture before short-ref projection. */
export function enrichInvestigationCues<T extends InvestigationCitationCue>(goalDir: string, cues: readonly T[]): T[] {
	return cues.map((cue) => {
		if (!cue.ref.startsWith("deep-search:")) return cue;
		const resolved = resolveNoteReadingCue(goalDir, cue.ref);
		if (!resolved) throw new Error(`Prime read unavailable Cue '${cue.ref}'`);
		return { ...cue, evidence: resolved.evidence.map((evidence, index) => ({ ...cue.evidence[index], ...evidence })) };
	});
}
