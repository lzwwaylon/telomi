import { sha256 } from "../lib/hash.js";
import { mkdirSync } from "node:fs";
import { posix } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type BashOperations,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { parse as parseShellCommand } from "shell-quote";

import {
	parseSandboxExecutionSpec,
	type SandboxExecutionSpec,
	type SandboxMountSpec,
	type SandboxRole,
	type SandboxToolName,
} from "../../../extensions/telomi-srt/sandbox-spec.js";
import {
	createSrtBashOps,
	createSrtEditOps,
	createSrtFindOps,
	createSrtLsOps,
	createSrtReadOps,
	createSrtWriteOps,
	executeSrtGrep,
	SrtWorkspace,
} from "../../../extensions/telomi-srt/tool-operations.js";
import { agentPythonEnvironment, agentPythonRoots } from "./agent-python.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface SrtAgentSandbox {
	backend: "srt";
	tools: AgentTool[];
	toolDefinitions: AnyToolDefinition[];
	close(): Promise<void>;
}

export interface SrtAgentFileToolPolicy {
	deniedReadPaths?: readonly string[];
	deniedReadPrefixes?: readonly string[];
	deniedReadMessage?: string;
	deniedExecutables?: readonly string[];
	bashPathGuards?: ReadonlyArray<{
		path: string;
		requiredExecutable: string;
		deniedPatterns?: readonly string[];
		message?: string;
	}>;
}

export interface SrtAgentSandboxOptions {
	id: string;
	role: SandboxRole;
	workDirectory: string;
	readonlyMounts: SandboxMountSpec[];
	writableMounts?: SandboxMountSpec[];
	activeTools: readonly SandboxToolName[];
	network?: "deny" | "allow";
	executionSpec?: SandboxExecutionSpec;
	fileToolPolicy?: SrtAgentFileToolPolicy;
	env?: Record<string, string>;
}

export function createSrtAgentSandbox(options: SrtAgentSandboxOptions): SrtAgentSandbox {
	mkdirSync(options.workDirectory, { recursive: true });
	const activeTools = [...new Set(options.activeTools)];
	const baseSpec = options.executionSpec
		? parseSandboxExecutionSpec(options.executionSpec)
		: parseSandboxExecutionSpec({
			version: 1,
			id: `report-${safeId(options.id)}-${sha256(options.workDirectory).slice(0, 12)}`,
			role: options.role,
			sessionLabel: `${options.role}:${options.id}`,
			hostCwd: options.workDirectory,
			guestCwd: "/work",
			mounts: [
				{
					hostPath: options.workDirectory,
					guestPath: "/work",
					access: "read-write",
					shadowPaths: ["/.git", "/.env", "/.envrc"],
				},
				...(options.writableMounts ?? []).map((mount) => ({ ...mount, access: "read-write" as const })),
				...options.readonlyMounts.map((mount) => ({ ...mount, access: "read-only" as const })),
			],
			activeTools,
			env: {
				HOME: "/tmp",
				...options.env,
			},
			network: { mode: options.network ?? "allow" },
			writablePaths: [
				{ guestPath: "/work", kind: "tree" },
				...(options.writableMounts ?? []).map((mount) => ({ guestPath: mount.guestPath, kind: "tree" as const })),
			],
		});
	const runtimeEnv = agentPythonEnvironment({ ...process.env, ...baseSpec.env });
	const runtimeMounts = agentPythonRoots({ ...process.env, ...baseSpec.env }).map((hostPath, index) => ({
		hostPath,
		guestPath: index === 0 ? "/runtime/python" : `/runtime/python-base-${index}`,
		access: "read-only" as const,
	}));
	const spec = parseSandboxExecutionSpec({
		...baseSpec,
		mounts: [
			...baseSpec.mounts,
			...runtimeMounts.filter((mount) => !baseSpec.mounts.some((existing) =>
				existing.hostPath === mount.hostPath)),
		],
		env: { ...baseSpec.env, ...runtimeEnv },
	});
	if (spec.role !== options.role) {
		throw new Error(`SRT Agent sandbox role '${spec.role}' does not match '${options.role}'`);
	}
	if (
		spec.activeTools.length !== activeTools.length
		|| spec.activeTools.some((tool, index) => tool !== activeTools[index])
	) {
		throw new Error("SRT Agent sandbox active tools do not match the Stage Runtime");
	}
	const guestCwd = spec.guestCwd;
	const workspace = new SrtWorkspace(spec);
	const deniedReadPaths = new Set(
		(options.fileToolPolicy?.deniedReadPaths ?? []).map(normalizeGuestPath),
	);
	const deniedReadPrefixes = (options.fileToolPolicy?.deniedReadPrefixes ?? []).map(normalizeGuestPath);
	const assertReadAllowed = (filePath: string): void => {
		const normalized = normalizeGuestPath(filePath);
		if (!deniedReadPaths.has(normalized)
			&& !deniedReadPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return;
		throw new Error(
			options.fileToolPolicy?.deniedReadMessage
				?? `Pi read is denied for ${normalized}`,
		);
	};
	const readOperations: ReadOperations = {
		readFile: async (filePath) => {
			assertReadAllowed(filePath);
			return createSrtReadOps(workspace).readFile(filePath);
		},
		access: async (filePath) => {
			assertReadAllowed(filePath);
			return createSrtReadOps(workspace).access(filePath);
		},
		detectImageMimeType: async (filePath) => {
			assertReadAllowed(filePath);
			return createSrtReadOps(workspace).detectImageMimeType?.(filePath) ?? null;
		},
	};
	const writeOperations: WriteOperations = {
		writeFile: async (filePath, content) =>
			createSrtWriteOps(workspace).writeFile(filePath, content),
		mkdir: async (dirPath) => createSrtWriteOps(workspace).mkdir(dirPath),
	};
	const editOperations: EditOperations = {
		readFile: async (filePath) => createSrtEditOps(workspace).readFile(filePath),
		writeFile: async (filePath, content) =>
			createSrtEditOps(workspace).writeFile(filePath, content),
		access: async (filePath) => createSrtEditOps(workspace).access(filePath),
	};
	const bashOperations: BashOperations = {
		exec: async (command, cwd, executionOptions) => {
			assertBashCommandAllowed(command, options.fileToolPolicy);
			// Report work is bounded by Runtime cancellation and structural budgets, not
			// wall-clock guesses. Do not add a bash timeout here: Provider pagination,
			// document parsing, and media acquisition may legitimately run for a long time.
			return createSrtBashOps(workspace).exec(command, cwd, executionOptions);
		},
	};
	const lsOperations: LsOperations = {
		exists: async (filePath) => createSrtLsOps(workspace).exists(filePath),
		stat: async (filePath) => createSrtLsOps(workspace).stat(filePath),
		readdir: async (dirPath) => createSrtLsOps(workspace).readdir(dirPath),
	};
	const findOperations: FindOperations = {
		exists: async (filePath) => createSrtFindOps(workspace).exists(filePath),
		glob: async (pattern, cwd, findOptions) =>
			createSrtFindOps(workspace).glob(pattern, cwd, findOptions),
	};
	const baseGrepDefinition = createGrepToolDefinition(guestCwd);
	const grepDefinition: typeof baseGrepDefinition = {
		...baseGrepDefinition,
		execute: async (_toolCallId, params, signal) =>
			executeSrtGrep(workspace, params, signal),
	};
	const baseBashDefinition = createBashToolDefinition(guestCwd, { operations: bashOperations });
	const {
		renderCall: _renderTimedBashCall,
		renderResult: _renderTimedBashResult,
		...baseBashDefinitionWithoutTimedRenderers
	} = baseBashDefinition;
	const bashDefinition: AnyToolDefinition = {
		...baseBashDefinitionWithoutTimedRenderers,
		description: "Execute a bounded bash command in the Agent workspace. The command inherits Runtime cancellation and has no wall-clock deadline.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
		}, { additionalProperties: false }),
		execute: async (toolCallId, params, signal, onUpdate, context) =>
			baseBashDefinition.execute(toolCallId, { command: (params as { command: string }).command }, signal, onUpdate, context),
	};
	const definitionsByName: Record<SandboxToolName, AnyToolDefinition> = {
		read: createReadToolDefinition(guestCwd, { operations: readOperations }),
		write: createWriteToolDefinition(guestCwd, { operations: writeOperations }),
		edit: createEditToolDefinition(guestCwd, { operations: editOperations }),
		bash: bashDefinition,
		ls: createLsToolDefinition(guestCwd, { operations: lsOperations }),
		find: createFindToolDefinition(guestCwd, { operations: findOperations }),
		grep: grepDefinition,
	};
	const toolDefinitions = activeTools.map((name) => definitionsByName[name]);
	return {
		backend: "srt",
		toolDefinitions,
		tools: toolDefinitions.map(toAgentTool),
		async close() {
			workspace.close();
		},
	};
}

export function assertBashCommandAllowed(
	command: string,
	policy: SrtAgentFileToolPolicy | undefined,
): void {
	const deniedExecutables = new Set(policy?.deniedExecutables?.map((value) => posix.basename(value)));
	for (const tokens of shellCommandSegments(command)) {
		const executableIndex = commandExecutableIndex(tokens);
		if (executableIndex < 0) continue;
		const executable = posix.basename(tokens[executableIndex] ?? "");
		if (deniedExecutables.has(executable)) {
			throw new Error(`SRT sandbox blocks executable: ${executable}`);
		}
	}
	for (const guard of policy?.bashPathGuards ?? []) {
		if (!command.includes(guard.path)) continue;
		const executable = escapeRegExp(guard.requiredExecutable);
		if (!new RegExp(`(?:^|[;&|()\\s])${executable}(?:\\s|$)`, "u").test(command)) {
			throw new Error(guard.message ?? `${guard.path} may only be inspected with ${guard.requiredExecutable}`);
		}
		for (const pattern of guard.deniedPatterns ?? []) {
			if (new RegExp(pattern, "u").test(command)) {
				throw new Error(guard.message ?? `Bash command violates the read policy for ${guard.path}`);
			}
		}
	}
}

const SHELL_COMMAND_BOUNDARIES = new Set([";", "&", "&&", "|", "||", "\n"]);

function shellCommandSegments(command: string): string[][] {
	let parsed: ReturnType<typeof parseShellCommand>;
	try {
		parsed = parseShellCommand(command);
	} catch {
		return [];
	}
	const segments: string[][] = [];
	let current: string[] = [];
	const flush = (): void => {
		if (current.length > 0) segments.push(current);
		current = [];
	};
	for (const token of parsed) {
		if (typeof token === "string") {
			current.push(token);
			continue;
		}
		if ("op" in token && SHELL_COMMAND_BOUNDARIES.has(token.op)) flush();
	}
	flush();
	return segments;
}

function commandExecutableIndex(tokens: readonly string[]): number {
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
	const first = posix.basename(tokens[index] ?? "");
	if (first === "command") {
		index += 1;
		while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) index += 1;
	}
	if (posix.basename(tokens[index] ?? "") === "env") {
		index += 1;
		while (index < tokens.length) {
			const token = tokens[index] ?? "";
			if (token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
				index += 1;
				continue;
			}
			break;
		}
	}
	return index < tokens.length ? index : -1;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function toAgentTool(definition: AnyToolDefinition): AgentTool {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, undefined as never),
	};
}

function safeId(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100) || "stage";
}

function normalizeGuestPath(value: string): string {
	return value.startsWith("/")
		? posix.normalize(value)
		: posix.resolve("/work", value);
}
