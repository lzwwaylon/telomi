import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { beginNodeEvaluationCase, finishNodeEvaluationCase, type NodeEvaluationCase } from "../agent-runtime/node-evaluation.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import type { AgentStageRequest } from "../agent-runtime/agent-stage-runtime.js";
import { isThinkingLevel, type ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import type { ResearchTemporalContext } from "../research/research-types.js";
import { validatePrimeSearchCandidateLedger } from "../research/pipeline/prime-search-contract.js";
import { listFilesRecursive } from "../lib/fs.js";
import { snapshotSkills } from "../agent-runtime/skill-registry.js";
import { sha256 } from "../lib/hash.js";
import type { NodeBacktestCaseFile, NodeBacktestCaseRef } from "./node-backtest.js";

export interface ProviderChildInput {
	schema_version: 1;
	source: NodeBacktestCaseRef & { executionId: string };
	goal_id: string;
	provider_id: string;
	child_id: string;
	model: string;
	thinking: ThinkingLevel;
	service_tier: "default" | "priority" | "flex";
	temporal_context: ResearchTemporalContext;
	task_sha256: string;
}
export type ChildCaseFile = NodeBacktestCaseFile & { absolutePath: string };

export function readProviderChildInput(directory: string): ProviderChildInput {
	const v = JSON.parse(readFileSync(join(directory, "request.json"), "utf-8")) as ProviderChildInput;
	if (v.schema_version !== 1 || !v.source?.sourceRunId || !v.source.caseId || !v.source.executionId
		|| !/^[a-z][a-z0-9_-]*$/u.test(v.provider_id) || !/^sub-[A-Za-z0-9-]+$/u.test(v.child_id)
		|| !v.goal_id || typeof v.model !== "string" || !v.model.includes("/") || !isThinkingLevel(v.thinking)
		|| !v.temporal_context || !["default", "priority", "flex"].includes(v.service_tier)
		|| sha256(readFileSync(join(directory, "task.md"))) !== v.task_sha256
		|| !existsSync(join(directory, "workspace"))) throw new Error("Provider Child Case has invalid or incomplete frozen input");
	return v;
}

/** Only the child's starting mutable files or terminal materials; capabilities are supplied separately. */
export function copyChildWorkspace(source: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	for (const file of listFilesRecursive(source, { absolute: true, strict: true, includeNonRegular: true })) {
		const path = relative(source, file);
		if (path === "skills" || path.startsWith("skills/") || path === ".prime-kernel" || path.startsWith(".prime-kernel/")) continue;
		// Artifact publication validates regular files and rejects symlinks before the Case is accepted.
		mkdirSync(dirname(join(destination, path)), { recursive: true });
		cpSync(file, join(destination, path), { dereference: false });
	}
}

export function childTraceFacts(text: string) {
	const records = text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
	if (records.find((r) => r.type === "session")?.rlmDepth !== 1) {
		throw new Error("Provider Child replay requires a native depth-1 session");
	}
	const tasks = records.filter((r) => r.type === "custom_message" && r.customType === "agent_message");
	if (tasks.length !== 1 || typeof tasks[0].content !== "string"
		|| !(tasks[0].details?.fromRelationship === "parent" || tasks[0].content.startsWith("[task from parent]"))) {
		throw new Error("Provider Child replay requires exactly one captured parent task; additional inbound messages are not supported");
	}
	const model = records.find((r) => r.type === "model_change");
	const thinking = records.find((r) => r.type === "thinking_level_change");
	const tiers = records.filter((r) => r.type === "service_tier_change");
	const tier = tiers[0];
	if (tiers.length > 1 || (tier && !["default", "priority", "flex"].includes(tier.serviceTier))) {
		throw new Error("Provider Child trace has unsupported service tier changes");
	}
	if (!model?.provider || !model.modelId || !isThinkingLevel(thinking?.thinkingLevel)) {
		throw new Error("Provider Child trace lacks its actual model or thinking level");
	}
	if (records.filter((r) => r.type === "model_change" || r.type === "thinking_level_change").length !== 2) {
		throw new Error("Provider Child changed model or thinking during execution; this Case is not replayable by recipe v1");
	}
	const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	let toolCalls = 0;
	for (const r of records) {
		if (r.type !== "message" || r.message?.role !== "assistant") continue;
		const u = r.message.usage;
		if (u) {
			usage.inputTokens += Number(u.input ?? 0);
			usage.outputTokens += Number(u.output ?? 0);
			usage.costUsd += Number(u.cost?.total ?? 0);
			usage.calls++;
		}
		toolCalls += (r.message.content ?? []).filter((c: { type?: string }) => c.type === "toolCall").length;
	}
	const times = records.map((r) => Date.parse(r.timestamp)).filter(Number.isFinite);
	return { task: tasks[0].content.replace(/^\[task from parent\]\s*/u, "").trimEnd(),
		model: `${model.provider}/${model.modelId}`, thinking: thinking.thinkingLevel as ThinkingLevel,
		serviceTier: tier?.serviceTier ?? "default", usage, toolCalls,
		durationMs: times.length ? Math.max(...times) - Math.min(...times) : 0 };
}

/** Read-only eligibility check shared by automatic Evolution selection and Case derivation. */
export function inspectProviderChildCapture(input: {
	parent: Pick<NodeEvaluationCase, "agentId">; files: ChildCaseFile[]; executionId: string;
}) {
	if (input.parent.agentId !== "prime-search") throw new Error("Provider Child Cases must originate from Prime Search");
	const output = input.files.find((f) => f.ref === "output:result.json");
	if (!output) throw new Error("Prime Search Case has no retained execution records");
	const result = JSON.parse(readFileSync(output.absolutePath, "utf-8"));
	const execution = result.execution_records?.find((e: { execution_id: string }) => e.execution_id === input.executionId);
	const childId = input.executionId.split(":").at(-1)!;
	if (!execution || !input.executionId.startsWith("provider-execution:") || input.executionId.split(":").length !== 4
		|| input.executionId.split(":")[2] !== execution.provider_id
		|| !/^sub-[A-Za-z0-9-]+$/u.test(childId) || !/^[a-z][a-z0-9_-]*$/u.test(execution.provider_id)) {
		throw new Error("Unknown Provider Child execution identity");
	}
	if (execution.terminal_status !== "valid_bundle") throw new Error("Historical Provider Child has no validated ledger");
	const traces = input.files.filter((f) => f.kind === "child_trace" && f.ref.includes(`/session-artifacts/${childId}/`));
	if (traces.length !== 1) throw new Error("Provider Child Case needs exactly one complete captured child trace");
	const trace = readFileSync(traces[0]!.absolutePath, "utf-8");
	const facts = childTraceFacts(trace);
	const initialMarker = `output:logical-workspaces/provider/${childId}/workspace/`;
	const initial = input.files.filter((f) => f.ref.startsWith(initialMarker));
	if (!initial.length) throw new Error("Provider Child Case is missing its pre-execution Workspace snapshot");
	const targetSkillPrefix = `${initialMarker}skills/provider-workers/${execution.provider_id}/`;
	const targetSkills = new Set(initial.filter((file) => file.ref.startsWith(targetSkillPrefix))
		.map((file) => file.ref.slice(targetSkillPrefix.length).split("/"))
		.filter((parts) => parts.length > 1).map((parts) => parts[0]!));
	if (!targetSkills.size || [...targetSkills].some((name) =>
		!initial.some((file) => file.ref === `${targetSkillPrefix}${name}/SKILL.md`))) {
		throw new Error("Provider Child Case is missing captured target Provider Skills or SKILL.md");
	}
	const parentRequest = input.files.find((f) => f.ref === "input:request.json");
	if (!parentRequest) throw new Error("Provider Child Case is missing captured temporal context");
	const temporal = JSON.parse(readFileSync(parentRequest.absolutePath, "utf-8")).temporal_context;
	if (!temporal || temporal.schemaVersion !== 1 || typeof temporal.currentDate !== "string"
		|| !/^\d{4}-\d{2}-\d{2}$/u.test(temporal.currentDate) || typeof temporal.timeZone !== "string"
		|| !temporal.timeZone) throw new Error("Provider Child Case has invalid captured temporal context");
	const identity = initial.find((f) => f.ref === `${initialMarker}work/.execution-id`);
	if (!identity || readFileSync(identity.absolutePath, "utf-8").trim() !== childId) {
		throw new Error("Provider Child Case lacks its initial execution identity");
	}
	for (const file of initial) {
		const path = file.ref.slice(initialMarker.length);
		if (path.split(/[\\/]/u).some((segment) => !segment || segment === "." || segment === "..")
			|| !lstatSync(file.absolutePath).isFile() || lstatSync(file.absolutePath).isSymbolicLink()) {
			throw new Error("Provider Child input must contain safe regular files");
		}
	}
	const allConditions = input.files.filter((f) => f.kind === "execution_conditions").flatMap((f) =>
		readFileSync(f.absolutePath, "utf-8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)));
	const conditions = allConditions.filter((r) => r.agent_session_id === childId);
	const inheritedLaunch = allConditions.find((r) => r.launch_kind === "root_with_native_rlm_children");
	if (!conditions.some((r) => r.skills?.items?.length) && !inheritedLaunch) {
		throw new Error("Provider Child Case has no captured native child launch context");
	}
	const launch = conditions.find((r) => r.skills?.items?.length) ?? inheritedLaunch;
	if (JSON.stringify([...(launch.tools ?? [])].sort()) !== JSON.stringify(["ipython", "submit_candidate_ledger"])
		|| JSON.stringify([...(launch.custom_tools ?? [])].sort()) !== JSON.stringify(["submit_candidate_ledger"])) {
		throw new Error("Provider Child Case has unsupported captured tools");
	}
	return { execution, childId, trace, facts, initialMarker, initial, temporal, conditions, inheritedLaunch };
}

/** Derive from historical bytes, never from a new Root plan or a terminal Workspace used as input. */
export async function deriveProviderChildCase(input: {
	goalId: string; parentRef: NodeBacktestCaseRef; executionId: string;
	parent: NodeEvaluationCase; files: ChildCaseFile[]; recordDirectory: string;
	restoreOutput: (destination: string) => Promise<void>;
	capabilitySnapshot: (source: string) => string;
}): Promise<NodeBacktestCaseRef> {
	const { execution, childId, trace, facts, initialMarker, initial, temporal, conditions, inheritedLaunch } = inspectProviderChildCapture(input);
	const staging = mkdtempSync(join(tmpdir(), "telomi-provider-child-case-"));
	try {
		const inputDirectory = join(input.recordDirectory, "child-input");
		mkdirSync(join(inputDirectory, "workspace"), { recursive: true });
		const capabilities = join(staging, "capabilities");
		mkdirSync(capabilities);
		const frozenSkills = join(staging, "frozen-skills");
		mkdirSync(frozenSkills);
		for (const file of initial) {
			const path = file.ref.slice(initialMarker.length);
			if (path.startsWith("skills/")) {
				const frozen = join(frozenSkills, path.slice("skills/".length));
				mkdirSync(dirname(frozen), { recursive: true }); cpSync(file.absolutePath, frozen);
				const match = new RegExp(`^skills/provider-workers/${execution.provider_id}/(.+)$`, "u").exec(path);
				if (match && !match[1]!.startsWith(".")) {
					const target = join(capabilities, "skills", "prime-search", match[1]!);
					mkdirSync(dirname(target), { recursive: true }); cpSync(file.absolutePath, target);
				}
				continue;
			}
			if (path.startsWith(".prime-kernel/")) continue;
			const target = join(inputDirectory, "workspace", path);
			mkdirSync(dirname(target), { recursive: true }); cpSync(file.absolutePath, target);
		}
		const task = `${facts.task}\n`;
		writeFileSync(join(inputDirectory, "task.md"), task);
		const request: ProviderChildInput = { schema_version: 1,
			source: { ...input.parentRef, executionId: input.executionId }, goal_id: input.goalId,
			provider_id: execution.provider_id, child_id: childId, model: facts.model, thinking: facts.thinking,
			service_tier: facts.serviceTier, temporal_context: temporal, task_sha256: sha256(task) };
		writeFileSync(join(inputDirectory, "request.json"), `${JSON.stringify(request, null, 2)}\n`);
		readProviderChildInput(inputDirectory);
		const restored = join(input.recordDirectory, "child-restored");
		await input.restoreOutput(restored);
		const childWorkspace = join(restored, "provider-executions", childId);
		const ledger = join(childWorkspace, "work", `${request.provider_id}_candidates.json`);
		validatePrimeSearchCandidateLedger(childWorkspace, request.provider_id, ledger, childId);
		const preservedTask = join(childWorkspace, "work", ".task.md");
		if (existsSync(preservedTask) && readFileSync(preservedTask, "utf-8").trimEnd() !== facts.task) {
			throw new Error("Preserved child task differs from its session trace");
		}
		const evidence = join(staging, "evidence");
		copyChildWorkspace(childWorkspace, join(evidence, "workspace"));
		mkdirSync(join(evidence, "traces"));
		writeFileSync(join(evidence, "traces", "session.jsonl"), trace);
		if (!conditions.some((r) => r.skills?.items?.length)) {
			const roots = initial.filter((f) => f.ref.startsWith(`${initialMarker}skills/provider-workers/${execution.provider_id}/`)
				&& /^skills\/provider-workers\/[^/]+\/[^/]+\/SKILL\.md$/u.test(f.ref.slice(initialMarker.length)))
				.map((f) => join(capabilities, "skills", "prime-search", f.ref.split("/").at(-2)!));
			const skills = snapshotSkills(roots);
			conditions.unshift({ schema_version: 1, source: "inherited_parent_launch", agent_session_id: childId,
				model: facts.model, thinking_level: facts.thinking, service_tier: facts.serviceTier,
				tools: inheritedLaunch.tools, custom_tools: inheritedLaunch.custom_tools,
				skills: { sha256: skills.sha256, items: skills.skills.map(({ name, sha256 }) => ({ name, sha256 })) } });
		}
		writeFileSync(join(evidence, "traces", "execution-conditions.jsonl"), conditions.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const calls = input.parent.observed.providerCalls;
		const providerCalls = calls ? input.files.find((f) => f.ref === `case:${calls.ref}`) : undefined;
		if (providerCalls) {
			const records = readFileSync(providerCalls.absolutePath, "utf-8").split(/\r?\n/u).filter(Boolean)
				.map((line) => JSON.parse(line)).filter((r) => r.sub_execution_id === childId);
			writeFileSync(join(evidence, "provider-calls.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
		}
		writeFileSync(join(evidence, "result.json"), JSON.stringify({ schema_version: 1, provider_id: request.provider_id,
			child_id: childId, execution_id: input.executionId, terminal_status: "valid_bundle", usage: facts.usage, tool_calls: facts.toolCalls }, null, 2) + "\n");
		const capabilitySnapshotId = input.capabilitySnapshot(capabilities);
		return captureProviderChildCase({ request, inputDirectory, evidenceDirectory: evidence, frozenSkillsDirectory: frozenSkills,
			recordDirectory: input.recordDirectory, sourceRunId: input.parentRef.sourceRunId,
			capabilitySnapshotId, usage: facts.usage, toolCalls: facts.toolCalls, durationMs: facts.durationMs });
	} finally {
		rmSync(staging, { recursive: true, force: true });
		rmSync(join(input.recordDirectory, "child-restored"), { recursive: true, force: true });
	}
}

export function captureProviderChildCase(input: {
	request: ProviderChildInput; inputDirectory: string; evidenceDirectory: string; recordDirectory: string;
	frozenSkillsDirectory: string;
	sourceRunId: string; capabilitySnapshotId: string;
	status?: "succeeded" | "failed" | "cancelled"; error?: string;
	usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number }; toolCalls: number; durationMs: number;
}) : NodeBacktestCaseRef {
	const store = new RunArtifactStore(input.recordDirectory);
	const task = readFileSync(join(input.inputDirectory, "task.md"), "utf-8");
	const stage: AgentStageRequest<unknown> = {
		runId: input.sourceRunId, stageId: `provider-child-${input.request.child_id}`, attemptId: "1", attempt: 1,
		role: "prime_search", promptConfig: { domain: "research", id: "prime-search", sandboxRole: "research.prime_search" as never },
		recordKind: "evaluation", evaluation: { agentId: "provider-child", recipe: { id: "provider-child", version: 1 },
			recipeInput: {}, inputRelativePath: relative(input.recordDirectory, input.inputDirectory), harnessMounts: [], liveExternalState: true },
		session: { key: "provider-child", policy: "fresh" }, modelPolicy: { preferred: [input.request.model], fallback: [], reasoning: input.request.thinking },
		systemPrompt: "", userPrompt: task, workDirectory: input.evidenceDirectory,
		readonlyMounts: [{ hostPath: input.frozenSkillsDirectory, guestPath: "/frozen-skills", access: "read-only" }],
		controlDirectory: input.recordDirectory, recordDirectory: input.recordDirectory, artifactStore: store,
		output: { kind: "source_bundle", publishRelativePath: "result", validate: () => ({}) }, signal: new AbortController().signal,
	};
	const draft = beginNodeEvaluationCase({ request: stage, recordDirectory: input.recordDirectory,
		promptConfig: stage.promptConfig!, sessionContextFile: join(input.recordDirectory, ".no-session"),
		composedSystemPrompt: "", actualModel: input.request.model, capabilitySnapshotId: input.capabilitySnapshotId });
	if (!draft) throw new Error("Provider Child Case capture did not start");
	const artifact = !input.status || input.status === "succeeded"
		? store.publishDirectory(input.evidenceDirectory, "result", input.evidenceDirectory) : undefined;
	// A trace staged outside the Run is copied into the Case, making exported Bundles self-contained.
	const traceStaging = mkdtempSync(join(tmpdir(), "telomi-child-trace-"));
	try {
		const sessionPath = join(traceStaging, "session.jsonl");
		if (existsSync(join(input.evidenceDirectory, "traces", "session.jsonl"))) {
			cpSync(join(input.evidenceDirectory, "traces", "session.jsonl"), sessionPath);
		}
		const capture = finishNodeEvaluationCase(draft, { status: input.status ?? "succeeded", workDirectory: input.evidenceDirectory,
			...(input.error ? { error: input.error } : {}), sessionPath,
			...(artifact ? { result: { value: {}, artifact, submissionCount: 1, validationErrors: [], session: { id: "provider-child", mode: "fresh" },
				turns: input.usage.calls, toolCalls: input.toolCalls, toolCounts: {}, usage: input.usage, sessionPath } } : {}),
			validationErrors: [], durationMs: input.durationMs,
			...(existsSync(join(input.evidenceDirectory, "provider-calls.jsonl"))
				? { providerCallsPath: join(input.evidenceDirectory, "provider-calls.jsonl") } : {}) });
		if (capture.status !== "captured") throw new Error(capture.reason);
		return { sourceRunId: input.sourceRunId, caseId: capture.caseId };
	} finally { rmSync(traceStaging, { recursive: true, force: true }); }
}
