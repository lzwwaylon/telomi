import type { ResolvedOutputLanguage } from "../../../shared/languages.js";
import { resolveStageThinkingLevel } from "../../agent-runtime/model-config/resolve.js";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HindsightClient, resolvePiUserMemoryConfig } from "pi-user-memory";

import {
	bridgePositiveInteger,
	bridgeString,
	startAgentToolBridge,
} from "../../agent-runtime/agent-tool-bridge.js";
import { freezeModelDefinitions, pinTaskModelSelection, trackTaskModelSelection, resolvePrimeModel } from "../../agent-runtime/model-policy.js";
import { spawnPrimeWorker } from "../../agent-runtime/prime-worker.js";
import { bundledAgentSkillPaths, materializeSkills, snapshotSkills } from "../../agent-runtime/skill-registry.js";
import { writeJsonAtomic } from "../../lib/fs.js";
import { createGoalLlmWikiTools } from "../../wiki/tools.js";
import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import type { ResearchSchedule } from "./types.js";

const WORKER = fileURLToPath(new URL("./reviewer-worker.ts", import.meta.url));
/** How many recent occurrences the Reviewer is shown, and therefore what a Case freezes. */
export const SCHEDULE_REVIEW_RECENT_OCCURRENCES = 10;

/** Everything the Reviewer is allowed to know about the Schedule it reviews. */
export type ReviewedSchedule = Pick<ResearchSchedule, "id" | "question" | "monitoringScope" | "reportContext" | "runs">;

export interface ScheduleReviewerInput {
	goalId: string;
	workspaceDir: string;
	reviewId: string;
	schedule: ReviewedSchedule;
	/** The Goal's resolved output language. */
	language: ResolvedOutputLanguage;
	/** The previous Review with its Proposal and the user's answer, stated as history. */
	previousReview: unknown;
	signal: AbortSignal;
	env?: NodeJS.ProcessEnv;
	/** Candidate Replay stages the execution outside the Goal's Review directory. */
	root?: string;
	/**
	 * Candidate Replay answers memory and Wiki calls from the recorded Case, so a Replay
	 * reproduces exactly what the Reviewer saw and needs no live memory or Wiki service.
	 */
	answerTool?: ScheduleReviewToolAnswer;
}

/** Answers one bridged read, after Runtime has normalized its arguments. */
export type ScheduleReviewToolAnswer = (operation: string, args: unknown) => Promise<unknown>;

/** Runs one Reviewer and returns its raw, still unvalidated output. */
export type ScheduleReviewer = (input: ScheduleReviewerInput) => Promise<unknown>;

/**
 * 每次 Reviewer 执行的现场：staged Agent Directory、Worker Workspace、会话与桥调用日志。
 * 成功与失败都保留，它就是这次 Review 的 Trace。
 */
export function scheduleReviewTraceRef(reviewId: string): string {
	return join("research/schedule-reviews", reviewId);
}

export function scheduleReviewRoot(goalId: string, workspaceDir: string, reviewId: string): string {
	return join(serverRuntimeDirForGoal(goalId, workspaceDir), scheduleReviewTraceRef(reviewId));
}

/** Every bridged memory and Wiki read of one execution, with its answer. */
export function scheduleReviewToolLog(root: string): string {
	return join(root, "runtime", "review-tools.jsonl");
}

/**
 * 启动一个全新的、只读的 Research Schedule Reviewer。
 *
 * 它是 Prime SDK Agent Bundle，只通过唯一的 Prime Worker 入口启动：没有网络，
 * 唯一可写根是自己的 Worker Workspace，知识只来自 Runtime 持有的 User Memory
 * 与 Goal Wiki 只读工具。输出由 Runtime 之后按确定性契约校验。
 */
async function executeRunPrimeScheduleReviewer(input: ScheduleReviewerInput): Promise<unknown> {
	const env = input.env ?? process.env;
	const thinkingLevel = resolveStageThinkingLevel("primeRoot", "scheduleReview", env).thinkingLevel;
	const root = input.root ?? scheduleReviewRoot(input.goalId, input.workspaceDir, input.reviewId);
	const agentRoot = join(root, "agent");
	const inputsRoot = join(agentRoot, "inputs");
	const runtimeRoot = join(root, "runtime");
	mkdirSync(inputsRoot, { recursive: true });
	mkdirSync(runtimeRoot, { recursive: true });
	writeJsonAtomic(join(inputsRoot, "schedule.json"), {
		question: input.schedule.question,
		monitoringScope: input.schedule.monitoringScope,
		reportContext: input.schedule.reportContext,
		language: input.language,
	});
	writeJsonAtomic(join(inputsRoot, "recent-occurrences.json"), input.schedule.runs
		.slice(0, SCHEDULE_REVIEW_RECENT_OCCURRENCES)
		.map((run) => ({
			scheduledFor: run.scheduledFor,
			status: run.status,
			discoveredSources: run.discoveredSources,
			incrementalSources: run.incrementalSources,
			cornellNotes: run.cornellNotes,
			...(run.error ? { error: run.error } : {}),
		})));
	writeJsonAtomic(join(inputsRoot, "previous-review.json"), input.previousReview ?? null);

	const configuredSkills = bundledAgentSkillPaths("research", "schedule-reviewer");
	const expectedSkills = configuredSkills.map((path) => basename(path));
	// Reviewer 没有 Goal 级 Skill 覆盖层（它不在 WORKSPACE_AGENT_IDS 里）：Candidate 的差异
	// 来自 Candidate 实例自己的 Agent Bundle，Case 记录的 capabilitySnapshotId 把两者对上。
	const stagedSkills = materializeSkills(snapshotSkills(configuredSkills), join(runtimeRoot, "skills"));
	const stagedSkillPaths = expectedSkills.map((name) => {
		const staged = stagedSkills.get(name);
		if (!staged) throw new Error(`Research Schedule Reviewer Skill '${name}' did not materialize`);
		return staged;
	});
	const rootModel = resolvePrimeModel("primeRoot", env);
	const bridge = await startScheduleReviewBridge({
		goalId: input.goalId,
		goalDir: join(input.workspaceDir, input.goalId),
		logPath: scheduleReviewToolLog(root),
		signal: input.signal,
		...(input.answerTool ? { answerTool: input.answerTool } : {}),
	});
	let reads = 0;
	try {
		await spawnPrimeWorker({
			name: "Research Schedule Reviewer",
			worker: WORKER,
			agentRoot,
			runtimeRoot,
			readonlyRoots: [inputsRoot, ...stagedSkillPaths],
			env,
			extraEnv: {
					PRIME_SCHEDULE_REVIEW_THINKING_LEVEL: thinkingLevel,
				PRIME_SCHEDULE_REVIEW_CWD: agentRoot,
				PRIME_SCHEDULE_REVIEW_RUNTIME: runtimeRoot,
				PRIME_SCHEDULE_REVIEW_SKILLS: JSON.stringify(stagedSkillPaths),
				PRIME_SCHEDULE_REVIEW_EXPECTED_SKILLS: JSON.stringify(expectedSkills),
				PRIME_SCHEDULE_REVIEW_ROOT_MODEL: rootModel.selector,
				// The IPython kernel only inherits PRIME_AGENT_*, RLM_* and a fixed base set
				// (see apps/extensions/telomi-srt/srt-python.mjs), so anything the Skill reads
				// inside the kernel must carry that prefix.
				PRIME_AGENT_SCHEDULE_REVIEW_URL: bridge.baseUrl,
				PRIME_AGENT_SCHEDULE_REVIEW_TOKEN: bridge.token,
				PYTHONPATH: [
					...stagedSkillPaths.map((skill) => join(skill, "src")),
					env.PYTHONPATH,
				].filter(Boolean).join(":"),
			},
			signal: input.signal,
		});
		// 桥只统计成功回答过的调用，这个计数必须在关桥之前取。
		reads = Object.values(bridge.calls()).reduce((total, count) => total + count, 0);
	} finally {
		await bridge.close();
	}
	// 没有读过任何记忆或 Wiki 的 Review 没有证据可言：无论它写出什么决定，都作为失败留档。
	// 只有这一条规则能把"知识接口坏了"和"看过之后认为无需改动"区分开。
	if (reads === 0) {
		throw new Error("Research Schedule Reviewer consulted neither long-term user memory nor the Goal Wiki");
	}
	return readDecision(join(agentRoot, "review-output", "decision.json"));
}

/**
 * Runtime 持有的只读桥：把 Reviewer 的每次记忆与 Wiki 读取规范化、执行并连同答案记录下来。
 * Candidate Replay 用同一座桥，只把答案换成 Case 里冻结的那一份。
 */
export async function startScheduleReviewBridge(input: {
	goalId: string;
	goalDir: string;
	logPath: string;
	signal: AbortSignal;
	answerTool?: ScheduleReviewToolAnswer;
}) {
	const wikiNames = new Set(createGoalLlmWikiTools({ goalDir: input.goalDir }).map((tool) => tool.name));
	const answer = input.answerTool ?? liveScheduleReviewAnswer(input.goalId, input.goalDir, input.signal);
	return startAgentToolBridge("/v1/schedule-review", input.logPath, async (body) => {
		input.signal.throwIfAborted();
		const operation = bridgeString(body.operation, "Research Schedule Review operation");
		if (operation !== "memory_recall" && operation !== "memory_reflect" && !wikiNames.has(operation)) {
			throw new Error(`Unsupported Research Schedule Review operation '${operation}'`);
		}
		const args = operation === "wiki_read_page"
			? { path: bridgeString(body.path, "Wiki path") }
			: operation.startsWith("memory_")
				? { query: bridgeString(body.query, "query") }
				: { query: bridgeString(body.query, "Wiki query"), top_k: bridgePositiveInteger(body.top_k, "top_k", 20) };
		return { operation, args, value: await answer(operation, args) };
	}, { recordAnswers: true });
}

/** The live readers: the User Memory Service and the Goal Wiki, both read-only. */
function liveScheduleReviewAnswer(goalId: string, goalDir: string, signal: AbortSignal): ScheduleReviewToolAnswer {
	const wiki = new Map(createGoalLlmWikiTools({ goalDir }).map((tool) => [tool.name, tool]));
	const memory = resolvePiUserMemoryConfig({ goalId });
	const client = new HindsightClient(memory.baseUrl, memory.bankId);
	return async (operation, args) => {
		if (operation === "memory_recall" || operation === "memory_reflect") {
			const query = (args as { query: string }).query;
			return operation === "memory_reflect"
				? await client.reflect(query, { goalId })
				: await client.recall(query, { goalId });
		}
		const tool = wiki.get(operation)!;
		const result = await tool.execute(goalId, args as never, signal);
		return result.details
			?? JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");
	};
}

function readDecision(path: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		throw new Error("Research Schedule Reviewer produced no review-output/decision.json");
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		throw new Error("Research Schedule Reviewer wrote review-output/decision.json that is not valid JSON");
	}
}


export async function runPrimeScheduleReviewer(input: Parameters<typeof executeRunPrimeScheduleReviewer>[0]): ReturnType<typeof executeRunPrimeScheduleReviewer> {
	const env = freezeModelDefinitions(pinTaskModelSelection(["primeRoot"], input.env ?? process.env), join(input.root ?? scheduleReviewRoot(input.goalId, input.workspaceDir, input.reviewId), "runtime"));
	const release = trackTaskModelSelection(["primeRoot"], env, ["primeRoot.scheduleReview"]);
	try { return await executeRunPrimeScheduleReviewer({ ...input, env }); } finally { release(); }
}
