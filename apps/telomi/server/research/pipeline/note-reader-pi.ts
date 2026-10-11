import type { AnyModel } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION,
	type ModelRuntimeAuthOverrides, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptAgentOutput, AgentOutputValidationError } from "../../agent-runtime/accept-agent-output.js";
import { snapshotLogicalWorkspace } from "../../agent-runtime/logical-workspace-snapshot.js";
import { modelDefinitionHash } from "../../agent-runtime/model-policy.js";
import type { ThinkingLevel } from "../../agent-runtime/model-config/resolve.js";
import { observeModelFailureText } from "../../agent-runtime/model-config/model-verdicts.js";
import { scrubResearchModelError } from "../../agent-runtime/models/error-classifier.js";
import type { ResearchModelUsage } from "../../agent-runtime/model-usage.js";
import { ResearchNodeError } from "../../agent-runtime/retry-policy.js";
import { createSrtAgentSandbox } from "../../agent-runtime/srt-agent-sandbox.js";
import { resolveAgentDir } from "../../config/agent-directory.js";
import { isProviderCredentialDeleted } from "../../config/credential-tombstones.js";
import { refreshConnectionRuntime } from "../../providers/custom-models.js";
import { writeJsonAtomic } from "../../lib/fs.js";
import { readerOutputFiles } from "./reader-output-files.js";
import { createReaderNumberedRead } from "./reader-numbered-read.js";

export function createPiReaderSandbox(work: string, outputDirectory: string) {
	return createSrtAgentSandbox({ id: "pi-reader", role: "report.note_agent", workDirectory: work,
		activeTools: ["read", "bash", "edit", "write"], nativeBash: true, network: "deny",
		readToolFactory: (cwd, operations, resolve) => createReaderNumberedRead(cwd, operations, resolve),
		readonlyMounts: [...["source", "inputs"].map(name => ({ hostPath: join(work, name), guestPath: `/work/${name}`, access: "read-only" as const })),
			{ hostPath: outputDirectory, guestPath: "/tool-output", access: "read-only" }],
	});
}

/** A native Pi Session owns reading and writing; the existing Note validator owns publication. */
export async function runPiReader(args: {
	work: string; runtimeRoot: string; provider: string; modelId: string; thinking: ThinkingLevel;
	systemPrompt: string; userPrompt: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
	validate: () => Promise<void>;
	sourceReading?: { expectedSourceId: string };
	sessionRole?: "root" | "child";
	extensions?: Pick<NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]>, "additionalExtensionPaths" | "extensionsOverride">;
	onEvent?: (event: AgentSessionEvent) => void;
}): Promise<{ usage: ResearchModelUsage }> {
	args.signal.throwIfAborted();
	const { work, runtimeRoot } = args;
	const agentDir = join(runtimeRoot, "pi-agent"), sessions = join(runtimeRoot, "sessions");
	const outputDirectory = join(runtimeRoot, "tool-output");
	for (const path of [agentDir, sessions, outputDirectory]) mkdirSync(path, { recursive: true });
	const usage: ResearchModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	const toolCounts: Record<string, number> = {};
	const selector = `${args.provider}/${args.modelId}`;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let sandbox: ReturnType<typeof createPiReaderSandbox> | undefined;
	try {
		const canonical = args.env.PI_CODING_AGENT_DIR?.trim() || resolveAgentDir(args.env.TELOMI_DATA_DIR);
		const connectionEnv = { ...args.env, PRIME_AGENT_CODING_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: canonical };
		const liveEnv = { ...connectionEnv, TELOMI_PRIME_MODEL_DEFINITIONS: undefined };
		const definition = modelDefinitionHash(selector, connectionEnv);
		const assertConnection = () => {
			args.signal.throwIfAborted();
			if (isProviderCredentialDeleted(args.provider)) throw new Error("Reader Provider credential was deleted");
			if (modelDefinitionHash(selector, liveEnv) !== definition) throw new Error("Reader Provider connection changed; start a new Reader");
		};
		assertConnection();
		const paths = { authPath: join(canonical, "auth.json"), modelsPath: join(canonical, "models.json"), signal: args.signal, allowModelNetwork: false };
		const modelRuntime = await ModelRuntime.create(paths);
		await refreshConnectionRuntime(modelRuntime);
		assertConnection();
		const model = modelRuntime.getModel(args.provider, args.modelId);
		if (!model || !modelRuntime.hasConfiguredAuth(model.provider)) throw new Error(`Pi model is unavailable: ${selector}`);
		modelRuntime.getAuth = async (selected: string | AnyModel, options?: ModelRuntimeAuthOverrides) => {
			assertConnection();
			const live = await ModelRuntime.create({ ...paths, refreshOnCreate: false });
			await refreshConnectionRuntime(live);
			assertConnection();
			const auth = await (typeof selected === "string" ? live.getAuth(selected, options) : live.getAuth(selected, options));
			assertConnection();
			return auth;
		};
		sandbox = createPiReaderSandbox(work, outputDirectory);
		const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
		const loader = new DefaultResourceLoader({ cwd: work, agentDir, settingsManager,
			appendSystemPrompt: [args.systemPrompt], noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true, ...args.extensions,
			extensionFactories: [readerOutputFiles(outputDirectory)] });
		await loader.reload();
		const names = [...sandbox.toolDefinitions.map(tool => tool.name), ...(args.extensions ? ["subagent"] : [])];
		({ session } = await createAgentSession({ cwd: "/work", agentDir, modelRuntime, model,
			thinkingLevel: args.thinking, scopedModels: [{ model, thinkingLevel: args.thinking }],
			settingsManager, resourceLoader: loader, sessionManager: SessionManager.create(work, sessions),
			tools: names, customTools: sandbox.toolDefinitions }));
		if (session.getActiveToolNames().length !== names.length || names.some(name => !session!.getActiveToolNames().includes(name))) {
			throw new Error("Pi Reader tool allowlist changed");
		}
		writeFileSync(join(runtimeRoot, "effective-system-prompt.md"), session.systemPrompt);
		writeJsonAtomic(join(runtimeRoot, "conditions.json"), { framework: "pi", execution_profile: "pi_builtin",
			...(args.sourceReading ? { reading_mode: "source-reading", source_id: args.sourceReading.expectedSourceId, child_count: 0 } : {}),
			pi_version: VERSION, cache_warming: "off",
			spill_publication: "readonly_session_files",
			read_format: "auto_numbered_source_text",
			model: selector, thinking: args.thinking, model_definition_hash: definition, session_id: session.sessionId,
			tools: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });
		snapshotLogicalWorkspace({ ...sandbox.logicalWorkspace, sessionId: session.sessionId, sessionRole: args.sessionRole ?? "root",
			captureMoment: "before-first-agent-turn" }, join(runtimeRoot, "logical-workspaces", "root"));
		session.subscribe(event => {
			args.onEvent?.(event);
			if (event.type === "tool_execution_start") toolCounts[event.toolName] = (toolCounts[event.toolName] ?? 0) + 1;
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				appendFileSync(join(runtimeRoot, "tool-events.jsonl"), `${JSON.stringify({ ...event, timestamp: Date.now() })}\n`);
			}
			if (event.type !== "message_end") return;
			appendFileSync(join(runtimeRoot, "session.jsonl"), `${JSON.stringify({ type: "message", timestamp: Date.now(), message: event.message })}\n`);
			if (event.message.role === "assistant") {
				usage.inputTokens += event.message.usage.input; usage.outputTokens += event.message.usage.output;
				usage.costUsd += event.message.usage.cost.total; usage.calls++;
			}
		});
		const active = session;
		const abort = () => { void active.abort(); };
		args.signal.addEventListener("abort", abort, { once: true });
		try {
			const promptTurn = async (text: string) => {
				args.signal.throwIfAborted();
				await active.prompt(text, { expandPromptTemplates: false });
				args.signal.throwIfAborted();
				const last = [...active.messages].reverse().find(message => message.role === "assistant");
				if (!last || last.stopReason === "error" || last.stopReason === "aborted") {
					throw new Error(`model '${selector}' failed: ${scrubResearchModelError(last?.errorMessage ?? "no assistant response")}`);
				}
				if (`${last.provider}/${last.model}` !== selector) throw new Error("Pi Reader returned a different model");
			};
			await acceptAgentOutput({ initialPrompt: args.userPrompt, promptTurn, validate: args.validate });
		} finally { args.signal.removeEventListener("abort", abort); }
		return { usage };
	} catch (error) {
		if (args.signal.aborted) throw new ResearchNodeError("Pi Reader cancelled", "cancelled", false);
		const message = scrubResearchModelError(error);
		observeModelFailureText(message);
		throw new ResearchNodeError(message, error instanceof AgentOutputValidationError ? "validation" : "provider", true);
	} finally {
		try { writeJsonAtomic(join(runtimeRoot, "result.json"), { schema_version: 1, framework: "pi", model: selector,
			...(args.sourceReading ? { reading_mode: "source-reading", source_id: args.sourceReading.expectedSourceId } : {}),
			pi_version: VERSION, cache_warming: "off",
			read_format: "auto_numbered_source_text",
			effective_model: session?.model ? `${session.model.provider}/${session.model.id}` : selector,
			effective_thinking: session?.thinkingLevel ?? args.thinking, child_count: 0,
			usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: usage.costUsd, model_calls: usage.calls },
			tool_calls: Object.values(toolCounts).reduce((sum, count) => sum + count, 0), tool_counts: toolCounts, turns: usage.calls });
		} finally { try { session?.dispose(); } finally { await sandbox?.close(); } }
	}
}
