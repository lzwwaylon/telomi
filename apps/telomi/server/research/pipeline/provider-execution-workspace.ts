import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
	PROVIDER_EXECUTION_DIRECTORY,
	providerExecutionChildId,
	providerExecutionWorkspace,
} from "../../../../extensions/telomi-srt/prime-workspace.js";
import type { LogicalWorkspaceSnapshot } from "../../agent-runtime/logical-workspace-snapshot.js";
import type { CreateAgentSessionOptions, SubagentRuntimeHost } from "prime-agent";

export { providerExecutionChildId, providerExecutionWorkspace };

/** Override only native child cwd; Prime retains its own parent/child lifecycle and messaging. */
export function createProviderChildRuntimeHost(
	prime: Pick<typeof import("prime-agent"), "SessionManager" | "createAgentSession">,
	root: string,
	options: CreateAgentSessionOptions,
): SubagentRuntimeHost {
	const host: SubagentRuntimeHost = {
		async createRlmSubagentRuntime(input) {
			const cwd = providerExecutionWorkspace(root, input.id).absolutePath;
			const sessionManager = prime.SessionManager.create(cwd, input.sessionDir);
			if (input.parentSession.sessionFile) sessionManager.newSession({ parentSession: input.parentSession.sessionFile, rlmDepth: input.rlmDepth });
			const { session } = await prime.createAgentSession({
				...options, cwd, sessionManager, resourceLoader: input.parentSession.resourceLoader,
				model: input.model, thinkingLevel: input.thinkingLevel, serviceTier: input.serviceTier,
				scopedModels: input.scopedModels, customTools: input.customTools,
				initialActiveToolNames: input.activeToolNames, allowedToolNames: input.allowedToolNames,
				includeGoals: input.includeGoals, includeCompactSkill: input.includeCompactSkill,
				rlmDepth: input.rlmDepth, rlmMaxDepth: input.rlmMaxDepth, rlmSessionDir: input.sessionDir,
				rlmParentNodeId: input.rlmParentNodeId,
				rlmParentAgent: input.parentSession.sessionName ?? input.parentSession.sessionId,
				subagentRuntimeHost: host, sessionStartEvent: { type: "session_start", reason: "startup" },
			});
			try {
				// Match native inline child inheritance, including instrumented/custom model transport.
				for (const key of ["convertToLlm", "transformContext", "streamFn", "getApiKey", "onPayload", "onResponse", "toolExecution"] as const) {
					Object.assign(session.agent, { [key]: input.parentSession.agent[key] });
				}
				session.setSessionName(input.sessionName);
				input.onSessionPublished?.(session);
				return { session };
			} catch (error) { await session.disposeAsync(); throw error; }
		},
		async deleteRlmSubagentRuntime(_id, session) { await session?.disposeAsync(); },
		async releaseRlmSubagentRuntime(runtime) { await runtime.session.disposeAsync(); },
	};
	return host;
}

/** SDK file reads resolve against the worker cwd; Child kernels have the same relative Skill entry point. */
export function workspaceRelativeSkill<T extends { filePath: string; baseDir: string }>(root: string, skill: T): T {
	const skillPath = relative(root, skill.filePath);
	if (isAbsolute(skillPath) || !skillPath.startsWith("skills/")) {
		throw new Error("Prime Search Skill must be staged inside its workspace skills directory");
	}
	return { ...skill, filePath: skillPath, baseDir: dirname(skillPath) };
}

export function providerChildLogicalWorkspace(root: string, childId: string): LogicalWorkspaceSnapshot {
	const execution = providerExecutionWorkspace(root, childId);
	return {
		guestCwd: "/workspace",
		mounts: [
			{ hostPath: execution.absolutePath, guestPath: "/workspace", access: "read-write", shadowPaths: [".prime-kernel"] },
			...(existsSync(join(root, "skills")) ? [{
				hostPath: join(root, "skills"), guestPath: "/workspace/skills", access: "read-only" as const,
			}] : []),
		],
	};
}

export function providerExecutionWorkspaceForSession(root: string, sessionDir: string | undefined) {
	const childId = providerExecutionChildId(sessionDir);
	return childId ? providerExecutionWorkspace(root, childId) : undefined;
}

/** The task the root agent handed a Provider child, copied beside its Ledger so a Case carries what the child was told. */
export const PROVIDER_CHILD_TASK_FILE = ".task.md";

/**
 * At Case capture, copy each Provider child's opening task into `provider-executions/<child>/work/.task.md`, which the
 * workspace snapshot then captures on both sides of an evaluation. The task is the SDK-written `agent_message` at the
 * top of the child's session, not something the child wrote; this only reads the child sessions the runtime already
 * recorded, and only annotates children that produced a Ledger workspace. Never overwrites an existing file.
 */
export function preserveProviderChildTasks(root: string, sessionArtifactsDir: string): void {
	if (!existsSync(sessionArtifactsDir)) return;
	for (const entry of readdirSync(sessionArtifactsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^sub-[A-Za-z0-9-]+$/u.test(entry.name)) continue;
		const task = firstParentTask(join(sessionArtifactsDir, entry.name));
		if (task === undefined) continue;
		const workDir = join(root, PROVIDER_EXECUTION_DIRECTORY, entry.name, "work");
		if (!existsSync(workDir)) continue;
		const target = join(workDir, PROVIDER_CHILD_TASK_FILE);
		if (!existsSync(target)) writeFileSync(target, `${task}\n`, "utf-8");
	}
}

/** The parent's task is the first `agent_message` in the child's session trace. */
function firstParentTask(childSessionDir: string): string | undefined {
	const session = readdirSync(childSessionDir).find((name) => name.endsWith(".jsonl"));
	if (!session) return undefined;
	for (const line of readFileSync(join(childSessionDir, session), "utf-8").split(/\r?\n/u)) {
		if (!line) continue;
		let record: { type?: string; customType?: string; content?: unknown };
		try { record = JSON.parse(line) as typeof record; } catch { continue; }
		if (record.type === "custom_message" && record.customType === "agent_message" && typeof record.content === "string") {
			return record.content.replace(/^\[task from parent\]\s*/u, "").trimEnd();
		}
	}
	return undefined;
}
