import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";

import type { ResearchModelUsage } from "../../agent-runtime/model-usage.js";
import { primeAgentModulePath, primeKernelPython } from "../../agent-runtime/prime-agent-paths.js";
import { snapshotSkills } from "../../agent-runtime/skill-registry.js";
import { preparePythonSkillEnvironment } from "../../agent-runtime/python-environment.js";
import { resolveDataDir } from "../../config/data-dir.js";
import { listFilesRecursive } from "../../lib/fs.js";
import type { ResearchSourceCatalogEntry } from "../../providers/search-types.js";
import { effectiveProviderWorkerSkills } from "../../agent-runtime/provider-skills.js";
import { browserToolClientConfigFromEnv } from "../../providers/browser/tool-router.js";
import { providerCallsPath } from "../../providers/provider-call-record.js";
import type { ResearchHarnessSnapshot } from "../harness/snapshot.js";
import type { ResearchTemporalContext } from "../research-types.js";
import type { ResearchSourceRegistry } from "../sources/registry.js";
import { runPrime, stageProviderSdk, stageProviderWorkerSkills, startPrimeSourceBridge } from "./prime-search-batch.js";
import { validatePrimeSearchCandidateLedger } from "./prime-search-contract.js";
import { providerExecutionWorkspace } from "./provider-execution-workspace.js";
import { providerToolRuntime } from "./provider-tool-runtime.js";

export interface ProviderChildReplayRequest {
	registry: ResearchSourceRegistry;
	harness: ResearchHarnessSnapshot;
	recordDirectory: string;
	goalId: string;
	runId: string;
	task: string;
	providerId: string;
	model: string;
	thinking: string;
	serviceTier: "default" | "priority" | "flex";
	temporalContext: ResearchTemporalContext;
	initialWorkspace: string;
	frozenSkillsDirectory: string;
	signal: AbortSignal;
	env?: NodeJS.ProcessEnv;
	skillWorkspaceDirectory?: string;
}

export interface ProviderChildReplayResult {
	workspaceRoot: string;
	skillsDirectory: string;
	childId: string;
	tracePath: string;
	conditionsPath: string;
	providerCallsPath: string;
	ledgerPath: string;
	systemPromptPath?: string;
	usage: ResearchModelUsage;
	toolCalls: number;
	durationMs: number;
}

/** Replay a frozen Provider task with the production bridge, sandbox and Ledger contract. */
export async function executeProviderChildReplay(request: ProviderChildReplayRequest): Promise<ProviderChildReplayResult> {
	const startedAt = Date.now();
	const env = request.env ?? process.env;
	const source = request.registry.catalog().find((entry) => entry.id === request.providerId);
	if (!source || source.id === "general_web") throw new Error(`Unknown child Provider '${request.providerId}'`);
	const slash = request.model.indexOf("/");
	if (slash <= 0 || slash === request.model.length - 1) throw new Error("Provider child model must be provider/model");
	if (!request.task.trim()) throw new Error("Provider child task is empty");
	const root = join(request.recordDirectory, "agent");
	const runtimeRoot = join(request.recordDirectory, "runtime");
	if (existsSync(root)) throw new Error("Provider child replay requires a fresh record directory");
	mkdirSync(root, { recursive: true });
	mkdirSync(runtimeRoot, { recursive: true });
	const childId = `sub-${randomUUID()}`;
	const skills = new Map(request.harness.agentSkills["prime-search"].skills.map((asset) => [
		asset.name, request.skillWorkspaceDirectory ? join(request.skillWorkspaceDirectory, "prime-search", asset.name) : asset.sourcePath,
	]));
	const { skillsDirectory, skillRoots } = stageProviderChildSkills(root, request.frozenSkillsDirectory,
		source, effectiveProviderWorkerSkills([source], skills), primeKernelPython(env));
	const rootPythonPaths = (await Promise.all(skillRoots.filter((skill) => relative(skillsDirectory, skill).startsWith("root-agent/"))
		.map((skill) => preparePythonSkillEnvironment(skill, { dataDir: resolveDataDir(), env }))))
		.flatMap((prepared) => prepared?.pythonPaths ?? []);
	const workspaceRoot = providerExecutionWorkspace(root, childId).absolutePath;
	restoreProviderChildInput(request.initialWorkspace, workspaceRoot);
	writeFileSync(join(workspaceRoot, "work", ".execution-id"), `${childId}\n`);
	const sdkRoot = join(runtimeRoot, "sdk");
	mkdirSync(sdkRoot, { recursive: true });
	const inheritedProviders = readdirSync(join(skillsDirectory, "provider-workers"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory()).map((entry) => {
			const provider = request.registry.catalog().find((item) => item.id === entry.name);
			if (!provider) throw new Error(`Frozen Provider '${entry.name}' is no longer available`);
			return provider;
		});
	stageProviderSdk(sdkRoot, inheritedProviders);
	const providerTools = providerToolRuntime([source], request, childId, env);
	const signal = providerTools ? AbortSignal.any([request.signal, providerTools.signal]) : request.signal;
	const conditionsPath = join(runtimeRoot, "execution-conditions.jsonl");
	const tracePath = join(runtimeRoot, "trace.jsonl");
	const sessionDir = join(runtimeRoot, "child-session", childId);
	let bridge: Awaited<ReturnType<typeof startPrimeSourceBridge>> | undefined;
	let unregister: (() => void) | undefined;
	let releaseReason: "completed" | "aborted" | "error" = "error";
	try {
		unregister = providerTools?.registerWorkspace(root);
		const browser = providerTools ? browserToolClientConfigFromEnv({ ...env, ...providerTools.env }) : undefined;
		bridge = await startPrimeSourceBridge(request.registry, new Set([source.id]), {
			workspaceDirectory: workspaceRoot, temporalContext: request.temporalContext, signal,
		}, root, { runDir: request.recordDirectory, nodeId: "provider-child", attemptId: childId }, {
			conditionsPath, ...(browser ? { browser: { config: browser, root } } : {}),
		});
		const result = await runPrime({
			module: primeAgentModulePath(env), cwd: root, runtimeRoot, sessionDir,
			provider: request.model.slice(0, slash), model: request.model.slice(slash + 1), thinking: request.thinking, serviceTier: request.serviceTier,
			prompt: request.task, skills: skillRoots, tools: ["ipython", "submit_candidate_ledger"], contractTools: true,
			scopedModels: [], rlmMaxDepth: 1, childReplayId: childId,
			readonlyRoots: [sdkRoot, skillsDirectory, ...rootPythonPaths],
			env, signal, tracePath, conditionsPath, launchKind: "provider_child",
			activity: { stageId: "provider-child", attemptId: childId, role: "prime_search" },
			extraEnv: {
				PRIME_AGENT_SOURCE_URL: bridge.baseUrl, PRIME_AGENT_SOURCE_TOKEN: bridge.token,
				PRIME_AGENT_SOURCE_IDS: source.id, PRIME_AGENT_SOURCE_LOG: join(workspaceRoot, "work", "provider.jsonl"),
				PRIME_AGENT_ARTIFACT_WORKSPACE: root, TELOMI_PROVIDER_EXECUTION_WORKSPACES: "1",
				PRIME_AGENT_USER_WORKSPACE: workspaceRoot,
				PYTHONPATH: [sdkRoot, ...skillRoots.map((skill) => join(skill, "src")), ...rootPythonPaths, env.PYTHONPATH].filter(Boolean).join(delimiter),
				PYTHONDONTWRITEBYTECODE: "1", ...providerTools?.env,
				...(request.temporalContext.resolvedRange ? {
					PRIME_AGENT_TEMPORAL_START: request.temporalContext.resolvedRange.startDate,
					PRIME_AGENT_TEMPORAL_END: request.temporalContext.resolvedRange.endDate,
				} : {}),
			},
		});
		if (result.rootError) throw new Error(`Provider child model failed: ${result.rootError}`);
		const ledgerPath = join(workspaceRoot, "work", `${source.id}_candidates.json`);
		const assignment = join(workspaceRoot, "work", ".provider-assignment");
		if (!existsSync(assignment) || readFileSync(assignment, "utf8").trim() !== source.id) {
			throw new Error("Provider child did not submit its assigned Candidate Ledger");
		}
		validatePrimeSearchCandidateLedger(workspaceRoot, source.id, ledgerPath, childId);
		const sessionFiles = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
		if (sessionFiles.length !== 1) throw new Error("Provider child must produce exactly one native session trace");
		releaseReason = "completed";
		return { workspaceRoot, skillsDirectory, childId, tracePath, conditionsPath, ledgerPath,
			providerCallsPath: providerCallsPath(request.recordDirectory),
			...(existsSync(join(root, ".system-prompt.md")) ? { systemPromptPath: join(root, ".system-prompt.md") } : {}), usage: result.usage, toolCalls: result.toolCalls,
			durationMs: Date.now() - startedAt };
	} finally {
		try {
			if (existsSync(sessionDir)) {
				const sessions = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
				if (sessions.length === 1) copyFileSync(join(sessionDir, sessions[0]!), tracePath);
			}
		} finally {
			if (request.signal.aborted) releaseReason = "aborted";
			try { await providerTools?.release(releaseReason); }
			finally { unregister?.(); await bridge?.close(); }
		}
	}
}

/** Frozen input is data only. Skills and execution identity are supplied by this execution. */
export function restoreProviderChildInput(source: string, destination: string): void {
	if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new Error("Provider child input must be a real directory");
	for (const name of readdirSync(source)) {
		if (["skills", ".prime-kernel"].includes(name)) continue;
		if (name === "work") {
			if (lstatSync(join(source, name)).isSymbolicLink()) throw new Error("Provider child input must not contain symbolic links");
			mkdirSync(join(destination, "work"), { recursive: true });
			for (const entry of readdirSync(join(source, name))) {
				if (entry === ".execution-id") continue;
				copyChildInputTree(join(source, name, entry), join(destination, name, entry));
			}
		} else copyChildInputTree(join(source, name), join(destination, name));
	}
}

/** Keep the native child's inherited capability view; only its assigned Provider Skill is a Candidate. */
export function stageProviderChildSkills(root: string, frozenSkillsDirectory: string,
	source: ResearchSourceCatalogEntry & { id: string }, candidateSkills: Readonly<Record<string, string[]>>, python: string,
): { skillsDirectory: string; skillRoots: string[] } {
	const skillsDirectory = join(root, "skills");
	copyChildInputTree(frozenSkillsDirectory, skillsDirectory);
	const providerDirectory = join(skillsDirectory, "provider-workers", source.id);
	const inherited = snapshotSkills([providerDirectory]);
	if (!source.workerSkills?.length || inherited.skills.length !== source.workerSkills.length || source.workerSkills.some((name) => !inherited.skills.some((skill) => skill.name === name))) {
		throw new Error(`Frozen Provider '${source.id}' is missing its worker Skills`);
	}
	rmSync(providerDirectory, { recursive: true, force: true });
	stageProviderWorkerSkills(root, candidateSkills, [source], python);
	const skillRoots = listFilesRecursive(skillsDirectory, { strict: true, rejectNonRegular: true })
		.filter((path) => /^(?:provider-workers\/[^/]+|root-agent)\/[^/]+\/SKILL\.md$/u.test(path))
		.map((path) => dirname(join(skillsDirectory, path)));
	// Validate all inherited entries and reject duplicate names before the SDK can silently shadow a Skill.
	snapshotSkills(skillRoots);
	return { skillsDirectory, skillRoots };
}

function copyChildInputTree(from: string, to: string): void {
	const stat = lstatSync(from);
	if (stat.isSymbolicLink()) throw new Error("Provider child input must not contain symbolic links");
	if (stat.isDirectory()) {
		mkdirSync(to, { recursive: true });
		for (const entry of readdirSync(from)) copyChildInputTree(join(from, entry), join(to, entry));
	} else if (stat.isFile()) copyFileSync(from, to);
	else throw new Error("Provider child input must contain only regular files and directories");
}
