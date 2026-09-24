/** Build one candidate Wiki Shard from independent Entity and Concept tasks. */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { hashJson, sha256 } from "../lib/hash.js";
import { resolveLLMConfig, resolveStageThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { TASK_MODEL_ROLE_INFO } from "../config/settings.js";
import { resolvePrimeModel } from "../agent-runtime/model-policy.js";
import { createRlmChildLogicalWorkspaceSnapshotter, snapshotLogicalWorkspace } from "../agent-runtime/logical-workspace-snapshot.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import type { CornellNotesSnapshot } from "../cornell/contracts.js";
import {
	assertPrimeModelAnswered,
	createPrimeSettingsManager,
	createPrimeTraceEventFilter,
	primeAgentModulePath,
	projectPrimeChildLifecycleEvent,
	removeStagedPrimeCredentials,
	stagePrimeAgentDirectory,
	createPrimeModelRegistry,
	PRIME_CREDENTIAL_SOURCE_ENV,
	primeAgentDir,
} from "../agent-runtime/prime-agent-paths.js";
import { requireWikiGoalContext, wikiLanguage, type GoalTopicPlan, type WikiGoalContext } from "./contracts.js";
import { toErrorMessage } from "../lib/values.js";
import { listJsonl, writeJsonAtomic } from "../lib/fs.js";

interface NoteEntry {
	id: string; revisionSha256: string; sourceRunId: string; sourceId: string; sourceTitle: string; canonicalLocator: string;
	members: CornellNotesSnapshot["notes"][number]["members"];
	section: string; sectionSummary?: string; cue: string; detail: string; topicRefs?: string[]; topicPlanRevision?: string;
	anchors: Array<{ path: string; startLine: number; endLine: number; sha256: string }>;
}
export const NOTE_WIKI_MAINTAINER_CONTRACT_VERSION = 40;

export function noteWikiEntries(evidence: CornellNotesSnapshot, topicPlanRevision?: string): NoteEntry[] {
	return evidence.notes.flatMap((record) => record.note.sections.flatMap((section, sectionIndex) => section.cue_notes.map((note, noteIndex) => {
		const identity = { source: record.note.source_id, section: sectionIndex, cue: note.cue, note: noteIndex, detail: note.note };
		const revision = { identity, sourceTitle: record.title, canonicalLocator: record.canonical_locator, members: record.members,
			sourceRevisionSha256: record.source_revision_sha256, section: section.section_title, sectionSummary: section.summary,
			topicRefs: [...new Set(note.topic_refs ?? [])], anchors: note.evidence };
		return {
			id: `entry:${hashJson(identity).slice(0, 24)}`, revisionSha256: hashJson(revision), sourceRunId: evidence.run_id,
			sourceId: record.note.source_id, sourceTitle: record.title, canonicalLocator: record.canonical_locator, members: record.members,
			section: section.section_title, sectionSummary: section.summary, cue: note.cue, detail: note.note,
			topicRefs: [...new Set(note.topic_refs ?? [])], ...(topicPlanRevision ? { topicPlanRevision } : {}),
			anchors: note.evidence.map((anchor) => ({ path: anchor.source_path, startLine: anchor.start_line,
				endLine: anchor.end_line, sha256: anchor.content_sha256 })),
		};
	})));
}

type Entry = ReturnType<typeof noteWikiEntries>[number] & { ref: string; sourceRef: string };
export type WikiShardTask = "concept" | "entity";
interface ResultPage { local_ref: string; kind: WikiShardTask; title: string; description: string; body: string }
export interface WikiShardTaskResult {
	task: WikiShardTask;
	pages: ResultPage[];
	deferred_entries: Array<{ note_ref: string; reason: string }>;
	empty_reason?: string;
}
const SAFE_LOCAL_REF = /^[A-Za-z0-9._:-]+$/u;
const TASKS: Array<{ id: WikiShardTask; name: string }> = [
	{ id: "entity", name: "Entity organizer" },
	{ id: "concept", name: "Concept synthesizer" },
];

export async function runPrimeNoteWikiMaintainer(input: {
	goal: string; evidence: CornellNotesSnapshot; topicPlan: GoalTopicPlan; workRoot: string; sessionRoot: string;
	goalContext: WikiGoalContext;
	batch: { id: string; index: number; total: number; sourceIds: string[] }; signal: AbortSignal;
	env?: NodeJS.ProcessEnv; skillWorkspaceDirectory?: string; logicalWorkspaceCaptureRoot?: string;
}): Promise<{ knowledgeRoot: string; pageCount: number; usage: ResearchModelUsage; sessionPaths: string[] }> {
	input.signal.throwIfAborted();
	const goalContext = requireWikiGoalContext(input.goalContext);
	const env = input.env ?? process.env;
	const thinkingLevel = resolveStageThinkingLevel("wikiMaintainer", "maintenance", env).thinkingLevel;
	const stageRoot = join(input.workRoot, "maintainer");
	const workspaceRoot = join(stageRoot, "workspace");
	const runtimeRoot = join(stageRoot, "runtime");
	const { entries, topics, material } = prepareInput(stageRoot, goalContext, input.evidence, input.topicPlan);
	mkdirSync(runtimeRoot, { recursive: true });
	mkdirSync(input.sessionRoot, { recursive: true });
	if (existsSync(join(stageRoot, "work", "commit.json"))) {
		try { materialize(stageRoot, entries); return finish(input.workRoot, stageRoot, runtimeRoot, input.sessionRoot); }
		catch { rmSync(join(stageRoot, "work", "commit.json"), { force: true }); }
	}
	// 进程内会话与子进程 Worker 使用同一份 staged Agent Directory：Auto Refine 关闭、rlmMaxDepth 固定，凭证在会话结束后立即删除。
	const agentDir = stagePrimeAgentDirectory(join(runtimeRoot, "agent"), env);
	try {
		const llm = resolveLLMConfig({ envVarName: TASK_MODEL_ROLE_INFO.wikiMaintainer.legacyEnvVar, taskModelRole: "wikiMaintainer", envOverride: env });
		if (!llm.model?.includes("/")) throw new Error("Wiki Shard Builder requires a configured provider/model");
		const childSelector = resolvePrimeModel("primeChild", env).selector;
		const prime = await import(primeAgentModulePath(env));
		const { authStorage, modelRegistry } = createPrimeModelRegistry(prime, agentDir, {
			...env, [PRIME_CREDENTIAL_SOURCE_ENV]: primeAgentDir(env),
		});
		const rootModel = findModel(modelRegistry, llm.model);
		const prompts = new Map(TASKS.map((task) => [task.id, renderAgentPrompt("wiki", "wiki-shard-builder", "user", {
			goal_title: goalContext.title, goal_description: goalContext.description, language: wikiLanguage(goalContext), topics, reading_material: material, child_model: childSelector,
		}, task.id).content]));
		// Conservative UTF-8 byte bound, not a tokenizer. Fail rather than truncate or silently switch to file reading.
		const promptBudget = Math.min(128 * 1024, Math.max(0, ((rootModel as { contextWindow?: number }).contextWindow ?? 0) / 2 - 8192));
		if (!Number.isFinite(promptBudget) || [...prompts.values()].some((prompt) => Buffer.byteLength(prompt) > promptBudget)) {
			throw new Error("Wiki Shard inline prompt exceeds the context budget; reduce the Source batch size before retrying");
		}
		const childModel = findModel(modelRegistry, childSelector);
		const settingsManager = createPrimeSettingsManager(prime.SettingsManager, workspaceRoot, agentDir);
		const systemPrompt = renderAgentPrompt("wiki", "wiki-shard-builder", "system-append").content;
		writeFileSync(join(runtimeRoot, "system-prompt.md"), `${systemPrompt}\n`);
		for (const { id } of TASKS) rmSync(taskAcceptedPath(stageRoot, id), { force: true });
		const logicalWorkspace = {
			guestCwd: "/workspace",
			mounts: [{ hostPath: workspaceRoot, guestPath: "/workspace", access: "read-write" as const }],
		};
		if (input.logicalWorkspaceCaptureRoot) for (const { id } of TASKS) {
			snapshotLogicalWorkspace(logicalWorkspace, join(input.logicalWorkspaceCaptureRoot, "root", id));
		}

		const settled = await Promise.allSettled(TASKS.map(async (task) => {
			const taskRuntimeRoot = join(runtimeRoot, task.id);
			const rlmSessionDir = join(taskRuntimeRoot, "session-artifacts");
			const sessionDirectory = join(input.sessionRoot, "sessions", task.id);
			mkdirSync(rlmSessionDir, { recursive: true });
			mkdirSync(sessionDirectory, { recursive: true });
			const userPrompt = prompts.get(task.id)!;
			writeFileSync(join(taskRuntimeRoot, "system-prompt.md"), `${systemPrompt}\n`);
			writeFileSync(join(taskRuntimeRoot, "user-prompt.md"), `${userPrompt}\n`);
			const loader = new prime.DefaultResourceLoader({ cwd: workspaceRoot, agentDir, settingsManager, noExtensions: true, noSkills: true,
				noPromptTemplates: true, noThemes: true, noContextFiles: true, appendSystemPrompt: [systemPrompt] });
			await loader.reload();
			const submitTool = `submit_wiki_${task.id}_result`;
			const { session } = await prime.createAgentSession({
				cwd: workspaceRoot, agentDir, authStorage, modelRegistry, settingsManager, resourceLoader: loader,
				sessionManager: prime.SessionManager.create(workspaceRoot, sessionDirectory),
				model: rootModel, thinkingLevel,
				scopedModels: [{ model: rootModel, thinkingLevel },
					{ model: childModel, thinkingLevel }],
				tools: ["ipython", submitTool], customTools: createWikiShardTaskTools(stageRoot, entries, task.id),
				rlmSessionDir, rlmMaxDepth: 1, prewarmIpythonKernel: true, executionMode: "print", telemetryDisabled: true,
			});
			session.setSessionName(task.name);
			const snapshotChildWorkspace = input.logicalWorkspaceCaptureRoot
				? createRlmChildLogicalWorkspaceSnapshotter(logicalWorkspace, input.logicalWorkspaceCaptureRoot, "child")
				: undefined;
			const shouldRecordTraceEvent = createPrimeTraceEventFilter();
			session.subscribe((event: unknown) => {
				snapshotChildWorkspace?.(event);
				if (shouldRecordTraceEvent(event)) appendFileSync(join(taskRuntimeRoot, "sdk-events.jsonl"),
					`${JSON.stringify(projectPrimeChildLifecycleEvent(event))}\n`);
			});
			const abort = () => { void session.abort(); };
			input.signal.addEventListener("abort", abort, { once: true });
			try {
				input.signal.throwIfAborted();
				await session.prompt(userPrompt);
				await session.waitForRlmQuiescence();
				assertPrimeModelAnswered(session);
				if (!existsSync(taskAcceptedPath(stageRoot, task.id))) {
					validateWikiShardTaskResult(task.id, readTaskResult(stageRoot, task.id), entries);
					throw new Error(`${task.name} completed without calling ${submitTool}()`);
				}
			} finally {
				input.signal.removeEventListener("abort", abort);
				await session.abort().catch(() => undefined);
				await session.waitForRlmQuiescence().catch(() => undefined);
				await session.disposeAsync();
			}
		}));
		const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failure) throw failure.reason;
		input.signal.throwIfAborted();
		materialize(stageRoot, entries);
		writeJsonAtomic(join(stageRoot, "work", "commit.json"), { accepted: true });
		return finish(input.workRoot, stageRoot, runtimeRoot, input.sessionRoot);
	} finally {
		removeStagedPrimeCredentials(agentDir);
	}
}

function prepareInput(root: string, goal: WikiGoalContext, evidence: CornellNotesSnapshot, topicPlan: GoalTopicPlan) {
	const digest = hashJson({ goal, evidence, topicPlan, contract: NOTE_WIKI_MAINTAINER_CONTRACT_VERSION });
	const digestPath = join(root, "digest.txt");
	if (!existsSync(digestPath) || readFileSync(digestPath, "utf-8").trim() !== digest) rmSync(root, { recursive: true, force: true });
	const raw = [...noteWikiEntries(evidence, topicPlan.revision)].sort((a, b) => a.id.localeCompare(b.id));
	const sourceIds = [...new Set(raw.map((entry) => entry.sourceId))].sort();
	const sourceRefs = new Map(sourceIds.map((id, index) => [id, `S${index + 1}`]));
	const entries = raw.map((entry, index) => ({ ...entry, ref: `N${index + 1}`, sourceRef: sourceRefs.get(entry.sourceId)! }));
	writeFile(root, "digest.txt", `${digest}\n`);
	const reading = renderWikiShardInputs(entries, topicPlan);
	for (const task of TASKS) mkdirSync(join(root, "workspace", "work", task.id), { recursive: true });
	return { entries, ...reading };
}

/** Preserve original evidence prose; Goal/Topics/material exist in prompts, not duplicate workspace documents. */
export function renderWikiShardInputs(entries: readonly Entry[], topicPlan: GoalTopicPlan) {
	const topics: string[] = [];
	for (const topic of topicPlan.topics) {
		topics.push(`### ${topic.title}`, "", topic.intent, "");
		for (const [label, values] of [["Questions", topic.questions], ["Include", topic.include], ["Exclude", topic.exclude]] as const) {
			if (values.length) topics.push(`${label}:`, ...values.map((value) => `- ${value}`), "");
		}
	}
	const material: string[] = [];
	const sources = new Map<string, Entry[]>();
	for (const entry of entries) {
		if (!sources.has(entry.sourceRef)) sources.set(entry.sourceRef, []);
		sources.get(entry.sourceRef)!.push(entry);
	}
	for (const rows of sources.values()) {
		material.push("### Source", "");
		const locators = new Map(rows.flatMap((row) => [
			{ title: row.sourceTitle, canonical_locator: row.canonicalLocator }, ...row.members,
		]).map((source) => [JSON.stringify([source.title, source.canonical_locator]), source] as const));
		for (const source of locators.values()) material.push(`Title: ${source.title}\nLocator: ${source.canonical_locator}`, "");
		const sections = new Map<string, Entry[]>();
		for (const row of rows) {
			const key = JSON.stringify([row.section, row.sectionSummary ?? ""]);
			if (!sections.has(key)) sections.set(key, []);
			sections.get(key)!.push(row);
		}
		for (const section of sections.values()) {
			material.push(`#### ${section[0]!.section}`, "", "Section summary:", section[0]!.sectionSummary ?? "", "",
				...section.flatMap((row) => [`##### ${row.ref}`, "", "Cue:", row.cue, "", "Note:", row.detail, ""]));
		}
	}
	return { topics: topics.join("\n"), material: material.join("\n") };
}

const SubmitWikiShardParams = Type.Object({}, { additionalProperties: false });
export function createWikiShardTaskTools(root: string, entries: Entry[], task: WikiShardTask): ToolDefinition[] {
	const name = `submit_wiki_${task}_result`;
	return [{ name, label: name, description: `Validate the ${task} task result. Repair work/${task}/result.json and retry if validation fails.`,
		parameters: SubmitWikiShardParams, executionMode: "sequential", async execute(_id, _params, signal) {
			signal?.throwIfAborted();
			rmSync(taskAcceptedPath(root, task), { force: true });
			validateWikiShardTaskResult(task, readTaskResult(root, task), entries);
			// Keep this check and acceptance synchronous across the two independent Sessions.
			// The last submitter can repair joint errors through its existing Tool loop.
			if (TASKS.every(({ id }) => id === task || existsSync(taskAcceptedPath(root, id)))) materialize(root, entries);
			writeJsonAtomic(taskAcceptedPath(root, task), { accepted: true });
			return { content: [{ type: "text", text: `${task} result validated and accepted` }], details: {} };
		} }];
}

export function validateWikiShardTaskResult(task: WikiShardTask, result: WikiShardTaskResult,
	entries: ReadonlyArray<Pick<Entry, "ref">>): void {
	const file = `work/${task}/result.json`;
	if (!result || typeof result !== "object" || Array.isArray(result)) throw shardViolation(task, file, "$", "must be an object");
	if (result.task !== task) throw shardViolation(task, file, "task", `must equal '${task}', received '${String(result.task)}'`);
	if (!Array.isArray(result.pages)) throw shardViolation(task, file, "pages", "must be an array");
	if (result.pages.length === 0 && (typeof result.empty_reason !== "string" || !result.empty_reason.trim())) {
		throw shardViolation(task, file, "empty_reason", "must explain why no candidate Page was produced");
	}
	const known = new Set(entries.map((entry) => entry.ref));
	const localRefs = new Set<string>();
	const outputPaths = new Set<string>();
	const cited = new Set<string>();
	for (const [index, page] of result.pages.entries()) {
		const field = `pages[${index}]`;
		if (!page || typeof page !== "object") throw shardViolation(task, file, field, "must be an object");
		if (typeof page.local_ref !== "string" || !SAFE_LOCAL_REF.test(page.local_ref) || localRefs.has(page.local_ref)) {
			throw shardViolation(task, file, `${field}.local_ref`, "must be a unique safe local Page ref");
		}
		if (page.kind !== task) throw shardViolation(task, file, `${field}.kind`, `must equal '${task}'`);
		for (const key of ["title", "description", "body"] as const) if (typeof page[key] !== "string" || !page[key].trim()) {
			throw shardViolation(task, file, `${field}.${key}`, "must be a non-empty string");
		}
		localRefs.add(page.local_ref);
		const outputPath = `${task}:${sha256(`${task}:${page.title.trim()}`).slice(0, 16)}`;
		if (outputPaths.has(outputPath)) throw shardViolation(task, file, `${field}.title`, "must not produce a duplicate output path");
		outputPaths.add(outputPath);
		if (!/^##\s+\S/mu.test(page.body) || /^#\s/mu.test(page.body) || /^---\s*$/mu.test(page.body)
			|| /^## (?:Evidence|Related)\s*$/mu.test(page.body) || /https?:\/\//u.test(page.body)) {
			throw shardViolation(task, file, `${field}.body`, "must contain ordinary H2 sections without H1, frontmatter, Evidence/Related sections, or raw URLs");
		}
		const refs = markers(page.body);
		if (refs.size === 0) throw shardViolation(task, file, `${field}.body`, "must cite at least one Note marker");
		for (const ref of refs) {
			if (!known.has(ref)) throw shardViolation(task, file, `${field}.body`, `references unknown Note '${ref}'`);
			cited.add(ref);
		}
	}
	if (!Array.isArray(result.deferred_entries)) throw shardViolation(task, file, "deferred_entries", "must be an array");
	const deferred = new Set<string>();
	for (const [index, item] of result.deferred_entries.entries()) {
		if (!item || typeof item !== "object" || typeof item.note_ref !== "string" || !known.has(item.note_ref)
			|| deferred.has(item.note_ref) || cited.has(item.note_ref)) {
			throw shardViolation(task, file, `deferred_entries[${index}].note_ref`, `must reference one unique, uncited known Note; received '${String(item?.note_ref)}'`);
		}
		if (typeof item.reason !== "string" || !item.reason.trim()) throw shardViolation(task, file, `deferred_entries[${index}].reason`, "must be a non-empty string");
		deferred.add(item.note_ref);
	}
}

function materialize(root: string, entries: Entry[]): void {
	const results = TASKS.map(({ id }) => ({ id, result: readTaskResult(root, id) }));
	for (const { id, result } of results) validateWikiShardTaskResult(id, result, entries);
	const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
	const cited = new Set(results.flatMap(({ result }) => result.pages.flatMap((page) => [...markers(page.body)])));
	const deferrals = results.flatMap(({ id, result }) => result.deferred_entries.map((item) => ({ ...item, task: id })));
	const deferred = new Set(deferrals.map((item) => item.note_ref));
	const missing = entries.filter((entry) => !cited.has(entry.ref) && !deferred.has(entry.ref));
	if (missing.length) throw shardViolation("assembly", "work/*/result.json", "pages[].body/deferred_entries",
		`must cover every Note through citation union or justified deferral; missing ${missing.map((entry) => entry.ref).join(", ")}`);
	const output = join(root, "validation-knowledge");
	rmSync(output, { recursive: true, force: true });
	mkdirSync(join(output, "concepts"), { recursive: true });
	mkdirSync(join(output, "entities"), { recursive: true });
	const paths = new Set<string>();
	const rows: Array<{ kind: WikiShardTask; title: string; description: string; path: string }> = [];
	for (const page of results.flatMap(({ result }) => result.pages)) {
		const id = `${page.kind}:${sha256(`${page.kind}:${page.title.trim()}`).slice(0, 16)}`;
		const path = `${page.kind === "entity" ? "entities" : "concepts"}/${id.split(":")[1]}.md`;
		if (paths.has(path)) throw shardViolation("assembly", "work/*/result.json", "pages[].title", `produces duplicate output path '${path}'`);
		paths.add(path);
		const citedRefs: string[] = [];
		const body = page.body.trim().replace(/\[\[(N[1-9][0-9]*)\]\]/gu, (_, ref: string) => {
			if (!citedRefs.includes(ref)) citedRefs.push(ref);
			return `[^${citedRefs.indexOf(ref) + 1}]`;
		});
		const citedEntries = citedRefs.map((ref) => byRef.get(ref)!);
		writeFile(output, path, ["---", `page_id: ${JSON.stringify(id)}`, `type: ${page.kind}`,
			`title: ${JSON.stringify(page.title.trim())}`, `description: ${JSON.stringify(page.description.trim())}`, "entry_ids:",
			...citedEntries.map((entry) => `  - ${JSON.stringify(entry.id)}`),
			`sources: ${JSON.stringify([...new Set(citedEntries.map((entry) => entry.sourceId))].sort())}`,
			"---", "", `# ${page.title.trim()}`, "", body, "", "## Evidence", "",
			...citedEntries.map((entry, index) => footnote(index + 1, entry)), ""].join("\n"));
		rows.push({ kind: page.kind, title: page.title.trim(), description: page.description.trim(), path });
	}
	writeJsonAtomic(join(output, ".note-registry.json"), { schema_version: 2, contract_version: NOTE_WIKI_MAINTAINER_CONTRACT_VERSION,
		entries: entries.map(({ ref: _ref, sourceRef: _sourceRef, ...entry }) => entry) });
	writeJsonAtomic(join(output, ".deferred-notes.json"), entries.filter((entry) => !cited.has(entry.ref)).map((entry) => ({
		entry_id: entry.id, reason: deferrals.filter((item) => item.note_ref === entry.ref)
			.map((item) => `${item.task}: ${item.reason.trim()}`).join("; ") })));
	writeFile(output, "README.md", ["# Goal Wiki", "", ...(["concept", "entity"] as const).flatMap((kind) => [
		`## ${kind === "concept" ? "Concepts" : "Entities"}`, "",
		...rows.filter((row) => row.kind === kind).sort((a, b) => a.title.localeCompare(b.title))
			.map((row) => `- [${row.title}](${row.path}) - ${row.description}`), ""])] .join("\n"));
}

function readTaskResult(root: string, task: WikiShardTask): WikiShardTaskResult {
	return readShardJson<WikiShardTaskResult>(join(root, "workspace", "work", task, "result.json"), `work/${task}/result.json`);
}
function taskAcceptedPath(root: string, task: WikiShardTask): string { return join(root, "work", task, "accepted.json"); }
function markers(body: string): Set<string> { return new Set([...body.matchAll(/\[\[(N[1-9][0-9]*)\]\]/gu)].map((match) => match[1]!)); }
function footnote(index: number, entry: Entry): string {
	const anchors = entry.anchors.map((anchor) => `${anchor.path}:${anchor.startLine}-${anchor.endLine} (${anchor.sha256.slice(0, 12)})`).join("; ");
	const sources = [...new Map([[entry.canonicalLocator, entry.sourceTitle] as const,
		...entry.members.map((member) => [member.canonical_locator, member.title] as const)]).entries()]
		.map(([url, title]) => `[${title}](${url})`).join("; ");
	return `[^${index}]: ${sources}; ${anchors}; Cornell Entry \`${entry.id}\`.`;
}
function findModel(registry: { find(provider: string, model: string): unknown }, selector: string): unknown {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) throw new Error(`Invalid model '${selector}'`);
	const model = registry.find(selector.slice(0, slash), selector.slice(slash + 1));
	if (!model) throw new Error(`Model '${selector}' is not configured`);
	return model;
}
function collectUsage(roots: string[]): ResearchModelUsage {
	const usage: ResearchModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	for (const path of roots.flatMap((root) => listJsonl(root))) for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
		try {
			const value = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } } };
			if (!new Set(["message", "message_end"]).has(value.type ?? "") || value.message?.role !== "assistant" || !value.message.usage) continue;
			usage.inputTokens += value.message.usage.input ?? 0; usage.outputTokens += value.message.usage.output ?? 0;
			usage.costUsd += value.message.usage.cost?.total ?? 0; usage.calls += 1;
		} catch { /* ignore incomplete JSONL tail */ }
	}
	return usage;
}

function countPages(root: string): number { return ["concepts", "entities"].reduce((sum, directory) => sum
	+ readdirSync(join(root, directory)).filter((name) => name.endsWith(".md")).length, 0); }
function finish(workRoot: string, stageRoot: string, runtimeRoot: string, sessionRoot: string) {
	const knowledgeRoot = join(workRoot, "knowledge");
	rmSync(knowledgeRoot, { recursive: true, force: true });
	cpSync(join(stageRoot, "validation-knowledge"), knowledgeRoot, { recursive: true });
	return { knowledgeRoot, pageCount: countPages(knowledgeRoot), usage: collectUsage([runtimeRoot, join(sessionRoot, "sessions")]),
		sessionPaths: [join(sessionRoot, "sessions"), join(runtimeRoot, "entity", "session-artifacts"),
			join(runtimeRoot, "concept", "session-artifacts")] };
}
function readShardJson<T>(path: string, file = path): T {
	if (!existsSync(path)) throw shardViolation("read", file, "$", "required file is missing");
	try { return JSON.parse(readFileSync(path, "utf-8")) as T; }
	catch (error) { throw shardViolation("read", file, "$", `must be valid JSON: ${toErrorMessage(error)}`); }
}
function shardViolation(stage: string, file: string, field: string, issue: string): Error {
	return new Error(`[wiki-shard-builder:${stage}] file '${file}', field '${field}': ${issue}`);
}
function writeFile(root: string, path: string, value: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); }
