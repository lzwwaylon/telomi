import { appendFileSync, cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOutputLanguage, type OutputLanguage } from "../../shared/languages.js";
import type { AgentStageActivity } from "../agent-runtime/agent-stage-runtime.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { resolvePrimeModel, pinTaskModelSelection } from "../agent-runtime/model-policy.js";
import { resolveStageThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { primeAgentModulePath } from "../agent-runtime/prime-agent-paths.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { materializeSkills, snapshotSkills } from "../agent-runtime/skill-registry.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { sha256 } from "../lib/hash.js";
import { isRecord } from "../lib/values.js";
import { serverRuntimeDirForGoalDir } from "../workspaces/server-runtime-paths.js";
import { caseCapture } from "../observability/case-capture.js";
import { resolveWikiEdition } from "../wiki/editions.js";
import { hashWikiDirectory } from "../wiki/files.js";
import { createGoalLlmWikiTools } from "../wiki/tools.js";
import { createWikiReferenceAdapterFromRoot } from "./pipeline/wiki-report-references.js";
import { runPrime, startPrimeSourceBridge } from "./pipeline/prime-search-batch.js";
import { ResearchSourceRegistry } from "./sources/registry.js";
import { executeDeepSearch, listSavedDeepSearchCues } from "./deep-search.js";
import { listSavedCornellCues, rankSavedCues } from "./saved-cornell-cues.js";
import { resolveSavedCornellCue } from "./saved-cornell-cues.js";
import { resolveDeepSearchCue } from "./deep-search.js";
import { readExternalGithub } from "./external-github.js";

export interface InvestigationResult {
	id: string;
	question: string;
	answer: string;
	citation_refs: string[];
	gaps: string[];
	wiki_sha256: string;
}

/** Main's local question returns only after Prime's answer and every new Cue are durable. */
export async function executeInvestigation(input: {
	goalDir: string;
	goalId: string;
	invocationId: string;
	question: string;
	context?: string;
	allowExternal?: boolean;
	outputLanguage?: OutputLanguage;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onActivity?: (activity: AgentStageActivity) => void;
}): Promise<InvestigationResult> {
	const question = input.question.trim();
	if (!question || question.length > 20_000) throw new Error("Investigation requires a question of at most 20000 characters");
	const context = input.context?.trim() ?? "";
	if (context.length > 40_000) throw new Error("Investigation context exceeds 40000 characters");
	const signal = input.signal ?? new AbortController().signal;
	signal.throwIfAborted();
	const language = resolveOutputLanguage(input.outputLanguage ?? "auto", question);
	const id = sha256(`${input.goalId}\0${input.invocationId}`).slice(0, 24);
	const runDir = join(serverRuntimeDirForGoalDir(input.goalDir), "research", "investigations", id);
	mkdirSync(runDir, { recursive: true });
	const allowExternal = input.allowExternal !== false;
	const request = { goalId: input.goalId, id, question, context, language, allowExternal };
	const requestPath = join(runDir, "request.json");
	if (existsSync(requestPath)) {
		if (JSON.stringify(JSON.parse(readFileSync(requestPath, "utf8"))) !== JSON.stringify(request)) {
			throw new Error("Investigation invocation already belongs to a different request");
		}
	} else writeJsonAtomic(requestPath, request);
	const savedPath = join(runDir, "result.json");
	if (existsSync(savedPath)) return validateInvestigationResult(JSON.parse(readFileSync(savedPath, "utf8")), id, question);

	const workspaceDir = dirname(input.goalDir);
	const edition = resolveWikiEdition(workspaceDir, input.goalId);
	const knowledgeRoot = join(runDir, "input", "wiki");
	if (!existsSync(knowledgeRoot)) {
		mkdirSync(dirname(knowledgeRoot), { recursive: true });
		cpSync(edition.root, knowledgeRoot, { recursive: true });
	}
	const wikiSha256 = hashWikiDirectory(knowledgeRoot);
	const catalog = [
		...listSavedCornellCues(knowledgeRoot),
		...listSavedDeepSearchCues(input.goalDir).map((cue) => ({ ...cue, kind: "deep_search" as const })),
	];
	writeJsonAtomic(join(runDir, "input", "knowledge-cues.json"), catalog);
	const topicPlanPath = join(knowledgeRoot, ".topic-plan.json");
	const topicPlan = existsSync(topicPlanPath)
		? JSON.parse(readFileSync(topicPlanPath, "utf-8")) as { topics?: Array<{ id: string; title: string; intent?: string }> }
		: {};
	const wikiAdapter = createWikiReferenceAdapterFromRoot(knowledgeRoot,
		createGoalLlmWikiTools({ goalDir: input.goalDir, knowledgeRoot }));
	const searchTool = wikiAdapter.tools.find((tool) => tool.name === "wiki_search")!;
	const readTool = wikiAdapter.tools.find((tool) => tool.name === "wiki_read_page")!;
	const allowedRefs = new Set<string>();
	let deepSearchCount = 0;
	let githubReadCount = 0;
	let firstKnowledgeSearch: { key: string; result: unknown } | undefined;
	const recordInteraction = (operation: string, request: unknown, response: unknown) => {
		appendFileSync(join(runDir, "interactions.jsonl"), `${JSON.stringify({ operation, request, response })}\n`);
	};
	const runtimeRoot = join(runDir, "runtime");
	const root = join(runDir, "workspace");
	const sdkRoot = join(runDir, "sdk");
	mkdirSync(root, { recursive: true });
	mkdirSync(join(root, "work"), { recursive: true });
	mkdirSync(sdkRoot, { recursive: true });
	copyFileSync(fileURLToPath(new URL("./python-tools/research_runtime.py", import.meta.url)), join(sdkRoot, "research_runtime.py"));
	const skillSource = fileURLToPath(new URL("../../agents/research/prime-search/skills/deep-search", import.meta.url));
	const skillRoot = join(root, "skills", "root-agent");
	const skills = [...materializeSkills(snapshotSkills([skillSource]), skillRoot).values()];
	const env = pinTaskModelSelection(["primeRoot", "primeChild"], { ...process.env, ...input.env });
	const prompt = renderAgentPrompt("research", "prime-search", "user", {
		run_input_json: JSON.stringify({ question, context, language, external_allowed: allowExternal }),
	}, "investigate").content;
	writeFileSync(join(runDir, "prompt.md"), prompt);
	const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(), {
		workspaceDirectory: root,
		temporalContext: { schemaVersion: 1, currentDate: new Date().toISOString().slice(0, 10), timeZone: "UTC" },
		signal,
		onActivity: input.onActivity,
	}, root, { runDir, nodeId: "prime-investigation", attemptId: "1" }, {
		investigation: {
			knowledgeSearch: async (query, limit) => {
				signal.throwIfAborted();
				const key = JSON.stringify({ query, limit });
				if (firstKnowledgeSearch) {
					if (firstKnowledgeSearch.key !== key) throw new Error("This investigation already searched Goal knowledge; use its result or deep_search for a missing detail");
					recordInteraction("knowledge_search", { query, limit }, firstKnowledgeSearch.result);
					return firstKnowledgeSearch.result;
				}
				const searched = await searchTool.execute("investigation-search", { query, top_k: limit }, signal);
				const wiki = searched.details as { results?: Array<{ page_ref?: string }> };
				const pages = await Promise.all((wiki.results ?? []).slice(0, 2).flatMap((hit) => hit.page_ref
					? [readTool.execute("investigation-read", { path: hit.page_ref }, signal).then((result) => result.details)]
					: []));
				const projectedPages = pages.map((value) => {
					const page = value as { page_ref: string; title: string; content: string; evidence?: Array<{ cite_ref?: string }> };
					for (const evidence of page.evidence ?? []) if (evidence.cite_ref) allowedRefs.add(evidence.cite_ref);
					return { page_ref: page.page_ref, title: page.title, content: page.content.slice(0, 6_000),
						evidence: (page.evidence ?? []).slice(0, 12).map((item) => {
						const { cite_ref, cue, note } = item as { cite_ref?: string; cue?: string; note?: string };
						return { cite_ref, cue, note };
						}) };
				});
				const cues = rankSavedCues(catalog, query, limit);
				for (const cue of cues) allowedRefs.add(cue.ref);
				const topicIds = [...new Set(cues.flatMap((cue) => "topic_refs" in cue ? cue.topic_refs : []))];
				const topicLeads = topicIds.slice(0, 4).flatMap((id) => {
				const topic = topicPlan.topics?.find((item) => item.id === id);
				return topic ? [{ id, title: topic.title, intent: topic.intent ?? "" }] : [];
				});
				const result = { wiki: { ...wiki, results: (wiki.results ?? []).slice(0, limit) },
					pages: projectedPages, cues, topic_leads: topicLeads };
				firstKnowledgeSearch = { key, result };
				recordInteraction("knowledge_search", { query, limit }, result);
				return result;
			},
			deepSearch: async (deepQuestion) => {
				signal.throwIfAborted();
				const note = await executeDeepSearch({ goalDir: input.goalDir, goalId: input.goalId,
					question: deepQuestion, invocationId: `${id}-${++deepSearchCount}`, signal });
				for (const cue of note.cues) allowedRefs.add(cue.ref);
				recordInteraction("deep_search", { question: deepQuestion }, note);
				return note;
			},
			githubRead: async (externalQuestion, repository, ref, paths) => {
				signal.throwIfAborted();
				if (!allowExternal) throw new Error("This user question is limited to saved Goal materials");
				if (deepSearchCount === 0) throw new Error("Search saved original materials before acquiring GitHub files");
				if (githubReadCount >= 2) throw new Error("This investigation has reached its external reading limit");
				const result = await readExternalGithub({ goalDir: input.goalDir, goalId: input.goalId,
					runDir, investigationId: id, sequence: ++githubReadCount,
					question: externalQuestion, repository, ref, paths, signal, env });
				for (const cue of result.cues) allowedRefs.add(cue.ref);
				recordInteraction("github_read", { question: externalQuestion, repository, ref, paths }, result);
				return result;
			},
		},
	});
	const model = resolvePrimeModel("primeRoot", env);
	const thinking = resolveStageThinkingLevel("primeRoot", "searchAcquisition", env).thinkingLevel;
	const captureMetrics: { usage?: ResearchModelUsage; toolCalls?: number } = {};
	try {
		const execute = async (): Promise<InvestigationResult> => {
		const run = await runPrime({
			module: primeAgentModulePath(env), cwd: root, runtimeRoot,
			readonlyRoots: [sdkRoot, skillRoot], privateRoots: [input.goalDir],
			sessionDir: join(runtimeRoot, "session", "session"),
			provider: model.provider, model: model.modelId, prompt, skills, tools: ["ipython"],
			thinking,
			scopedModels: [], rlmMaxDepth: 0,
			extraEnv: { PRIME_AGENT_SOURCE_URL: bridge.baseUrl, PRIME_AGENT_SOURCE_TOKEN: bridge.token,
				PRIME_AGENT_SOURCE_IDS: "", PRIME_AGENT_ARTIFACT_WORKSPACE: root, PYTHONPATH: sdkRoot,
				PYTHONDONTWRITEBYTECODE: "1", RLM_MAX_DEPTH: "0" },
			env, signal, onActivity: input.onActivity,
			activity: { stageId: "prime-investigation", attemptId: "1", role: "prime_search" },
			tracePath: join(runDir, "trace.jsonl"), conditionsPath: join(runDir, "execution-conditions.jsonl"),
			launchKind: "local_investigation",
		});
		captureMetrics.usage = run.usage;
		captureMetrics.toolCalls = run.toolCalls;
		signal.throwIfAborted();
		const outputPath = join(root, "work", "result.json");
		const stat = lstatSync(outputPath, { throwIfNoEntry: false });
		if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000) {
			throw new Error(run.rootError ?? "Prime investigation did not write a valid result file");
		}
		const value = JSON.parse(readFileSync(outputPath, "utf8"));
		const result = validateInvestigationResult({ ...value, id, question, wiki_sha256: wikiSha256 }, id, question);
		for (const ref of result.citation_refs) if (!allowedRefs.has(ref)) throw new Error(`Prime cited unknown evidence '${ref}'`);
		const wikiRefs = result.citation_refs.filter((ref) => /^C[1-9][0-9]*$/u.test(ref));
		if (wikiRefs.length) await wikiAdapter.hydrateCitationRefs(wikiRefs, signal);
		const citations = result.citation_refs.map((ref) => {
			if (wikiRefs.includes(ref)) return { ref, wiki: wikiAdapter.resolveCitationRef(ref) };
			const cue = ref.startsWith("cornell:")
				? resolveSavedCornellCue(input.goalDir, ref)
				: resolveDeepSearchCue(input.goalDir, ref);
			if (!cue) throw new Error(`Prime cited unavailable Cue '${ref}'`);
			return { ref, cue };
		});
		writeJsonAtomic(join(runDir, "citations.json"), { schema_version: 1, citations });
		writeJsonAtomic(savedPath, result);
		return result;
		};
		const capture = caseCapture()?.investigation;
		return capture ? await capture({ goalDir: input.goalDir, goalId: input.goalId, runDir,
			question, allowExternal, wikiSha256, model: model.selector, thinking, metrics: captureMetrics, execute }) : await execute();
	} finally {
		await bridge.close();
	}
}

export function validateInvestigationResult(value: unknown, id: string, question: string): InvestigationResult {
	if (!isRecord(value) || value.id !== id || value.question !== question || typeof value.answer !== "string"
		|| !value.answer.trim() || value.answer.length > 32_000 || !Array.isArray(value.citation_refs)
		|| !Array.isArray(value.gaps) || typeof value.wiki_sha256 !== "string") {
		throw new Error("Invalid Prime investigation result");
	}
	const refs = value.citation_refs;
	const gaps = value.gaps;
	if (refs.some((ref: unknown) => typeof ref !== "string") || gaps.some((gap: unknown) => typeof gap !== "string")) {
		throw new Error("Prime investigation refs and gaps must be strings");
	}
	const cited = [...value.answer.matchAll(/<cite>([^<>\s]+)<\/cite>/gu)].map((match) => match[1]!);
	if (JSON.stringify([...new Set(cited)].sort()) !== JSON.stringify([...new Set(refs)].sort())
		|| refs.length !== new Set(refs).size) throw new Error("Prime investigation answer and citation refs disagree");
	return value as unknown as InvestigationResult;
}
