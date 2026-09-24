/**
 * Integration check for the Browser Evolution inner loop.
 *
 * Drives the real EvolutionService, the real Browser Evolution Target, the real inner loop
 * and the real Goal Skill replacement. The Agent session is scripted and the Candidate
 * Replays are a fake Node Backtest Service, so no model, Provider or Browser is involved.
 */
import assert from "node:assert/strict";
import {
	cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { snapshotSkills } from "../../server/agent-runtime/skill-registry.js";
import { sha256 } from "../../server/lib/hash.js";
import type {
	NodeBacktestCaseRef, NodeBacktestRequest, NodeBacktestService,
} from "../../server/evaluation/node-backtest.js";
import { finalizeStageOutput, type AgentStageRequest, type AgentStageRunner, type ValidatedStageArtifact }
	from "../../server/agent-runtime/agent-stage-runtime.js";
import { BROWSER_EVOLUTION_TARGET_ID, createEvolutionTargets } from "../../server/evolution/targets.js";
import { EvolutionService, type EvolutionRun } from "../../server/evolution/service.js";

const SKILL = "prime-browser-provider-skill";
const EXECUTIONS = [
	{ runId: "run-a", caseId: "case-a", executionId: "provider-execution:1:browser:child-1" },
	{ runId: "run-b", caseId: "case-b", executionId: "provider-execution:1:browser:child-2" },
	{ runId: "run-c", caseId: "case-c", executionId: "provider-execution:2:browser:child-3" },
];
const GOAL_ID = "goal_browser_inner_loop";
const REFERENCE_MOUNT = "/stage/skills/provider-workers/browser";

/** Where the scripted Provider child recorded reading the new reference. */
type ReadSite = "browser-child" | "second-browser-child" | "other-provider-child" | "root-trace" | "mention" | "none" | "failed-read" | "wrong-read-hash" | "unpaired-read" | "forged-python-receipt";

/** What one scripted Candidate Replay round should look like. */
interface ReplayPlan {
	/** Skill hash the replayed Provider child recorded loading. Defaults to the real Candidate hash. */
	loadedSha256?: (candidateSha256: string) => string;
	/** Cases whose Candidate Replay execution failed. */
	failedCaseIds?: string[];
	/** Whether the Replay captured a Candidate Case at all. */
	capturesCase?: boolean;
	/** Which Trace records the read. Defaults to the Browser child of this replay. */
	readSite?: ReadSite;
	/** Browser Provider children the replay dispatched. Defaults to one. */
	browserChildCount?: number;
	/** Replay attempts that throw inside Runtime instead of producing Evidence. */
	throwOnAttempts?: number[];
}

interface Harness {
	root: string;
	workspaceDir: string;
	goalDirectory: string;
	goalSkill: string;
	service: EvolutionService;
	enqueued: NodeBacktestRequest[];
	plan: ReplayPlan;
	stop(): void;
}

const CHILD_IDS = { browser: ["sub-b1", "sub-b2"], other: "sub-g1" } as const;

function traceRef(childId: string): string {
	return childId.startsWith("sub-b") ? "output:traces/session.jsonl" : `run:other/${childId}/session.jsonl`;
}
const CONDITIONS_REF = "output:traces/execution-conditions.jsonl";

function assistantToolCall(name: string, path: string): string {
	return JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name, arguments: { path } }] },
	});
}

/** A Trace that only names the reference: a plan, a Prompt echo and a Tool result. */
function mentionsOnly(path: string): string[] {
	return [
		JSON.stringify({ type: "message", message: { role: "assistant",
			content: [{ type: "text", text: `Next I will read ${path}` }] } }),
		JSON.stringify({ type: "message", message: { role: "user",
			content: [{ type: "toolCall", id: "call-x", name: "read", arguments: { path } }] } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: path }] } }),
	];
}

function createHarness(script: AgentScript, options: { goalOverride?: string } = {}): Harness {
	const root = mkdtempSync(join(tmpdir(), "telomi-browser-inner-loop-"));
	const workspaceDir = join(root, "data");
	const goalDirectory = join(workspaceDir, GOAL_ID);
	const goalSkillRoot = join(goalDirectory, "skills", "prime-search");
	mkdirSync(goalSkillRoot, { recursive: true });
	mkdirSync(join(goalDirectory, "wiki", "runs", "old"), { recursive: true });
	writeFileSync(join(goalDirectory, "wiki", "runs", "old", "material.bin"), "Historical source material\n");
	mkdirSync(join(goalDirectory, "wiki", "knowledge"), { recursive: true });
	writeFileSync(join(goalDirectory, "wiki", "knowledge", "current.md"), "Published knowledge\n");
	const goalSkill = join(goalSkillRoot, SKILL);
	if (options.goalOverride !== undefined) {
		mkdirSync(join(goalSkill, "references"), { recursive: true });
		writeFileSync(join(goalSkill, "SKILL.md"), skillMarkdown(options.goalOverride));
	}
	const caseRoot = join(root, "cases");
	for (const [index, execution] of EXECUTIONS.entries()) {
		const directory = join(caseRoot, execution.caseId);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "result.json"), `${JSON.stringify({
			schema_version: 1, provider_id: "browser", terminal_status: "valid_bundle", tool_calls: 1,
			logical_sources: [{ id: "s1", url: "https://example.test/feed/1", providerId: "browser" }],
			execution_records: [{
				execution_id: execution.executionId, provider_id: "browser", terminal_status: "valid_bundle",
				operations: [{ operation: "prime_agent", status: "succeeded" }],
				bundle_ref: `artifacts/source-bundles/${execution.caseId}`,
			}],
		})}\n`);
		writeFileSync(join(directory, "request.json"), `${JSON.stringify({ task: `Read the newest items ${index + 1}.` })}\n`);
		writeFileSync(join(directory, "task.md"), `Read the newest items ${index + 1}.`);
	writeFileSync(join(directory, "child.jsonl"), `${JSON.stringify({ child: execution.executionId })}\n`);
	}
	const plan: ReplayPlan = {};
	const enqueued: NodeBacktestRequest[] = [];
	const replayRoot = join(root, "replays");
	/** Candidate Case files by `<runId>/<executionId>`, exactly as the Case store would list them. */
	const caseFiles = new Map<string, Array<{ ref: string; kind: string; path: string }>>();
	const replayFiles = new Map<string, string>();
	let snapshotSource = "";
	let backtests = 0;
	const replays = new Map<string, ReturnType<typeof materializeReplay>>();

	function materializeReplay(runId: string) {
		const candidateSkill = join(snapshotSource, "skills", "prime-search", SKILL);
		const candidateSha256 = snapshotSkills([candidateSkill]).skills[0]!.sha256;
		const references = existsSync(join(candidateSkill, "references"))
			? readdirSync(join(candidateSkill, "references")).map((name) => `references/${name}`)
			: [];
		const browserChildIds = plan.browserChildCount === 0 ? [] : [CHILD_IDS.browser[plan.readSite === "second-browser-child" ? 1 : 0]];
		const readSite = plan.readSite ?? "browser-child";
		const readChildId = readSite === "second-browser-child" ? CHILD_IDS.browser[1]
			: readSite === "other-provider-child" ? CHILD_IDS.other
				: ["browser-child", "failed-read", "wrong-read-hash", "unpaired-read", "forged-python-receipt"].includes(readSite) ? browserChildIds[0]
					: undefined;
		const executions = EXECUTIONS.map((execution) => {
			const executionId = `candidate_${execution.caseId}_1`;
			const directory = join(replayRoot, runId, executionId);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "result.json"), `${JSON.stringify({
				schema_version: 1, provider_id: "browser", terminal_status: "valid_bundle", tool_calls: 2,
				execution_id: `provider-execution:1:browser:${browserChildIds[0]}`, child_id: browserChildIds[0],
				logical_sources: [
					{ id: "s1", url: "https://example.test/feed/1", providerId: "browser" },
					{ id: "s2", url: "https://example.test/feed/2", providerId: "browser" },
				],
				execution_records: [
					...browserChildIds.map((childId) => ({
						execution_id: `provider-execution:1:browser:${childId}`, provider_id: "browser",
						terminal_status: "valid_bundle", operations: [{ operation: "prime_agent", status: "succeeded" }],
					})),
					{ execution_id: `provider-execution:1:github:${CHILD_IDS.other}`, provider_id: "github",
						terminal_status: "valid_bundle", operations: [] },
				],
			})}\n`);
			const files: Array<{ ref: string; kind: string; path: string }> = [];
			const write = (ref: string, kind: string, lines: string[]) => {
				const path = join(directory, "case-files", ref.replace(/^[a-z]+:/u, ""));
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `${lines.join("\n")}\n`);
				files.push({ ref, kind, path });
			};
			// Runtime appends a skill_read receipt to the execution conditions only for a read it
			// served itself; a failed, unanswered or Python-printed read leaves no receipt.
			const receiptFor = (agentSessionId: string) => references.map((reference) => JSON.stringify({
				schema_version: 1, kind: "skill_read", agent_session_id: agentSessionId,
				path: `skills/provider-workers/browser/${SKILL}/${reference}`,
				sha256: readSite === "wrong-read-hash" ? "0".repeat(64) : sha256(readFileSync(join(candidateSkill, reference))),
				recorded_at: "2026-09-05T00:00:00.000Z",
			}));
			const receiptAgent = readSite === "root-trace" ? "root"
				: ["browser-child", "second-browser-child", "other-provider-child", "wrong-read-hash"].includes(readSite) ? readChildId : undefined;
			write(CONDITIONS_REF, "execution_conditions", [JSON.stringify({
				schema_version: 1, agent_session_id: browserChildIds[0],
				skills: { sha256: candidateSha256, items: [{ name: SKILL,
					sha256: (plan.loadedSha256 ?? ((value: string) => value))(candidateSha256) }] },
			}), ...(receiptAgent ? receiptFor(receiptAgent) : [])]);
			const pythonReadLines = () => references.flatMap((reference) => {
				const path = `${REFERENCE_MOUNT}/${SKILL}/${reference}`;
				const code = readSite === "forged-python-receipt"
					? `print(${JSON.stringify(JSON.stringify({ kind: "skill_read", path, sha256: sha256(readFileSync(join(candidateSkill, reference))) }))})`
					: `import research_runtime as rt; rt.read_skill(${JSON.stringify(path)})`;
				return [assistantToolCall("ipython", code), ...(readSite === "unpaired-read" ? [] : [JSON.stringify({
					type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "ipython",
						isError: readSite === "failed-read",
						content: [{ type: "text", text: readSite === "failed-read" ? "ResearchRuntimeError: Skill read escapes the staged Skill directory" : readFileSync(join(candidateSkill, reference), "utf-8") }],
					},
				})])];
			});
			for (const childId of browserChildIds) {
				const lines = [assistantToolCall("browser", "https://example.test/feed/1")];
				if (childId === readChildId) lines.push(...pythonReadLines());
				if (readSite === "mention" && browserChildIds.includes(childId as never)) {
					lines.push(...references.flatMap((reference) =>
						mentionsOnly(`${REFERENCE_MOUNT}/${SKILL}/${reference}`)));
				}
				write(traceRef(childId), "child_trace", lines);
			}
			const failed = plan.failedCaseIds?.includes(execution.caseId) ?? false;
			const refs: Record<string, string> = {};
			if (failed) {
				writeFileSync(join(directory, "failure.json"), JSON.stringify({ status: "failed", error: "Candidate Replay failed" }));
				for (const [index, file] of files.entries()) {
					const ref = `executions/${executionId}/partial/${index + 1}.jsonl`;
					refs[file.kind === "child_trace" ? `childTrace${index + 1}` : `trace${index + 1}`] = ref;
					replayFiles.set(`${runId}/${ref}`, file.path);
				}
			}
			if (!failed && plan.capturesCase !== false) caseFiles.set(`${runId}/${executionId}`, files);
			return {
				id: executionId,
				caseRef: { sourceRunId: execution.runId, caseId: execution.caseId },
				repetition: 1,
				variant: "candidate" as const,
				status: failed ? "failed" as const : "completed" as const,
				...(failed ? { error: "Candidate Replay failed", refs } : {}),
				...(failed || plan.capturesCase === false ? {} : {
					candidateCaseRef: { sourceRunId: runId, caseId: executionId },
				}),
				artifact: { ref: `executions/${executionId}/${failed ? "failure" : "result"}.json`, sha256: "", byteLength: 0, directory: !failed },
				metrics: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1, turns: 1, toolCalls: 2, durationMs: 10 },
			};
		});
		return {
			id: runId,
			status: executions.some((execution) => execution.status === "failed") ? "failed" : "awaiting_evaluation",
			...(executions.some((execution) => execution.status === "failed") ? { error: "Candidate Replay failed" } : {}),
			executions,
		};
	}

	const nodeBacktests = {
		ensureProviderChildCase: async (_goalId: string, ref: NodeBacktestCaseRef, executionId: string) => {
			assert.ok(executionId);
			return ref;
		},
		readCase: (_goalId: string, ref: NodeBacktestCaseRef) => ({
			agentId: "provider-child",
			nodeId: `prime-search-batch-${ref.caseId}`,
			capturedAt: "2026-09-05T00:00:00.000Z",
		}),
		listCaseFiles: (_goalId: string, ref: NodeBacktestCaseRef) => ref.caseId.startsWith("candidate_")
			? (caseFiles.get(`${ref.sourceRunId}/${ref.caseId}`) ?? [])
				.map(({ ref: fileRef, kind }) => ({ ref: fileRef, kind, sha256: "", byteLength: 0 }))
			: [
				{ ref: "output:result.json", kind: "observed_output", sha256: "", byteLength: 0 },
				{ ref: traceRef("child-1"), kind: "child_trace", sha256: "", byteLength: 0 },
			],
		listCaseFilePaths(goalId: string, ref: NodeBacktestCaseRef) {
			return (this as any).listCaseFiles(goalId, ref).map((file: { ref: string }) =>
				({ ...file, absolutePath: (this as any).caseFile(goalId, ref, file.ref) }));
		},
		caseFile: (_goalId: string, ref: NodeBacktestCaseRef, fileRef: string) => {
			if (!ref.caseId.startsWith("candidate_")) {
				return join(caseRoot, ref.caseId, fileRef === "output:result.json" ? "result.json" : "child.jsonl");
			}
			const file = (caseFiles.get(`${ref.sourceRunId}/${ref.caseId}`) ?? []).find((item) => item.ref === fileRef);
			if (!file) throw new Error(`Unknown Candidate Case file '${fileRef}'`);
			return file.path;
		},
		caseInputFile: (_goalId: string, ref: NodeBacktestCaseRef, path: string) => join(caseRoot, ref.caseId, path),
		artifactFile: (_goalId: string, runId: string, executionId: string, relativeFile?: string) => {
			const execution = replays.get(runId)!.executions.find((item) => item.id === executionId)!;
			if (!execution.artifact.directory) assert.equal(relativeFile, undefined, "File artifacts reject nested paths");
			return join(replayRoot, runId, executionId, relativeFile ?? "failure.json");
		},
		replayFile: (_goalId: string, runId: string, ref: string) => {
			const path = replayFiles.get(`${runId}/${ref}`);
			if (!path) throw new Error(`Unknown Node Backtest file ref '${ref}'`);
			return path;
		},
		createCapabilitySnapshot: (_goalId: string, sourceDirectory: string) => {
			assert.equal(existsSync(join(sourceDirectory, "wiki", "runs")), false,
				"Evolution must not pre-copy Wiki Run history before creating a Capability Snapshot");
			assert.equal(readFileSync(join(sourceDirectory, "wiki", "knowledge", "current.md"), "utf-8"), "Published knowledge\n");
			snapshotSource = sourceDirectory;
			return { id: `cap-${++backtests}` };
		},
		enqueue: (_goalId: string, request: NodeBacktestRequest) => {
			enqueued.push(request);
			if (plan.throwOnAttempts?.includes(enqueued.length)) {
				throw new Error(`Node Backtest queue rejected attempt ${enqueued.length}`);
			}
			const runId = `nodebt-${enqueued.length}`;
			replays.set(runId, materializeReplay(runId));
			return { id: runId };
		},
		read: (_goalId: string, runId: string) => replays.get(runId),
	} as unknown as NodeBacktestService;

	const service = new EvolutionService({
		workspaceDir,
		listGoalIds: () => [GOAL_ID],
		targets: createEvolutionTargets({ modelPolicy: { preferred: ["openai-codex/gpt-5.6-terra"], fallback: [], reasoning: "high" }, workspaceDir, nodeBacktests, stageRunner: scriptedRunner(script) }),
	});
	return {
		root, workspaceDir, goalDirectory, goalSkill, service, enqueued, plan,
		stop: () => { service.stop(); rmSync(root, { recursive: true, force: true }); },
	};
}

type AgentScript = (context: {
	replay: (intent: string) => Promise<{ text: string; view: Record<string, unknown> }>;
	packageRoot: string;
	request: AgentStageRequest<unknown>;
}) => Promise<void>;

/** Runs one scripted Agent session against the real Stage output finalization. */
function scriptedRunner(script: AgentScript): AgentStageRunner {
	return {
		async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
			const tool = (request.additionalTools ?? []).find((item) => item.name === "run_browser_replay") as AgentTool;
			assert.ok(tool, "the Browser Evolution Agent must receive run_browser_replay");
			const packageRoot = join(request.workDirectory, "candidate-package");
			await script({
				packageRoot,
				request: request as AgentStageRequest<unknown>,
				replay: async (intent) => {
					const result = await tool.execute("call", { intent });
					const text = result.content.map((item) => "text" in item ? item.text : "").join("");
					let view: Record<string, unknown> = {};
					try { view = JSON.parse(text) as Record<string, unknown>; } catch { view = {}; }
					return { text, view };
				},
			});
			const finalized = await finalizeStageOutput({
				artifactStore: request.artifactStore,
				output: request.output,
				workDirectory: request.workDirectory,
			});
			return {
				value: finalized.value,
				artifact: finalized.artifact,
				submissionCount: 1,
				validationErrors: [],
				session: { id: "scripted", mode: "fresh" },
				turns: 1,
				toolCalls: 1,
				toolCounts: {},
				usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
				sessionPath: join(request.workDirectory, "scripted-session.jsonl"),
			};
		},
	};
}

function skillMarkdown(body: string, references: string[] = []): string {
	return [
		"---",
		`name: ${SKILL}`,
		"description: Browser Provider Skill for authenticated and dynamic website exploration.",
		"---",
		"",
		body,
		...references.map((reference) => `- Read \`${reference}\` when the page is an infinite-scroll feed.`),
		"",
	].join("\n");
}

/** The Agent edit every passing scenario makes: one new reference plus its conditional index. */
function addReference(packageRoot: string, name = "dynamic-feeds.md"): void {
	const skill = join(packageRoot, SKILL);
	mkdirSync(join(skill, "references"), { recursive: true });
	writeFileSync(join(skill, "references", name), "# Dynamic feeds\n\nScroll until the item count stops growing.\n");
	writeFileSync(join(skill, "SKILL.md"), skillMarkdown("Explore the page, then materialize sources.", [`references/${name}`]));
}

/** The Agent's declaration of one reference it changed, as `outcome.json` carries it. */
function declared(path: string, state: "added" | "modified" = "added") {
	return { path, state, trigger: "The page loads more items on scroll instead of paginating." };
}

function writeOutcome(
	packageRoot: string,
	outcome: "confirmed" | "no_change",
	references = [declared("references/dynamic-feeds.md")],
): void {
	writeFileSync(join(packageRoot, "outcome.json"), `${JSON.stringify({
		schema_version: 1,
		outcome,
		skill_name: SKILL,
		summary: "Index a dynamic-feed reference conditionally.",
		scenario_class: "Infinite-scroll feeds, shown by all three executions.",
		generalization: "The rule keys on scroll-driven pagination, not on any URL.",
		improvement: "Each replay materialized the second page of the feed.",
		regression_risk: "The non-feed replay kept its Observed source set.",
		remaining_risk: "Feeds behind a login are untested.",
		references,
	}, null, 2)}\n`);
}

async function settle(service: EvolutionService, runId: string): Promise<EvolutionRun> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const run = service.read(GOAL_ID, runId);
		if (["applied", "no_change", "failed", "cancelled"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Evolution Run never settled");
}

function startBrowserEvolution(harness: Harness): Promise<EvolutionRun> {
	const started = harness.service.start(GOAL_ID, {
		targetId: BROWSER_EVOLUTION_TARGET_ID,
		objective: "Improve the Browser Provider Skill for the scenarios these three executions show.",
		acceptanceCriteria: ["Every rule generalizes to the scenario class"],
		evidenceRefs: EXECUTIONS.map((execution) => ({ kind: "browser_provider_execution", ...execution })),
	});
	return settle(harness.service, started.id);
}

// 1. Confirmed: one passing round auto-applies the Skill and keeps the prior override recoverable.
{
	const harness = createHarness(async ({ packageRoot, replay, request }) => {
		addReference(packageRoot);
		const round = await replay("Index a dynamic-feed reference and replay all three Cases.");
		assert.equal(round.view.passed, true, round.text);
		const mount = request.readonlyMounts?.find((item) => item.guestPath === "/replays");
		assert.ok(mount, "Evolution must be able to read its full replay evidence");
		assert.equal(mount.access, "read-only");
		assert.equal(round.view.record, "/replays/1/round.json");
		const manifest = JSON.parse(readFileSync(join(mount.hostPath, "1/manifest.json"), "utf8"));
		assert.equal(manifest.cases.length, 3);
		for (const item of manifest.cases) {
			assert.ok(item.files.some((file: { kind: string }) => file.kind === "child_trace"));
			assert.ok(item.files.some((file: { kind: string }) => file.kind === "result"));
			for (const file of item.files) assert.ok(readFileSync(join(mount.hostPath, file.path.slice("/replays/".length))).length > 0);
		}
		writeOutcome(packageRoot, "confirmed");
	}, { goalOverride: "Explore the page, then materialize sources." });
	try {
		const beforeSha256 = snapshotSkills([harness.goalSkill]).skills[0]!.sha256;
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "applied", run.error ?? "");
		assert.equal(run.innerLoop?.outcome, "confirmed");
		assert.equal(run.innerLoop?.rounds.length, 1);

		// Every round replays exactly the three historical Prime Search Cases, Candidate Skill only.
		assert.equal(harness.enqueued.length, 1);
		assert.deepEqual(harness.enqueued[0], {
			agentId: "provider-child",
			cases: EXECUTIONS.map((execution) => ({ sourceRunId: execution.runId, caseId: execution.caseId })),
			candidate: { capabilitySnapshotId: "cap-1" },
			repetitions: 1,
			rubricId: "provider-child-browser-v1",
		});

		// Immutable per-round Evidence.
		const round = JSON.parse(readFileSync(join(run.directory, "rounds", "1", "round.json"), "utf-8")) as
			Record<string, any>;
		assert.equal(round.passed, true);
		assert.equal(run.candidate?.skillName, SKILL);
		assert.deepEqual(round.candidate.changedReferences, ["references/dynamic-feeds.md"]);
		assert.equal(round.replay.nodeBacktestRunId, "nodebt-1");
		assert.deepEqual(round.gates.map((gate: { id: string }) => gate.id),
			["three-replays-valid", "candidate-skill-loaded", "browser-child-trace-located", "reference-activated"]);
		assert.equal(round.gates.every((gate: { passed: boolean }) => gate.passed), true);
		assert.equal(round.cases.length, 3);
		for (const value of round.cases) {
			assert.equal(value.loadedSkill.sha256, round.candidate.sha256, "each replay pins the exact Candidate hash");
			assert.deepEqual(value.browserChildren.map((child: { executionId: string }) => child.executionId),
				["provider-execution:1:browser:sub-b1"], "only Browser children of this replay carry evidence");
			assert.equal(value.referenceReads.length, 1);
			assert.deepEqual(value.referenceReads[0], {
				referencePath: "references/dynamic-feeds.md",
				executionId: "provider-execution:1:browser:sub-b1",
				childId: "sub-b1",
				traceRef: CONDITIONS_REF,
				line: 2,
				toolName: "research_runtime.read_skill",
			}, "the read is located to the Browser child and the Runtime receipt line");
			assert.deepEqual(value.traceRefs, [traceRef("sub-b1")], "no Root or other Provider Trace counts");
			assert.ok(value.artifactRef);
			assert.equal(value.diff.observed.tool_calls, 1);
			assert.equal(value.diff.candidate.tool_calls, 2);
			assert.equal(value.diff.candidate.terminal_status, "valid_bundle");
		}
		assert.throws(() => writeFileSync(join(run.directory, "rounds", "1", "round.json"), "x", { flag: "wx" }),
			"round Evidence is immutable");

		// The Goal Skill was replaced by the exact confirmed Candidate.
		const afterSha256 = snapshotSkills([harness.goalSkill]).skills[0]!.sha256;
		assert.equal(afterSha256, round.candidate.sha256);
		assert.notEqual(afterSha256, beforeSha256);
		assert.ok(existsSync(join(harness.goalSkill, "references", "dynamic-feeds.md")));

		// The prior override survives as a recoverable before/ snapshot.
		const snapshot = join(run.directory, "before", SKILL);
		assert.equal(snapshotSkills([snapshot]).skills[0]!.sha256, beforeSha256);

		// The apply intent is durable and the Receipt finalizes it.
		const intent = JSON.parse(readFileSync(join(run.directory, "apply-intent.json"), "utf-8")) as Record<string, any>;
		assert.equal(intent.phase, "prepared");
		assert.equal(intent.before.skillSha256, beforeSha256);
		assert.equal(intent.candidateSha256, round.candidate.sha256);
		const receipt = JSON.parse(readFileSync(join(run.directory, "apply-receipt.json"), "utf-8")) as Record<string, any>;
		assert.equal(receipt.skillName, SKILL);
		assert.equal(receipt.before.skillSha256, beforeSha256);
		assert.equal(receipt.before.source, "goal_override");
		assert.equal(receipt.before.snapshotRelativePath, `before/${SKILL}`);
		assert.equal(receipt.after.skillSha256, afterSha256);
		assert.equal(receipt.candidateSha256, round.candidate.sha256);
		assert.deepEqual(receipt.replayRunIds, ["nodebt-1"]);
		assert.equal(receipt.restore, "restore_before_snapshot");
		assert.deepEqual(receipt, run.apply);

		// The replacement is one rename: no staging directory is left behind.
		assert.deepEqual(readdirSync(join(harness.goalDirectory, "skills", "prime-search")), [SKILL]);
		console.log("Browser Evolution confirms one replayed Candidate and applies it with crash recovery");
	} finally {
		harness.stop();
	}
}

// 2. no_change mutates nothing.
{
	const harness = createHarness(async ({ packageRoot, replay }) => {
		addReference(packageRoot);
		await replay("Try a dynamic-feed reference.");
		writeOutcome(packageRoot, "no_change");
	}, { goalOverride: "Explore the page, then materialize sources." });
	try {
		const beforeSha256 = snapshotSkills([harness.goalSkill]).skills[0]!.sha256;
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "no_change", run.error ?? "");
		assert.equal(run.innerLoop?.outcome, "no_change");
		assert.equal(run.apply, undefined);
		assert.equal(existsSync(join(run.directory, "apply-intent.json")), false, "no_change prepares no apply");
		assert.equal(existsSync(join(run.directory, "apply-receipt.json")), false, "no_change writes no Apply Receipt");
		assert.equal(existsSync(join(run.directory, "before")), false, "no_change takes no before snapshot");
		assert.equal(existsSync(join(run.directory, "candidate.json")), false);
		assert.equal(snapshotSkills([harness.goalSkill]).skills[0]!.sha256, beforeSha256,
			"no_change makes no Goal Skill mutation");
		console.log("Browser Evolution no_change leaves the Goal Skill and the Apply Receipt untouched");
	} finally {
		harness.stop();
	}
}

// 3. The fourth replay call is refused, and the Run still finishes.
{
	const refusals: string[] = [];
	const harness = createHarness(async ({ packageRoot, replay }) => {
		addReference(packageRoot);
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const round = await replay(`Round ${attempt}`);
			if (round.view.round === undefined) refusals.push(round.text);
		}
		writeOutcome(packageRoot, "no_change", [declared("references/dynamic-feeds.md", "modified")]);
	});
	try {
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "no_change", run.error ?? "");
		assert.equal(harness.enqueued.length, 3, "one Evolution Run replays at most three rounds");
		assert.equal(run.innerLoop?.rounds.length, 3);
		assert.equal(refusals.length, 1);
		assert.match(refusals[0]!, /exhausted/u);
		assert.equal(existsSync(join(run.directory, "rounds", "4")), false);
		console.log("Browser Evolution refuses a fourth run_browser_replay call");
	} finally {
		harness.stop();
	}
}

// 4. A round Runtime could not complete is still a round, and a retry still succeeds.
{
	const outcomes: Array<{ round: unknown; passed: unknown; error: unknown }> = [];
	const harness = createHarness(async ({ packageRoot, replay }) => {
		addReference(packageRoot);
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const view = (await replay(`Attempt ${attempt}`)).view;
			outcomes.push({ round: view.round, passed: view.passed, error: view.error });
		}
		writeOutcome(packageRoot, "no_change");
	}, { goalOverride: "Explore the page, then materialize sources." });
	try {
		Object.assign(harness.plan, { throwOnAttempts: [1] } satisfies ReplayPlan);
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "no_change", run.error ?? "");
		assert.deepEqual(outcomes.map((item) => item.round), [1, 2, 3, undefined],
			"a failed invocation spends its round, and the fourth call is refused");
		assert.deepEqual(outcomes.map((item) => item.passed), [false, true, true, undefined]);
		assert.match(String(outcomes[0]!.error), /queue rejected attempt 1/u);
		assert.equal(run.innerLoop?.rounds.length, 3);
		const failed = JSON.parse(readFileSync(join(run.directory, "rounds", "1", "round.json"), "utf-8")) as
			Record<string, any>;
		assert.equal(failed.passed, false);
		assert.match(failed.error, /queue rejected attempt 1/u);
		assert.deepEqual(failed.gates.map((gate: { id: string }) => gate.id), ["replay-round-completed"]);
		assert.ok(existsSync(join(run.directory, "rounds", "2", "round.json")), "the retry records its own round");
		console.log("Browser Evolution spends a round on a Runtime failure and still lets the retry run");
	} finally {
		harness.stop();
	}
}

// 5. Hard gates. Each scenario confirms, is refused by Runtime, and then finishes as no_change.
for (const scenario of [
	{ name: "a failed Skill read", plan: { readSite: "failed-read" } as ReplayPlan, gate: "reference-activated" },
	{ name: "a Skill read with another file hash", plan: { readSite: "wrong-read-hash" } as ReplayPlan, gate: "reference-activated" },
	{ name: "a Skill call without a result", plan: { readSite: "unpaired-read" } as ReplayPlan, gate: "reference-activated" },
	{ name: "a read receipt printed by Python", plan: { readSite: "forged-python-receipt" } as ReplayPlan, gate: "reference-activated" },
	{
		name: "a replay that did not complete",
		plan: { failedCaseIds: ["case-b"] } as ReplayPlan,
		gate: "three-replays-valid",
	},
	{
		name: "a replay that loaded another Skill",
		plan: { loadedSha256: () => "0".repeat(64) } as ReplayPlan,
		gate: "candidate-skill-loaded",
	},
	{
		name: "a replay that captured no Case",
		plan: { capturesCase: false } as ReplayPlan,
		gate: "candidate-skill-loaded",
	},
	{
		name: "a reference only named in a Trace",
		plan: { readSite: "mention" } as ReplayPlan,
		gate: "reference-activated",
	},
	{
		name: "a reference read by the Root Agent",
		plan: { readSite: "root-trace" } as ReplayPlan,
		gate: "reference-activated",
	},
	{
		name: "a reference read by another Provider's child",
		plan: { readSite: "other-provider-child" } as ReplayPlan,
		gate: "reference-activated",
	},
	{
		name: "a new reference nothing read",
		plan: { readSite: "none" } as ReplayPlan,
		gate: "reference-activated",
	},
	{
		name: "a replay that dispatched no Browser child",
		plan: { browserChildCount: 0 } as ReplayPlan,
		gate: "browser-child-trace-located",
	},
]) {
	const rejected: string[] = [];
	const harness = createHarness(async ({ packageRoot, replay, request }) => {
		addReference(packageRoot);
		const round = await replay("Replay the three Cases.");
		if (scenario.plan.failedCaseIds) {
			const mount = request.readonlyMounts.find((item) => item.guestPath === "/replays")!;
			const manifest = JSON.parse(readFileSync(join(mount.hostPath, "1/manifest.json"), "utf-8")) as {
				cases: Array<{ case: NodeBacktestCaseRef; status: string; files: Array<{ ref: string; path: string }> }>;
			};
			const failedCase = manifest.cases.find((item) => item.case.caseId === "case-b")!;
			assert.equal(failedCase.status, "failed");
			const contents = failedCase.files.map((file) => readFileSync(
				join(mount.hostPath, file.path.slice("/replays/".length)), "utf-8"));
			assert.ok(contents.some((content) => content.includes('"status":"failed"')
				&& content.includes("Candidate Replay failed")), "Failed Case must publish its failure artifact without a Candidate Case");
			assert.ok(contents.some((content) => content.includes('"name":"browser"')),
				"Failed Case must publish its retained child Trace through the replayFile allowlist");
		}
		assert.equal(round.view.passed, false, `${scenario.name} must fail its hard gate`);
		const failed = (round.view.gates as Array<{ id: string; passed: boolean }>)
			.filter((gate) => !gate.passed).map((gate) => gate.id);
		assert.ok(failed.includes(scenario.gate), `${scenario.name}: expected ${scenario.gate}, got ${failed.join(", ")}`);
		writeOutcome(packageRoot, "confirmed");
		const error = message(() => validateSubmission(request, packageRoot));
		assert.match(error, /last replay round to pass every hard check/u, scenario.name);
		assert.ok(error.includes(scenario.gate), `${scenario.name}: rejection must name the failed gate, got ${error}`);
		rejected.push(scenario.gate);
		writeOutcome(packageRoot, "no_change");
	}, { goalOverride: "Explore the page, then materialize sources." });
	try {
		Object.assign(harness.plan, scenario.plan);
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "no_change", `${scenario.name}: ${run.error ?? ""}`);
		assert.equal(run.apply, undefined);
		assert.equal(existsSync(join(run.directory, "apply-receipt.json")), false);
		assert.deepEqual(rejected, [scenario.gate]);
		assert.equal(snapshotSkills([harness.goalSkill]).skills[0]!.sha256,
			snapshotSkills([join(run.directory, "baseline", SKILL)]).skills[0]!.sha256,
			`${scenario.name}: a refused confirm mutates no Goal Skill`);
		console.log(`Browser Evolution refuses to confirm ${scenario.name}`);
	} finally {
		harness.stop();
	}
}

// 6. A selected later Browser child retains its own execution identity.
{
	const harness = createHarness(async ({ packageRoot, replay }) => {
		addReference(packageRoot);
		const round = await replay("Replay the three Cases.");
		assert.equal(round.view.passed, true, round.text);
		writeOutcome(packageRoot, "confirmed");
	}, { goalOverride: "Explore the page, then materialize sources." });
	try {
		Object.assign(harness.plan, { browserChildCount: 2, readSite: "second-browser-child" } satisfies ReplayPlan);
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "applied", run.error ?? "");
		const round = JSON.parse(readFileSync(join(run.directory, "rounds", "1", "round.json"), "utf-8")) as
			Record<string, any>;
		for (const value of round.cases) {
			assert.deepEqual(value.browserChildren.map((child: { executionId: string }) => child.executionId),
				["provider-execution:1:browser:sub-b2"]);
			assert.deepEqual(value.referenceReads.map((read: { childId: string }) => read.childId), ["sub-b2"],
				"the read belongs to the Browser child whose Trace recorded it");
			assert.deepEqual(value.traceRefs, [traceRef("sub-b2")]);
		}
		console.log("Browser Evolution credits a reference read to the exact Browser child that made it");
	} finally {
		harness.stop();
	}
}

// 7. A submission must match what actually ran and what actually changed.
{
	const errors: string[] = [];
	const harness = createHarness(async ({ packageRoot, replay, request }) => {
		writeOutcome(packageRoot, "confirmed", []);
		errors.push(message(() => validateSubmission(request, packageRoot)));
		addReference(packageRoot);
		assert.equal((await replay("Replay the three Cases.")).view.passed, true);
		// The Agent's account of what it changed is checked against the tree it submits: an
		// undeclared reference and a declared reference it never touched are both refused.
		writeOutcome(packageRoot, "confirmed", []);
		errors.push(message(() => validateSubmission(request, packageRoot)));
		writeOutcome(packageRoot, "confirmed",
			[declared("references/dynamic-feeds.md"), declared("references/never-written.md")]);
		errors.push(message(() => validateSubmission(request, packageRoot)));
		writeFileSync(join(packageRoot, SKILL, "references", "dynamic-feeds.md"), "# Edited after the replay\n");
		writeOutcome(packageRoot, "confirmed");
		errors.push(message(() => validateSubmission(request, packageRoot)));
		writeOutcome(packageRoot, "no_change");
	}, { goalOverride: "Explore the page, then materialize sources." });
	try {
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "no_change", run.error ?? "");
		assert.match(errors[0]!, /at least one run_browser_replay round/u);
		assert.match(errors[1]!, /declares none but the Candidate Skill changed references\/dynamic-feeds\.md \(added\)/u);
		assert.match(errors[2]!, /references\/never-written\.md \(added\)/u);
		assert.match(errors[3]!, /changed after round 1/u);
		console.log("Browser Evolution requires a replay of exactly the Skill it confirms, declared as it changed");
	} finally {
		harness.stop();
	}
}

// 8. Without a prior Goal override the bundled Skill stays recoverable by removing the override.
{
	const harness = createHarness(async ({ packageRoot, replay }) => {
		// The bundled Skill already ships references/dynamic-feeds.md, so this Candidate adds another one.
		addReference(packageRoot, "paginated-archives.md");
		const round = await replay("Replay the three Cases.");
		assert.equal(round.view.passed, true, round.text);
		writeOutcome(packageRoot, "confirmed", [declared("references/paginated-archives.md")]);
	});
	try {
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "applied", run.error ?? "");
		const receipt = run.apply!;
		assert.equal(receipt.before.source, "bundled");
		assert.equal(receipt.before.snapshotRelativePath, null);
		assert.equal(receipt.restore, "remove_goal_override");
		assert.equal(receipt.before.skillSha256,
			snapshotSkills([join(run.directory, "baseline", SKILL)]).skills[0]!.sha256);
		assert.ok(existsSync(join(harness.goalSkill, "references", "paginated-archives.md")));
		console.log("Browser Evolution records how to recover a Goal that had no override");
	} finally {
		harness.stop();
	}
}

// 9. A rewritten reference activates exactly like an added one: the gate compares bytes, not paths.
{
	const harness = createHarness(async ({ packageRoot, replay }) => {
		// No Goal override, so the baseline is the bundled Skill and it already ships this reference.
		addReference(packageRoot, "dynamic-feeds.md");
		const round = await replay("Rewrite the dynamic-feed reference and replay all three Cases.");
		assert.equal(round.view.passed, true, round.text);
		writeOutcome(packageRoot, "confirmed", [declared("references/dynamic-feeds.md", "modified")]);
	});
	try {
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "applied", run.error ?? "");
		const round = JSON.parse(readFileSync(join(run.directory, "rounds", "1", "round.json"), "utf-8")) as
			Record<string, any>;
		assert.deepEqual(round.candidate.changedReferences, ["references/dynamic-feeds.md"],
			"a reference whose bytes changed counts even though its path is in the baseline");
		assert.equal(round.gates.find((gate: { id: string }) => gate.id === "reference-activated").passed, true);
		console.log("Browser Evolution activates a reference the Candidate rewrote rather than added");
	} finally {
		harness.stop();
	}
}

// 10. A Candidate that changed no reference cannot pass the gate, so it must not cost a round.
{
	const refusals: string[] = [];
	const harness = createHarness(async ({ packageRoot, replay }) => {
		refusals.push((await replay("Replay the untouched baseline as a control.")).text);
		addReference(packageRoot);
		const round = await replay("Index a dynamic-feed reference and replay all three Cases.");
		assert.equal(round.view.round, 1, "the refused call left the round budget untouched");
		assert.equal(round.view.passed, true, round.text);
		writeOutcome(packageRoot, "confirmed");
	}, { goalOverride: "Explore the page, then materialize sources." });
	try {
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "applied", run.error ?? "");
		assert.equal(run.innerLoop?.rounds.length, 1);
		assert.match(refusals[0]!, /at least one reference whose bytes differ/u);
		assert.equal(existsSync(join(run.directory, "rounds", "2")), false,
			"the refused call recorded no round Evidence");
		console.log("Browser Evolution refuses an unchanged Candidate without spending a round");
	} finally {
		harness.stop();
	}
}

// 11. A Candidate too malformed to inspect still reaches the round that reports it.
{
	const harness = createHarness(async ({ packageRoot, replay }) => {
		addReference(packageRoot);
		renameSync(join(packageRoot, SKILL), join(packageRoot, "renamed-skill"));
		const refused = await replay("Replay a Candidate whose Skill directory was renamed.");
		assert.equal(refused.view.passed, false, refused.text);
		assert.match(String(refused.view.error), /must stay one Skill directory/u);
		renameSync(join(packageRoot, "renamed-skill"), join(packageRoot, SKILL));
		writeOutcome(packageRoot, "no_change");
	}, { goalOverride: "Explore the page, then materialize sources." });
	try {
		const run = await startBrowserEvolution(harness);
		assert.equal(run.status, "no_change", run.error ?? "");
		assert.equal(run.innerLoop?.rounds.length, 1, "a malformed Candidate spends its round, as it always did");
		console.log("Browser Evolution reports a malformed Candidate as a spent round, not an uncaught throw");
	} finally {
		harness.stop();
	}
}

/** The Runtime gate an Agent submission must clear, run exactly as the Stage output does. */
function validateSubmission(request: AgentStageRequest<unknown>, packageRoot: string): unknown {
	return request.output.validate({
		entryPath: join(packageRoot, "outcome.json"),
		outputRoot: packageRoot,
		workDirectory: request.workDirectory,
	});
}

function message(action: () => unknown): string {
	try {
		action();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
