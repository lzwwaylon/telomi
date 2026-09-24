import { inferOutputLanguage, type ResolvedOutputLanguage } from "../../shared/languages.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "../lib/hash.js";
import { resolveLLMConfig, resolveStageThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { TASK_MODEL_ROLE_INFO } from "../config/settings.js";
import { resolvePrimeModel } from "../agent-runtime/model-policy.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { bundledAgentSkillPaths, materializeSkills, snapshotSkills } from "../agent-runtime/skill-registry.js";
import { spawnPrimeWorker } from "../agent-runtime/prime-worker.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { splitFrontmatter } from "../wiki/model/frontmatter.js";
import { hashWikiDirectory } from "./files.js";
import { NOTE_WIKI_MAINTAINER_CONTRACT_VERSION } from "./note-wiki-maintainer.js";
import { validateGoalTopicPlan, type GoalTopicPlan } from "./contracts.js";
import { goalTopicReferences } from "../goals/topic-plan/index.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { toErrorMessage } from "../lib/values.js";

interface WikiCuratorSource {
	id: string;
	knowledgeRoot: string;
}

export type WikiCuratorOperation = "initialize" | "update" | "reframe";

export interface WikiCuratorResult {
	knowledgeRoot: string;
	pageCount: number;
	usage: ResearchModelUsage;
	sessionPaths: string[];
}

interface NoteEntry {
	id: string;
	revisionSha256: string;
	sourceRunId: string;
	sourceId: string;
	sourceTitle: string;
	canonicalLocator: string;
	members: Array<{ source_id: string; provider_id: string; title: string; canonical_locator: string }>;
	section: string;
	sectionSummary?: string;
	cue: string;
	detail: string;
	topicRefs?: string[];
	topicPlanRevision?: string;
	anchors: Array<{ path: string; startLine: number; endLine: number; sha256: string }>;
}

export interface ShardPage {
	ref: string;
	shard_id: string;
	kind: "concept" | "entity";
	title: string;
	description: string;
	primary_topic_ref?: string;
	topic_refs?: string[];
	path: string;
	body: string;
}

export interface ShardRelation {
	from_ref: string;
	to_ref: string;
	label: string;
}

interface MergePlan {
	groups: Array<{ group_id: string; members: string[] }>;
}

interface MergedPage {
	member_refs: string[];
	kind: "concept" | "entity";
	title: string;
	description: string;
	primary_topic_ref: string;
	topic_refs: string[];
	body: string;
}

interface MergeGroupResult {
	group_id: string;
	pages: MergedPage[];
	/** MAIN members the child inspected and left unchanged; Runtime copies them like ungrouped ones. */
	retained_member_refs?: string[];
	discarded_member_refs: string[];
	deferred_entries: Array<{ entry_ref: string; reason: string }>;
}

/** Bump when the Curator Workspace file contract changes, so a resumed Workspace is rebuilt. */
const CURATOR_INPUT_CONTRACT_VERSION = 3;

/**
 * The Curator Agent reads and writes short Topic refs ('T1'); only Runtime files carry canonical
 * Topic IDs. See goalTopicReferences: transcribing a 20 hex character ID is not reliable.
 */
function curatorTopicRefs(topicPlan: GoalTopicPlan): {
	refById: Map<string, string>;
	idByRef: Map<string, string>;
	allowed: string;
	plan: unknown;
} {
	const references = goalTopicReferences(topicPlan);
	return {
		refById: new Map(references.map(({ ref, topic }) => [topic.id, ref])),
		idByRef: new Map(references.map(({ ref, topic }) => [ref, topic.id])),
		allowed: references.map(({ ref, topic }) => `${ref} (${topic.title})`).join(", "),
		plan: {
			...topicPlan,
			topics: references.map(({ ref, topic }) => {
				const { id: _id, ...rest } = topic;
				return { ref, ...rest };
			}),
		},
	};
}

const REGISTRY = ".note-registry.json";
const DEFERRED = ".deferred-notes.json";
const TOPIC_PLAN = ".topic-plan.json";

export function prepareEmptyEdition(root: string): void {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(join(root, "concepts"), { recursive: true });
	mkdirSync(join(root, "entities"), { recursive: true });
	writeJsonAtomic(join(root, REGISTRY), { schema_version: 2, contract_version: NOTE_WIKI_MAINTAINER_CONTRACT_VERSION, entries: [] });
	writeJsonAtomic(join(root, DEFERRED), []);
	writeFileSync(join(root, "README.md"), "# Goal Wiki\n");
}

export async function curateWikiEdition(input: {
	operation: WikiCuratorOperation;
	goal: string;
	/** Goal-level Wiki language. Cases recorded before this field fall back to the Goal text's own language. */
	language?: ResolvedOutputLanguage;
	topicPlan: GoalTopicPlan;
	previousEditionRoot?: string;
	draftRoots: readonly string[];
	workRoot: string;
	sessionRoot: string;
	signal: AbortSignal;
	env?: NodeJS.ProcessEnv;
	skillWorkspaceDirectory?: string;
	logicalWorkspaceCaptureRoot?: string;
}): Promise<WikiCuratorResult> {
	if (input.operation === "initialize" && input.previousEditionRoot) throw new Error("Wiki initialize cannot receive a previous Edition");
	if (input.operation !== "initialize" && !input.previousEditionRoot) throw new Error(`Wiki ${input.operation} requires a previous Edition`);
	if (input.operation === "reframe" && input.draftRoots.length) throw new Error("Wiki reframe cannot receive draft Shards");
	if (input.operation !== "reframe" && input.draftRoots.length !== 1) throw new Error(`Wiki ${input.operation} requires exactly one draft Shard`);
	const emptyRoot = join(input.workRoot, "empty-edition");
	prepareEmptyEdition(emptyRoot);
	const sources: WikiCuratorSource[] = input.operation === "update"
		? [
			{ id: "MAIN", knowledgeRoot: input.previousEditionRoot! },
			...input.draftRoots.map((knowledgeRoot, index) => ({ id: `DRAFT${String(index + 1).padStart(3, "0")}`, knowledgeRoot })),
		]
		: input.operation === "reframe"
			? [{ id: "MAIN", knowledgeRoot: emptyRoot }, { id: "EDITION", knowledgeRoot: input.previousEditionRoot! }]
			: [
				{ id: "MAIN", knowledgeRoot: emptyRoot },
				...input.draftRoots.map((knowledgeRoot, index) => ({ id: `DRAFT${String(index + 1).padStart(3, "0")}`, knowledgeRoot })),
			];
	const curatorRoot = join(input.workRoot, "curator");
	prepareCuratorInput(curatorRoot, sources, input.topicPlan, input.operation, input.language ?? inferOutputLanguage(input.goal));
	// Runtime 目录放在 Agent 工作区之外：staged 凭证与私有状态不能进入 Logical Workspace 快照。
	const runtimeRoot = join(input.workRoot, "curator-runtime");
	const stateRoot = join(curatorRoot, "state");
	mkdirSync(runtimeRoot, { recursive: true });
	mkdirSync(stateRoot, { recursive: true });
	reconcileCuratorState(curatorRoot);
	const commitPath = join(stateRoot, "commit.json");
	let usage: ResearchModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	let sessionPaths: string[] = [];
	if (!existsSync(commitPath)) {
		const session = await runCuratorAgent({
			operation: input.operation,
			goal: input.goal,
			curatorRoot,
			runtimeRoot,
			sessionRoot: input.sessionRoot,
			signal: input.signal,
			env: input.env ?? process.env,
			...(input.skillWorkspaceDirectory ? { skillWorkspaceDirectory: input.skillWorkspaceDirectory } : {}),
			...(input.logicalWorkspaceCaptureRoot ? { logicalWorkspaceCaptureRoot: input.logicalWorkspaceCaptureRoot } : {}),
		});
		usage = session.usage;
		sessionPaths = session.sessionPaths;
	}
	const knowledgeRoot = join(input.workRoot, "knowledge");
	materializeCuratorEdition(curatorRoot, knowledgeRoot);
	return {
		knowledgeRoot,
		pageCount: countPages(knowledgeRoot),
		usage,
		sessionPaths,
	};
}

export function prepareCuratorInput(
	curatorRoot: string,
	sources: readonly WikiCuratorSource[],
	rawTopicPlan: GoalTopicPlan,
	operation: WikiCuratorOperation,
	language: ResolvedOutputLanguage,
): void {
	if (sources.length < 2) throw new Error("Wiki Curator requires a base and at least one candidate source");
	const topicPlan = validateGoalTopicPlan(rawTopicPlan);
	const identity = sha256(JSON.stringify({
		operation,
		contract: CURATOR_INPUT_CONTRACT_VERSION,
		sources: sources.map((source) => ({ id: source.id, sha256: hashWikiDirectory(source.knowledgeRoot) })),
		topicPlan,
		language,
	}));
	const identityPath = join(curatorRoot, "input-identity.json");
	let preparedIdentity: string | undefined;
	try {
		preparedIdentity = existsSync(identityPath) ? readCuratorJson<{ identity?: string }>(identityPath).identity : undefined;
	} catch {
		// An interrupted identity write is not reusable.
	}
	if (existsSync(join(curatorRoot, "input", "index.json"))
		&& preparedIdentity === identity) return;
	rmSync(curatorRoot, { recursive: true, force: true });
	const { refById, plan: agentTopicPlan } = curatorTopicRefs(topicPlan);
	const inputRoot = join(curatorRoot, "input");
	mkdirSync(inputRoot, { recursive: true });
	const pages: ShardPage[] = [];
	const relations: ShardRelation[] = [];
	const entries = new Map<string, NoteEntry>();
	const deferred = new Map<string, string>();
	for (const source of sources) {
		for (const entry of readRegistry(source.knowledgeRoot)) entries.set(entry.id, entry);
		for (const item of readDeferred(source.knowledgeRoot)) deferred.set(item.entry_id, item.reason);
		const rawPages = readShardPages(source);
		const refByPath = new Map(rawPages.map((page) => [page.path, page.ref]));
		for (const page of rawPages) {
			const localized = localizeShardPage(page, refByPath);
			const { primary_topic_ref: _primaryTopicId, topic_refs: _topicIds, ...row } = page;
			pages.push({ ...row, ...shardPageTopicRefs(page, refById), body: localized.body });
			relations.push(...localized.relations);
		}
	}
	const mainId = sources[0]!.id;
	const incomingIds = new Set(sources.slice(1).map((source) => source.id));
	const duplicateKeys = new Map<string, string[]>();
	for (const page of pages) {
		const key = identityKey(page.kind, page.title);
		duplicateKeys.set(key, [...(duplicateKeys.get(key) ?? []), page.ref]);
	}
	const compact = pages.map(({ body: _body, ...page }) => page);
	writeJsonAtomic(join(inputRoot, "index.json"), {
		operation,
		main_shard_id: mainId,
		main_page_count: compact.filter((page) => page.shard_id === mainId).length,
		incoming_pages: compact.filter((page) => incomingIds.has(page.shard_id)),
		topic_plan: agentTopicPlan,
		language,
		suggested_groups: [...duplicateKeys.entries()].filter(([, refs]) => refs.length > 1)
			.map(([identity, members], index) => ({ group_id: `identity-${index + 1}`, identity, members })),
	});
	writeJsonAtomic(join(inputRoot, "main-index.json"), compact.filter((page) => page.shard_id === mainId));
	writeJsonAtomic(join(inputRoot, "pages.json"), Object.fromEntries(pages.map((page) => [page.ref, page])));
	writeJsonAtomic(join(inputRoot, "relations.json"), relations);
	// entries.json stays canonical because it publishes the durable Note Registry, including Topic
	// refs from older Plan revisions. notes.json is the Agent view of the same Entries.
	writeJsonAtomic(join(inputRoot, "entries.json"), [...entries.values()]);
	writeJsonAtomic(join(inputRoot, "notes.json"), [...entries.values()].map((entry) => ({
		...entry,
		topicRefs: (entry.topicRefs ?? []).map((id) => refById.get(id)).filter((ref): ref is string => Boolean(ref)),
	})));
	writeJsonAtomic(join(inputRoot, "deferred.json"), [...deferred].map(([entry_id, reason]) => ({ entry_id, reason })));
	writeJsonAtomic(join(inputRoot, "topic-plan.json"), topicPlan);
	writeJsonAtomic(identityPath, { identity });
}

/** Drop refs the active Plan no longer contains: historical Topic membership is a suggestion. */
function shardPageTopicRefs(page: ShardPage, refById: ReadonlyMap<string, string>): Pick<ShardPage, "primary_topic_ref" | "topic_refs"> {
	const topicRefs = (page.topic_refs ?? []).map((id) => refById.get(id)).filter((ref): ref is string => Boolean(ref));
	const primaryTopicRef = page.primary_topic_ref ? refById.get(page.primary_topic_ref) : undefined;
	return {
		...(primaryTopicRef ? { primary_topic_ref: primaryTopicRef } : {}),
		...(topicRefs.length ? { topic_refs: topicRefs } : {}),
	};
}

function readShardPages(shard: WikiCuratorSource): ShardPage[] {
	return ["concepts", "entities"].flatMap((directory) => {
		const root = join(shard.knowledgeRoot, directory);
		if (!existsSync(root)) return [];
		return readdirSync(root).filter((file) => file.endsWith(".md")).map((file) => {
			const path = `${directory}/${file}`;
			const raw = readFileSync(join(root, file), "utf-8");
			const { fields } = splitFrontmatter(raw);
			const kind = directory === "entities" ? "entity" as const : "concept" as const;
			const title = stringField(fields?.title);
			const description = stringField(fields?.description);
			const id = stringField(fields?.page_id);
			if (!id || !title || !description) throw new Error(`Wiki Page '${shard.id}:${path}' lacks durable metadata`);
			const primaryTopicRef = stringField(fields?.primary_topic_ref);
			const topicRefs = stringArray(fields?.topic_refs);
			if (!shard.id.startsWith("DRAFT") && (!primaryTopicRef || topicRefs.length === 0)) {
				throw new Error(`Wiki Page '${shard.id}:${path}' lacks Goal Topic metadata`);
			}
			return {
				ref: `${shard.id}:${id}`, shard_id: shard.id, kind, title, description: cleanDescription(description),
				...(primaryTopicRef ? { primary_topic_ref: primaryTopicRef } : {}),
				...(topicRefs.length ? { topic_refs: topicRefs } : {}),
				path, body: raw,
			};
		});
	});
}

export function localizeShardPage(page: ShardPage, refByPath: ReadonlyMap<string, string>): {
	body: string;
	relations: ShardRelation[];
} {
	const { body: rawBody } = splitFrontmatter(page.body);
	const footnotes = new Map([...rawBody.matchAll(/^\[\^(\d+)\]:[\s\S]*?Cornell Entry `(entry:[a-f0-9]{24})`\.?$/gmu)]
		.map((match) => [match[1], match[2]]));
	const content = rawBody.split("\n## Evidence\n")[0].trimStart().replace(/^#\s+.*\n+/u, "").trim();
	const [main, related = ""] = content.split("\n## Related\n", 2);
	let body = main!;
	const relations: ShardRelation[] = [];
	for (const match of related.matchAll(/^\s*-\s+\[[^\]]+\]\(([^)\s]+\.md)\)(?:\s+-\s+(.+?))?\s*$/gmu)) {
		const [, target, semanticLabel] = match;
		const resolved = posix.normalize(posix.join(posix.dirname(page.path), target!));
		const toRef = refByPath.get(resolved);
		if (!toRef) throw new Error(`Wiki Page '${page.ref}' links to unknown Page '${target}'`);
		if (!semanticLabel?.trim()) throw new Error(`Wiki Page '${page.ref}' relation to '${target}' lacks a semantic label`);
		relations.push({ from_ref: page.ref, to_ref: toRef, label: semanticLabel.trim() });
	}
	body = body.replace(/\[([^\]]+)\]\(([^)\s]+\.md)\)/gu, (_full, label: string, target: string) => {
		const resolved = posix.normalize(posix.join(posix.dirname(page.path), target));
		const toRef = refByPath.get(resolved);
		if (!toRef) throw new Error(`Wiki Page '${page.ref}' links to unknown Page '${target}'`);
		relations.push({ from_ref: page.ref, to_ref: toRef, label: label.trim() });
		return label;
	});
	body = body.trim();
	body = body.replace(/\[\^(\d+)\]/gu, (_, number: string) => {
		const entry = footnotes.get(number);
		if (!entry) throw new Error(`Wiki Page '${page.ref}' cites unknown footnote '${number}'`);
		return `[[${entry}]]`;
	});
	return { body: `${body}\n`, relations };
}

async function runCuratorAgent(input: {
	operation: WikiCuratorOperation;
	goal: string;
	curatorRoot: string;
	runtimeRoot: string;
	sessionRoot: string;
	signal: AbortSignal;
	env: NodeJS.ProcessEnv;
	skillWorkspaceDirectory?: string;
	logicalWorkspaceCaptureRoot?: string;
}): Promise<{ usage: ResearchModelUsage; sessionPaths: string[] }> {
	const llm = resolveLLMConfig({
		envVarName: TASK_MODEL_ROLE_INFO.wikiMaintainer.legacyEnvVar,
		taskModelRole: "wikiMaintainer",
		envOverride: input.env,
	});
	if (!llm.model?.includes("/")) throw new Error("Wiki Curator requires a configured provider/model");
	const childModel = resolvePrimeModel("primeChild", input.env).selector;
	const bundledSkills = bundledAgentSkillPaths("wiki", "wiki-curator");
	if (bundledSkills.length !== 1) throw new Error("Wiki Curator must declare exactly one bundled Skill");
	const goalSkills = input.skillWorkspaceDirectory
		? snapshotSkills([join(input.skillWorkspaceDirectory, "skills", "wiki-curator")]).skills.map((skill) => skill.sourcePath)
		: [];
	const skillPaths = [...materializeSkills(
		snapshotSkills([...bundledSkills, ...goalSkills]),
		join(input.runtimeRoot, "skills"),
	).values()];
	const expectedSkill = basename(bundledSkills[0]!);
	writeFileSync(join(input.runtimeRoot, "system-prompt.md"), renderAgentPrompt("wiki", "wiki-curator", "system-append", {
		operation: input.operation,
		goal: input.goal,
		initialize_mode: input.operation === "initialize",
		update_mode: input.operation === "update",
	}).content);
	const outcome = await spawnPrimeWorker({
		name: "Wiki Curator",
		worker: fileURLToPath(new URL("./prime-wiki-merge-worker.ts", import.meta.url)),
		agentRoot: input.curatorRoot,
		runtimeRoot: input.runtimeRoot,
		readonlyRoots: skillPaths,
		env: input.env,
		extraEnv: {
			PRIME_WIKI_MERGE_ROOT: input.curatorRoot,
			PRIME_WIKI_MERGE_RUNTIME: input.runtimeRoot,
			PRIME_WIKI_MERGE_SESSION_ROOT: input.sessionRoot,
			PRIME_WIKI_MERGE_SKILLS: skillPaths.join(delimiter),
			PRIME_WIKI_MERGE_EXPECTED_SKILL: expectedSkill,
			PRIME_WIKI_MERGE_ROOT_MODEL: llm.model,
			PRIME_WIKI_MERGE_CHILD_MODEL: childModel,
			PRIME_WIKI_MERGE_THINKING: resolveStageThinkingLevel("wikiMaintainer", "maintenance", input.env).thinkingLevel,
			...(input.logicalWorkspaceCaptureRoot ? { PRIME_WIKI_LOGICAL_WORKSPACE_ROOT: input.logicalWorkspaceCaptureRoot } : {}),
		},
		signal: input.signal,
	});
	if (!outcome.result) throw new Error("Wiki Curator did not produce runtime/result.json");
	return {
		usage: outcome.usage,
		sessionPaths: [join(input.sessionRoot, "sessions"), join(input.runtimeRoot, "session-artifacts")],
	};
}

function collectCuratorEdition(curatorRoot: string) {
	const inputRoot = join(curatorRoot, "input");
	const stateRoot = join(curatorRoot, "state");
	const topicPlan = validateGoalTopicPlan(readCuratorJson<GoalTopicPlan>(join(inputRoot, "topic-plan.json")));
	const topics = curatorTopicRefs(topicPlan);
	const pagesByRef = new Map(Object.entries(readCuratorJson<Record<string, ShardPage>>(join(inputRoot, "pages.json"))));
	const entries = new Map(readCuratorJson<NoteEntry[]>(join(inputRoot, "entries.json")).map((entry) => [entry.id, entry]));
	const deferred = readCuratorJson<Array<{ entry_id: string; reason: string }>>(join(inputRoot, "deferred.json"));
	const deferredReasons = new Map(deferred.map((item) => [item.entry_id, item.reason]));
	const discardedRefs = new Set<string>();
	const plan = readCuratorJson<MergePlan>(join(stateRoot, "plan.json"));
	const grouped = new Set(plan.groups.flatMap((group) => group.members));
	const outputs: MergedPage[] = [...pagesByRef.values()].filter((page) => !grouped.has(page.ref)).map((page) => ({
		member_refs: [page.ref],
		kind: page.kind,
		title: page.title,
		description: cleanDescription(page.description),
		...topicsForCopiedPage(page, topics.idByRef),
		body: pagesByRef.get(page.ref)!.body,
	}));
	const relationRefToPage = new Map<string, MergedPage>();
	const ownedRefs: string[] = [];
	for (const page of outputs) relationRefToPage.set(page.member_refs[0]!, page);
	const outputOrigins = new Map<MergedPage, string>(outputs.map((page) => [page, "untouched MAIN"]));
	// Report every rejected Workset at once: a repair round costs one attempt of a small budget,
	// and stopping at the first violation spends the whole budget on one Workset at a time. Reading
	// the result file is part of that round: a missing or truncated one is a repairable Workset too.
	const groupResults: Array<{ group: MergePlan["groups"][number]; result: MergeGroupResult }> = [];
	const violations: string[] = [];
	for (const group of plan.groups) {
		const file = `state/groups/${group.group_id}.json`;
		try {
			const result = readCuratorJson<MergeGroupResult>(join(stateRoot, "groups", `${group.group_id}.json`), file);
			validateGroupResult(group, result, pagesByRef, topics);
			groupResults.push({ group, result });
		} catch (error) {
			violations.push(toErrorMessage(error));
		}
	}
	if (violations.length) throw new Error(violations.join("\n"));
	for (const { group, result } of groupResults) {
		for (const item of result.deferred_entries) deferredReasons.set(item.entry_ref, item.reason);
		for (const ref of result.discarded_member_refs) discardedRefs.add(ref);
		const groupPages = result.pages.map((page) => ({
			...page,
			description: cleanDescription(page.description),
			primary_topic_ref: topics.idByRef.get(page.primary_topic_ref)!,
			topic_refs: [...new Set(page.topic_refs)].map((ref) => topics.idByRef.get(ref)!),
		}));
		for (const [index, page] of groupPages.entries()) {
			outputOrigins.set(page, group.group_id);
			const ref = page.member_refs[0] ?? `DERIVED:${group.group_id}:${index + 1}`;
			relationRefToPage.set(ref, page);
			ownedRefs.push(ref);
		}
		outputs.push(...groupPages);
		// A retained MAIN Page was assigned for inspection, not for rewriting: the child found nothing
		// in this batch that changes it, so it is carried through exactly like an ungrouped one.
		for (const ref of result.retained_member_refs ?? []) {
			const page = pagesByRef.get(ref)!;
			const retained: MergedPage = {
				member_refs: [page.ref],
				kind: page.kind,
				title: page.title,
				description: cleanDescription(page.description),
				...topicsForCopiedPage(page, topics.idByRef),
				body: page.body,
			};
			outputs.push(retained);
			outputOrigins.set(retained, `${group.group_id} (retained MAIN)`);
			relationRefToPage.set(page.ref, retained);
		}
	}
	// A MAIN Page is knowledge the Wiki already published, so discarding one is never the Curator's
	// call. Carry a discarded MAIN Page through unchanged, exactly as an ungrouped one above, rather
	// than rejecting its Workset: the rejection names the offending ref but not which output Page
	// should absorb it, so the repair rounds burn out guessing and the whole batch is lost. An
	// output Page that already claims the identity keeps it, and the stale MAIN Page stays dropped.
	const claimedIdentities = new Set(outputs.map((page) => identityKey(page.kind, page.title)));
	for (const ref of [...discardedRefs]) {
		const page = pagesByRef.get(ref);
		if (page?.shard_id !== "MAIN" || claimedIdentities.has(identityKey(page.kind, page.title))) continue;
		const rescued: MergedPage = {
			member_refs: [page.ref],
			kind: page.kind,
			title: page.title,
			description: cleanDescription(page.description),
			...topicsForCopiedPage(page, topics.idByRef),
			body: page.body,
		};
		discardedRefs.delete(ref);
		outputs.push(rescued);
		outputOrigins.set(rescued, "rescued MAIN");
		relationRefToPage.set(page.ref, rescued);
		claimedIdentities.add(identityKey(page.kind, page.title));
	}
	const memberToPage = new Map<string, MergedPage>();
	for (const page of outputs) for (const ref of page.member_refs) memberToPage.set(ref, page);
	const consumedRefs = new Set([...memberToPage.keys(), ...discardedRefs]);
	if (consumedRefs.size !== pagesByRef.size) throw new Error("Wiki Curator did not consume every candidate Page exactly once");
	return { outputs, outputOrigins, relationRefToPage, memberToPage, ownedRefs, topics, topicPlan, entries, deferredReasons };
}

type CuratorEdition = ReturnType<typeof collectCuratorEdition>;

export interface CuratorRelationResult {
	concept_merges: Array<Omit<MergedPage, "kind"> & { keep_ref: string }>;
	owned_refs: string[];
	relations: ShardRelation[];
}

/** The same pre-coordination Pages feed the child, staging validation and committed recovery. */
export function curatorRelationInput(curatorRoot: string) {
	const edition = collectCuratorEdition(curatorRoot);
	const pages = [...edition.relationRefToPage].map(([ref, page]) => ({
		ref, kind: page.kind, title: page.title, description: page.description,
		primary_topic_ref: edition.topics.refById.get(page.primary_topic_ref)!,
		topic_refs: page.topic_refs.map((id) => edition.topics.refById.get(id)!), body: page.body,
	}));
	const owned = new Set(edition.ownedRefs);
	const catalogRef = new Map([...edition.relationRefToPage].map(([ref, page]) => [page, ref]));
	const resolveRef = (ref: string) => {
		const page = edition.relationRefToPage.get(ref) ?? edition.memberToPage.get(ref);
		return page ? catalogRef.get(page) : undefined;
	};
	const suggestedRelations: ShardRelation[] = [];
	const seen = new Set<string>();
	for (const edge of readCuratorJson<ShardRelation[]>(join(curatorRoot, "input", "relations.json"))) {
		const from = resolveRef(edge.from_ref);
		const to = resolveRef(edge.to_ref);
		if (!from || !to || from === to) continue;
		const key = JSON.stringify([from, edge.label, to]);
		if (seen.has(key)) continue;
		seen.add(key);
		suggestedRelations.push({ from_ref: from, to_ref: to, label: edge.label });
	}
	return {
		owned_pages: pages.filter((page) => owned.has(page.ref)),
		catalog: pages.map(({ body: _body, ...page }) => page),
		concepts: pages.filter((page) => page.kind === "concept"),
		topic_plan: edition.topics.plan,
		suggested_relations: suggestedRelations,
	};
}

export function validateCuratorRelations(curatorRoot: string, value: unknown): CuratorRelationResult {
	const edition = collectCuratorEdition(curatorRoot);
	const result = applyCuratorRelations(edition, value);
	validateCuratorIdentities(edition);
	validateCuratorEvidence(edition);
	return result;
}

function applyCuratorRelations(edition: CuratorEdition, value: unknown): CuratorRelationResult {
	const fail = (field: string, issue: string): never => {
		throw new Error(`[wiki-curator:relations] file 'work/relations/result.json', field '${field}': ${issue}`);
	};
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("$", "must be an object");
	const result = value as CuratorRelationResult;
	for (const field of ["concept_merges", "owned_refs", "relations"] as const) {
		if (!Array.isArray(result[field])) fail(field, "must be an array");
	}
	const originalPages = new Map(edition.relationRefToPage);
	const mergedRefs = new Map<string, string>();
	for (const [index, merge] of result.concept_merges.entries()) {
		const field = `concept_merges[${index}]`;
		if (!merge || typeof merge !== "object" || Array.isArray(merge)) fail(field, "must be an object");
		if (!Array.isArray(merge.member_refs) || merge.member_refs.length < 2
			|| new Set(merge.member_refs).size !== merge.member_refs.length) fail(`${field}.member_refs`, "must contain at least two distinct Concept refs");
		if (typeof merge.keep_ref !== "string" || !merge.member_refs.includes(merge.keep_ref)) fail(`${field}.keep_ref`, "must be one of member_refs");
		const members = merge.member_refs.map((ref) => {
			const page = originalPages.get(ref);
			if (typeof ref !== "string" || !page || page.kind !== "concept") fail(`${field}.member_refs`, `must reference catalog Concepts, received '${String(ref)}'`);
			if (mergedRefs.has(ref)) fail(`${field}.member_refs`, `Concept '${ref}' participates in more than one merge`);
			mergedRefs.set(ref, merge.keep_ref);
			return page!;
		});
		for (const key of ["title", "description", "body"] as const) {
			if (typeof merge[key] !== "string" || !merge[key].trim()) fail(`${field}.${key}`, "must be a non-empty string");
		}
		if (!Array.isArray(merge.topic_refs) || !merge.topic_refs.length || merge.topic_refs.some((ref) => !edition.topics.idByRef.has(ref))
			|| !edition.topics.idByRef.has(merge.primary_topic_ref) || !merge.topic_refs.includes(merge.primary_topic_ref)) {
			fail(`${field}.topic_refs/primary_topic_ref`, `must contain valid Goal Topic refs including the primary ref; allowed refs: ${edition.topics.allowed}`);
		}
		if (!/^##\s+\S/mu.test(merge.body) || /^#\s/mu.test(merge.body) || /^---\s*$/mu.test(merge.body)
			|| /^## (?:Related|Evidence)\s*$/mu.test(merge.body)) fail(`${field}.body`, "must contain ordinary H2 sections without H1, frontmatter, Related, or Evidence");
		const requiredEntries = entryMarkers(members.map((page) => page.body).join("\n"));
		const actualEntries = entryMarkers(merge.body);
		if (!actualEntries.size || actualEntries.size !== requiredEntries.size || [...actualEntries].some((ref) => !requiredEntries.has(ref))) {
			fail(`${field}.body`, `must preserve exactly the merged Concepts' Cornell Entries: ${[...requiredEntries].join(", ")}`);
		}
		const page: MergedPage = {
			member_refs: members.flatMap((member) => member.member_refs), kind: "concept", title: merge.title,
			description: cleanDescription(merge.description), body: merge.body,
			primary_topic_ref: edition.topics.idByRef.get(merge.primary_topic_ref)!,
			topic_refs: [...new Set(merge.topic_refs)].map((ref) => edition.topics.idByRef.get(ref)!),
		};
		const removed = new Set(members);
		edition.outputs = edition.outputs.filter((candidate) => !removed.has(candidate));
		edition.outputs.push(page);
		edition.outputOrigins.set(page, `coordination ${merge.keep_ref}`);
		for (const ref of merge.member_refs) edition.relationRefToPage.set(ref, page);
		for (const ref of page.member_refs) edition.memberToPage.set(ref, page);
	}
	const required = [...new Set([...edition.ownedRefs.map((ref) => mergedRefs.get(ref) ?? ref), ...result.concept_merges.map((merge) => merge.keep_ref)])].sort();
	if (result.owned_refs.some((ref) => typeof ref !== "string") || new Set(result.owned_refs).size !== result.owned_refs.length
		|| [...result.owned_refs].sort().join("\n") !== required.join("\n")) {
		fail("owned_refs", `must own every modified final Page exactly once; expected ${required.join(", ")}`);
	}
	const known = new Set([...originalPages.keys()].filter((ref) => !mergedRefs.has(ref) || mergedRefs.get(ref) === ref));
	const owned = new Set(result.owned_refs);
	const edges = new Set<string>();
	for (const [index, edge] of result.relations.entries()) {
		const field = `relations[${index}]`;
		if (!edge || typeof edge !== "object" || Array.isArray(edge)) fail(field, "must be an object");
		if (typeof edge.from_ref !== "string" || !owned.has(edge.from_ref)) fail(`${field}.from_ref`, "must reference an owned modified Page");
		if (typeof edge.to_ref !== "string" || !known.has(edge.to_ref)) fail(`${field}.to_ref`, "must reference a known final catalog Page, not an absorbed Concept");
		if (edge.from_ref === edge.to_ref) fail(field, "must not contain a self-edge");
		if (typeof edge.label !== "string" || !edge.label.trim()) fail(`${field}.label`, "must be a non-empty string");
		const key = JSON.stringify([edge.from_ref, edge.label.trim(), edge.to_ref]);
		if (edges.has(key)) fail(field, `duplicates edge '${key}'`);
		edges.add(key);
	}
	return { concept_merges: result.concept_merges, owned_refs: result.owned_refs,
		relations: result.relations.map((edge) => ({ ...edge, label: edge.label.trim() })) };
}

/** Validate provisional output before final coordination, while Workset children can still repair identities. */
export function validateCuratorWorksets(curatorRoot: string): void {
	const edition = collectCuratorEdition(curatorRoot);
	validateCuratorIdentities(edition);
	validateCuratorEvidence(edition);
}

function validateCuratorEvidence(edition: CuratorEdition): void {
	const cited = new Set<string>();
	for (const page of edition.outputs) renderMergedPage(page, "", [], new Map([[page, { id: "validation", path: "" }]]), edition.entries, cited);
	validateCuratorEntryDisposition(edition, cited);
}

function validateCuratorEntryDisposition(edition: CuratorEdition, cited: Set<string>): void {
	const undisposed = [...edition.entries.keys()].filter((id) => !cited.has(id) && !edition.deferredReasons.has(id));
	if (undisposed.length) throw new Error(`Wiki Curator must explicitly disposition Cornell Entries: ${undisposed.join(", ")}`);
}

function validateCuratorIdentities({ outputs, outputOrigins }: CuratorEdition): void {
	const identityOwners = new Map<string, MergedPage>();
	for (const page of outputs) {
		const key = identityKey(page.kind, page.title);
		const owner = identityOwners.get(key);
		if (owner) throw new Error([
			`Wiki Curator left duplicate Page identity '${key}'`,
			`from Worksets '${outputOrigins.get(owner)}' (${owner.member_refs.join(", ")})`,
			`and '${outputOrigins.get(page)}' (${page.member_refs.join(", ")})`,
		].join(" "));
		identityOwners.set(key, page);
	}
}

export function materializeCuratorEdition(curatorRoot: string, knowledgeRoot: string): void {
	const edition = collectCuratorEdition(curatorRoot);
	const stateRoot = join(curatorRoot, "state");
	const relationStatePath = join(stateRoot, "relations.json");
	const relationState = existsSync(relationStatePath)
		? applyCuratorRelations(edition, readCuratorJson<unknown>(relationStatePath)) : undefined;
	if (existsSync(join(stateRoot, "commit.json")) && !relationState) throw new Error("Committed Wiki Curator state lacks final relations");
	validateCuratorIdentities(edition);
	const { outputs, relationRefToPage, memberToPage, entries, deferredReasons, topicPlan } = edition;
	const pageMeta = new Map<MergedPage, { id: string; path: string }>();
	for (const page of outputs) {
		const id = `${page.kind}:${sha256(`${page.kind}:${page.title}`).slice(0, 16)}`;
		pageMeta.set(page, { id, path: `${page.kind === "entity" ? "entities" : "concepts"}/${id.split(":")[1]}.md` });
	}
	const resolveRelationRef = (ref: string) => relationRefToPage.get(ref) ?? memberToPage.get(ref);
	const relationOwnedPages = new Set(relationState?.owned_refs.map(resolveRelationRef).filter((page): page is MergedPage => Boolean(page)) ?? []);
	if (relationState && relationOwnedPages.size !== relationState.owned_refs.length) throw new Error("Wiki Curator relation ownership contains an unknown Page");
	const relations = [
		...readCuratorJson<ShardRelation[]>(join(curatorRoot, "input", "relations.json"))
			.filter((edge) => !relationState || !relationOwnedPages.has(resolveRelationRef(edge.from_ref)!))
			.map((edge) => ({ ...edge })),
		...(relationState?.relations ?? []),
	];
	const related = new Map<MergedPage, Array<{ target: MergedPage; label: string }>>();
	const seenEdges = new Set<string>();
	for (const edge of relations) {
		const from = resolveRelationRef(edge.from_ref);
		const target = resolveRelationRef(edge.to_ref);
		if (!from || !target || from === target) continue;
		const key = `${pageMeta.get(from)!.id}|${edge.label}|${pageMeta.get(target)!.id}`;
		if (seenEdges.has(key)) continue;
		seenEdges.add(key);
		related.set(from, [...(related.get(from) ?? []), { target, label: edge.label }]);
	}
	rmSync(knowledgeRoot, { recursive: true, force: true });
	mkdirSync(join(knowledgeRoot, "concepts"), { recursive: true });
	mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
	const cited = new Set<string>();
	const rows: Array<{ type: "concept" | "entity"; title: string; description: string; primaryTopicRef: string; topicRefs: string[]; path: string }> = [];
	for (const page of outputs) {
		const meta = pageMeta.get(page)!;
		const rendered = renderMergedPage(page, meta.path, related.get(page) ?? [], pageMeta, entries, cited);
		writeFileSync(join(knowledgeRoot, meta.path), rendered);
		rows.push({ type: page.kind, title: page.title, description: page.description,
			primaryTopicRef: page.primary_topic_ref, topicRefs: page.topic_refs, path: meta.path });
	}
	validateCuratorEntryDisposition(edition, cited);
	writeJsonAtomic(join(knowledgeRoot, REGISTRY), { schema_version: 2, contract_version: NOTE_WIKI_MAINTAINER_CONTRACT_VERSION, entries: [...entries.values()] });
	writeJsonAtomic(join(knowledgeRoot, DEFERRED), [...deferredReasons].filter(([entryId]) => !cited.has(entryId))
		.map(([entry_id, reason]) => ({ entry_id, reason })));
	writeJsonAtomic(join(knowledgeRoot, TOPIC_PLAN), topicPlan);
	writeFileSync(join(knowledgeRoot, "README.md"), renderIndex(rows, topicPlan));
}

function reconcileCuratorState(curatorRoot: string): void {
	const stateRoot = join(curatorRoot, "state");
	const planPath = join(stateRoot, "plan.json");
	if (!existsSync(planPath)) return;
	const pages = new Map(Object.entries(readCuratorJson<Record<string, ShardPage>>(join(curatorRoot, "input", "pages.json"))));
	const topics = curatorTopicRefs(validateGoalTopicPlan(readCuratorJson<GoalTopicPlan>(join(curatorRoot, "input", "topic-plan.json"))));
	const plan = readCuratorJson<MergePlan>(planPath);
	let incomplete = false;
	for (const group of plan.groups) {
		const path = join(stateRoot, "groups", `${group.group_id}.json`);
		if (!existsSync(path)) {
			incomplete = true;
			continue;
		}
		try {
			validateGroupResult(group, readCuratorJson<MergeGroupResult>(path), pages, topics);
		} catch {
			rmSync(path, { force: true });
			incomplete = true;
		}
	}
	const commitPath = join(stateRoot, "commit.json");
	if (!incomplete && existsSync(commitPath)) {
		try {
			validateCuratorRelations(curatorRoot, readCuratorJson<unknown>(join(stateRoot, "relations.json")));
		} catch {
			// Resume the ordinary final-child repair path instead of trusting stale committed output.
			incomplete = true;
		}
	}
	if (incomplete) rmSync(commitPath, { force: true });
}

/**
 * Validates one Workset result the moment its child writes it, against the frozen Plan and inputs.
 * Group-local rules only: Edition-wide consumption is checked after every Workset is in.
 * Exact-title conflicts return to Workset repair; semantic Concept coordination follows accepted Worksets.
 */
export function validateCuratorWorksetResult(curatorRoot: string, groupId: string): void {
	const inputRoot = join(curatorRoot, "input");
	const plan = readCuratorJson<MergePlan>(join(curatorRoot, "work", "plan.json"), "work/plan.json");
	const group = plan.groups.find((item) => item.group_id === groupId);
	if (!group) {
		throw new Error(`Unknown Workset '${groupId}'; assigned Worksets: ${plan.groups.map((item) => item.group_id).join(", ")}`);
	}
	const topics = curatorTopicRefs(validateGoalTopicPlan(readCuratorJson<GoalTopicPlan>(join(inputRoot, "topic-plan.json"))));
	const pages = new Map(Object.entries(readCuratorJson<Record<string, ShardPage>>(join(inputRoot, "pages.json"))));
	const file = `work/groups/${groupId}/result.json`;
	const result = readCuratorJson<MergeGroupResult>(join(curatorRoot, "work", "groups", groupId, "result.json"), file);
	validateGroupResult(group, result, pages, topics, file);
	// Only the submitting child can still act on this: it knows why it wanted the Page gone and which
	// of its own Pages should absorb it. Aggregation deliberately does not repeat the rejection - by
	// then the deciding context is gone, so it rescues the Page instead of failing the batch.
	// Report every offender at once; one per round would spend the repair budget on a single Workset.
	const discardedMain = result.discarded_member_refs.filter((ref) => pages.get(ref)?.shard_id === "MAIN");
	if (discardedMain.length > 0) {
		throw curatorResultViolation(file, "discarded_member_refs", [
			`may contain only incoming candidate Pages, received already published MAIN Pages`,
			`${discardedMain.map((ref) => `'${ref}' (${pages.get(ref)!.title})`).join(", ")}.`,
			`Keep each one unchanged in retained_member_refs when this Workset does not change it,`,
			`or consume it in the member_refs of the Page that carries its knowledge forward;`,
			`discardable candidates in this Workset: ${group.members.filter((ref) => pages.get(ref)?.shard_id !== "MAIN").join(", ") || "none"}`,
		].join(" "));
	}
}

function validateGroupResult(
	group: { group_id: string; members: string[] },
	result: MergeGroupResult,
	pages: ReadonlyMap<string, ShardPage>,
	topics: ReturnType<typeof curatorTopicRefs>,
	// Named so the rejection points at the path its reader can act on: the staged copy during
	// aggregation, the child's own output_path when the child submits it.
	file = `state/groups/${group.group_id}.json`,
): void {
	if (!result || typeof result !== "object" || Array.isArray(result)) throw curatorResultViolation(file, "$", "must be an object");
	if (result.group_id !== group.group_id) throw curatorResultViolation(file, "group_id", `must equal '${group.group_id}', received '${String(result.group_id)}'`);
	if (!Array.isArray(result.pages)) throw curatorResultViolation(file, "pages", "must be an array");
	if (!Array.isArray(result.discarded_member_refs)) throw curatorResultViolation(file, "discarded_member_refs", "must be an array");
	if (result.retained_member_refs !== undefined && !Array.isArray(result.retained_member_refs)) {
		throw curatorResultViolation(file, "retained_member_refs", "must be an array when present");
	}
	if (!Array.isArray(result.deferred_entries)) throw curatorResultViolation(file, "deferred_entries", "must be an array");
	for (const [index, page] of result.pages.entries()) {
		if (!page || typeof page !== "object" || Array.isArray(page)) throw curatorResultViolation(file, `pages[${index}]`, "must be an object");
		if (!Array.isArray(page.member_refs)) throw curatorResultViolation(file, `pages[${index}].member_refs`, "must be an array");
	}
	const retained = result.retained_member_refs ?? [];
	const discarded = result.discarded_member_refs;
	if (result.pages.length < 1 && retained.length === 0 && discarded.length === 0) {
		throw curatorResultViolation(file, "pages/retained_member_refs/discarded_member_refs", "must consume, retain or discard at least one Page");
	}
	const members = [...result.pages.flatMap((page) => page.member_refs), ...retained, ...discarded];
	if (members.length !== new Set(members).size || [...members].sort().join("\n") !== [...group.members].sort().join("\n")) {
		throw curatorResultViolation(file, "pages[].member_refs/retained_member_refs/discarded_member_refs", `must consume Workset members exactly once; expected ${group.members.join(", ")}`);
	}
	// Retaining means "inspected, nothing in this batch changes it". Only a published Page has a
	// version to keep, and an output Page with the same identity is that Page rewritten, so the two
	// cannot coexist: the child either consumes it there or leaves it alone.
	const retainedIncoming = retained.filter((ref) => pages.get(ref)?.shard_id !== "MAIN");
	if (retainedIncoming.length) {
		throw curatorResultViolation(file, "retained_member_refs", `may keep only already published MAIN Pages unchanged; incoming candidates must be consumed or discarded: ${retainedIncoming.map((ref) => `'${ref}'`).join(", ")}`);
	}
	for (const ref of retained) {
		const page = pages.get(ref)!;
		const index = result.pages.findIndex((output) => identityKey(output.kind, output.title) === identityKey(page.kind, page.title));
		if (index !== -1) {
			throw curatorResultViolation(file, "retained_member_refs", `'${ref}' (${page.title}) is retained unchanged but pages[${index}] rewrites that same identity; consume it in that Page's member_refs instead`);
		}
	}
	// A wrongly discarded MAIN Page is not rejected here: materializeCuratorEdition rescues it
	// deterministically. Failing the Workset instead spent the whole repair budget on a judgement
	// the Curator cannot make from the rejection alone, and dropped the batch's Sources with it.
	for (const [index, page] of result.pages.entries()) {
		const field = `pages[${index}]`;
		const topicRefs = Array.isArray(page.topic_refs) ? [...new Set(page.topic_refs)] : [];
		if (!new Set(["concept", "entity"]).has(page.kind)) throw curatorResultViolation(file, `${field}.kind`, "must equal 'concept' or 'entity'");
		for (const key of ["title", "description", "body"] as const) {
			if (typeof page[key] !== "string" || !page[key].trim()) throw curatorResultViolation(file, `${field}.${key}`, "must be a non-empty string");
		}
		// Every Topic error carries the allowed refs: a repair round without them can only guess again.
		// Membership decides, never truthiness: a blank or non-string ref would otherwise reach the
		// Edition as an unmapped Topic ref.
		const topicIssue = (issue: string) => `${issue}; allowed refs: ${topics.allowed}`;
		if (topicRefs.length === 0) throw curatorResultViolation(file, `${field}.topic_refs`, topicIssue("must be a non-empty array of Goal Topic refs"));
		const unknownIndex = topicRefs.findIndex((ref) => !topics.idByRef.has(ref));
		if (unknownIndex !== -1) throw curatorResultViolation(file, `${field}.topic_refs`, topicIssue(`contains unknown Goal Topic ref '${String(topicRefs[unknownIndex])}'`));
		if (!topics.idByRef.has(page.primary_topic_ref)) throw curatorResultViolation(file, `${field}.primary_topic_ref`, topicIssue(`contains unknown Goal Topic ref '${String(page.primary_topic_ref)}'`));
		if (!topicRefs.includes(page.primary_topic_ref)) throw curatorResultViolation(file, `${field}.primary_topic_ref`, topicIssue(`must also appear in topic_refs, received ${JSON.stringify(topicRefs)}`));
		if (!/^##\s+\S/mu.test(page.body) || /^#\s/mu.test(page.body) || /^---\s*$/mu.test(page.body)
			|| /^## Evidence\s*$/mu.test(page.body)) {
			throw curatorResultViolation(file, `${field}.body`, "must contain ordinary H2 sections without H1, frontmatter, or Evidence");
		}
		if (entryMarkers(page.body).size === 0) throw curatorResultViolation(file, `${field}.body`, "must retain at least one Cornell Entry marker");
		for (const ref of page.member_refs) if (!pages.has(ref)) {
			throw curatorResultViolation(file, `${field}.member_refs`, `contains unknown Shard Page '${ref}'; assigned members: ${group.members.join(", ")}`);
		}
	}
	// A retained Page keeps citing its own Entries, so they need no disposition here; they stay
	// citable by the Workset's output Pages because they were assigned to it.
	const retainedSet = new Set(retained);
	const assignedEntries = entryMarkers(group.members.map((ref) => pages.get(ref)!.body).join("\n"));
	const requiredEntries = entryMarkers(group.members.filter((ref) => !retainedSet.has(ref)).map((ref) => pages.get(ref)!.body).join("\n"));
	const submittedEntries = entryMarkers(result.pages.map((page) => page.body).join("\n"));
	const extra = [...submittedEntries].filter((entry) => !assignedEntries.has(entry));
	if (extra.length) throw curatorResultViolation(file, "pages[].body", `cites unassigned Cornell Entries ${extra.join(", ")}`);
	const deferredEntries = new Set(result.deferred_entries.map((item) => item.entry_ref));
	const undisposed = [...requiredEntries].filter((entry) => !submittedEntries.has(entry) && !deferredEntries.has(entry));
	if (undisposed.length) throw curatorResultViolation(file, "pages[].body/deferred_entries", `must explicitly disposition Cornell Entries ${undisposed.join(", ")}`);
	for (const [index, item] of result.deferred_entries.entries()) {
		if (!requiredEntries.has(item.entry_ref) || !item.reason?.trim()
			|| item.reason.trim() === "Omitted during Wiki Curation") {
			throw curatorResultViolation(file, `deferred_entries[${index}]`, "must contain an assigned entry_ref and a concrete non-default reason");
		}
	}
}

function curatorResultViolation(file: string, field: string, issue: string): Error {
	return new Error(`[wiki-curator:worksets] file '${file}', field '${field}': ${issue}`);
}

function entryMarkers(body: string): Set<string> {
	return new Set([...body.matchAll(/\[\[(entry:[a-f0-9]{24})\]\]/gu)].map((match) => match[1]!));
}

function renderMergedPage(
	page: MergedPage,
	path: string,
	relations: Array<{ target: MergedPage; label: string }>,
	pageMeta: ReadonlyMap<MergedPage, { id: string; path: string }>,
	entries: ReadonlyMap<string, NoteEntry>,
	cited: Set<string>,
): string {
	const citedIds: string[] = [];
	let body = page.body.trim().replace(/^#\s+.*\n+/u, "").replace(/\n## (?:Related|Evidence)\n[\s\S]*$/u, "");
	body = body.replace(/\[\[(entry:[a-f0-9]{24})\]\]/gu, (_, entryId: string) => {
		if (!entries.has(entryId)) throw new Error(`Merged Page '${page.title}' cites unknown Cornell Entry '${entryId}'`);
		if (!citedIds.includes(entryId)) citedIds.push(entryId);
		cited.add(entryId);
		return `[^${citedIds.indexOf(entryId) + 1}]`;
	});
	if (!body.includes("## ")) throw new Error(`Merged Page '${page.title}' must contain an H2 section`);
	const relatedRows = relations.map(({ target, label }) => {
		const targetMeta = pageMeta.get(target)!;
		return `- [${target.title}](${relativeWikiPath(path, targetMeta.path)}) - ${label}`;
	});
	const evidence = citedIds.map((entryId, index) => renderEvidence(index + 1, entries.get(entryId)!));
	const id = pageMeta.get(page)!.id;
	return [
		"---",
		`page_id: ${JSON.stringify(id)}`,
		`type: ${page.kind}`,
		`title: ${JSON.stringify(page.title)}`,
		`description: ${JSON.stringify(page.description)}`,
		`primary_topic_ref: ${JSON.stringify(page.primary_topic_ref)}`,
		`topic_refs: ${JSON.stringify(page.topic_refs)}`,
		"entry_ids:",
		...citedIds.map((entryId) => `  - ${JSON.stringify(entryId)}`),
		`sources: ${JSON.stringify([...new Set(citedIds.map((entryId) => entries.get(entryId)!.sourceId))].sort())}`,
		"---",
		"",
		`# ${page.title}`,
		"",
		body,
		...(relatedRows.length ? ["", "## Related", "", ...relatedRows] : []),
		"",
		"## Evidence",
		"",
		...evidence,
		"",
	].join("\n");
}

function readRegistry(root: string): NoteEntry[] {
	const path = join(root, REGISTRY);
	if (!existsSync(path)) throw new Error(`Wiki Note Registry is missing: ${path}`);
	const value = readCuratorJson<{ entries?: NoteEntry[] }>(path);
	if (!Array.isArray(value.entries)) throw new Error(`Wiki Note Registry has invalid entries: ${path}`);
	return value.entries;
}

function readDeferred(root: string): Array<{ entry_id: string; reason: string }> {
	const path = join(root, DEFERRED);
	if (!existsSync(path)) throw new Error(`Wiki deferred notes are missing: ${path}`);
	const value = readCuratorJson<unknown>(path);
	if (!Array.isArray(value)) throw new Error(`Wiki deferred notes are invalid: ${path}`);
	return value as Array<{ entry_id: string; reason: string }>;
}

function identityKey(kind: string, title: string): string {
	return `${kind}:${title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US")}`;
}

function cleanDescription(value: string): string {
	return value.replace(/\s*\[\[(?:entry:[a-f0-9]{24}|N\d+)\]\]/gu, "").replace(/\s+/gu, " ").trim();
}

function relativeWikiPath(from: string, to: string): string {
	return posix.relative(posix.dirname(from), to);
}

function renderEvidence(index: number, entry: NoteEntry): string {
	const anchors = entry.anchors.map((anchor) => `${anchor.path}:${anchor.startLine}-${anchor.endLine} (${anchor.sha256.slice(0, 12)})`).join("; ");
	const sources = [...new Map([
		[entry.canonicalLocator, entry.sourceTitle] as const,
		...entry.members.map((member) => [member.canonical_locator, member.title] as const),
	]).entries()].map(([url, title]) => `[${title}](${url})`).join("; ");
	return `[^${index}]: ${sources}; ${anchors}; Cornell Entry \`${entry.id}\`.`;
}

function renderIndex(
	pages: Array<{ type: "concept" | "entity"; title: string; description: string; primaryTopicRef: string; topicRefs: string[]; path: string }>,
	topicPlan: GoalTopicPlan,
): string {
	return ["# Goal Wiki", "", ...topicPlan.topics.flatMap((topic) => {
		const members = pages.filter((page) => page.topicRefs.includes(topic.id));
		return [
			`## ${topic.title}`,
			"",
			members.length === 0 ? "_No pages yet._" : "",
			...(members.length === 0 ? [""] : []),
			...(["concept", "entity"] as const).flatMap((type) => {
				const rows = members.filter((page) => page.type === type).sort((left, right) => left.title.localeCompare(right.title));
				return rows.length ? [`### ${type === "concept" ? "Concepts" : "Entities"}`, "", ...rows.map((page) => `- [${page.title}](${page.path}) - ${page.description}`), ""] : [];
			}),
		];
	})].join("\n");
}

function topicsForCopiedPage(page: ShardPage, idByRef: ReadonlyMap<string, string>): Pick<MergedPage, "primary_topic_ref" | "topic_refs"> {
	const topicRefs = [...new Set(page.topic_refs ?? [])];
	const primaryTopicRef = page.primary_topic_ref;
	if (!primaryTopicRef || topicRefs.length === 0) {
		throw new Error(`Untouched MAIN Page '${page.title}' has no Goal Topic assignment`);
	}
	if (!topicRefs.includes(primaryTopicRef) || topicRefs.some((ref) => !idByRef.has(ref))) {
		throw new Error(`Untouched MAIN Page '${page.title}' has an invalid Goal Topic assignment`);
	}
	return { primary_topic_ref: idByRef.get(primaryTopicRef)!, topic_refs: topicRefs.map((ref) => idByRef.get(ref)!) };
}

function countPages(root: string): number {
	return ["concepts", "entities"].reduce((sum, directory) => sum + (existsSync(join(root, directory))
		? readdirSync(join(root, directory)).filter((file) => file.endsWith(".md")).length
		: 0), 0);
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
		: [];
}


/** `file` names the Workspace-relative path the Agent can act on; the absolute host path cannot. */
function readCuratorJson<T>(path: string, file = path): T {
	if (!existsSync(path)) throw new Error(`[wiki-curator:read] file '${file}', field '$': required file is missing`);
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch (error) {
		throw new Error(`[wiki-curator:read] file '${file}', field '$': must be valid JSON: ${toErrorMessage(error)}`);
	}
}
