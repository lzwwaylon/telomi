import type { Api, Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ModelRuntimeAuthOverrides, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Agent as HttpAgent } from "undici";
import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import type { AgentStageActivity } from "../agent-runtime/agent-stage-runtime.js";
import { snapshotLogicalWorkspace } from "../agent-runtime/logical-workspace-snapshot.js";
import { observeModelFailureText } from "../agent-runtime/model-config/model-verdicts.js";
import type { ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { modelDefinitionHash } from "../agent-runtime/model-policy.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { scrubResearchModelError } from "../agent-runtime/models/error-classifier.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { createSrtAgentSandbox } from "../agent-runtime/srt-agent-sandbox.js";
import { resolveAgentDir } from "../config/agent-directory.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { isRecord } from "../lib/values.js";
import { refreshConnectionRuntime } from "../providers/custom-models.js";
import { readInvestigationHandoff, type InvestigationHandoff } from "./investigation-handoff.js";

const RESULT_CHAR_LIMIT = 12_000;
// Investigation work can outlive the model transport's idle deadline; cancellation uses its signal.
const investigationDispatcher = new HttpAgent({ headersTimeout: 0, bodyTimeout: 0 });
const retryableTransportCodes = new Set(["UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ECONNRESET", "EPIPE"]);
const nonempty = () => Type.String({ minLength: 1, pattern: "\\S", maxLength: 20_000 });
const object = (properties: Parameters<typeof Type.Object>[0]) => Type.Object(properties, { additionalProperties: false });
const question = object({ question: nonempty() });
const operations = [
	{ name: "wiki_list_topics", route: "/v1/wiki", parameters: object({}),
		description: "List Topics and their scope in this investigation's frozen Wiki. Returned T refs can filter wiki_search; zero pages do not establish absence of original Sources." },
	{ name: "wiki_search", route: "/v1/wiki", parameters: object({ query: nonempty(),
		top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		topic_ref: Type.Optional(Type.String({ pattern: "^T[1-9][0-9]*$" })) }),
		description: "Search the frozen Wiki, optionally within a current T ref. Returns page leads; use wiki_read_page before assigning evidence to Writer." },
	{ name: "wiki_read_page", route: "/v1/wiki", parameters: object({ path: nonempty() }),
		description: "Read a P ref returned by wiki_search and register its available evidence C refs for Writer." },
	{ name: "knowledge_search", route: "/v1/knowledge-search", parameters: object({ query: nonempty(),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
		description: "Find saved Cue Notes beyond the Wiki for a missing part. At most one distinct query per investigation; returned current refs may be assigned to Writer." },
	{ name: "read_sources", route: "/v1/read-sources", parameters: question,
		description: "Ask Note Agent to verify an incremental unresolved question in pinned original Sources. Receives known Cues automatically; returns verified new Cues and gaps. Does not search outside sources." },
	{ name: "external_search", route: "/v1/external-search", parameters: question,
		description: "Acquire original Sources and have Note Agent verify them for a distinct missing evidence need. Include source restrictions and verified locators. Requires external_allowed and a prior read_sources call unless verified evidence was restored from the investigation thread." },
	{ name: "write_answer", route: "/v1/write-answer", parameters: object({
		evidence_refs: Type.Array(nonempty(), { maxItems: 256, uniqueItems: true }),
		requirements: Type.Array(nonempty(), { minItems: 1, maxItems: 50, uniqueItems: true }),
	}), description: "Delegate the complete answer to Writer using selected current evidence refs and the complete question's requirements. Review coverage and gaps; submit the latest result_ref verbatim as answer_ref." },
] as const;

/** Bounded inspection preserves counts and the immutable full result, never implying complete reading. */
export function investigationToolView(workspace: string, receipt: unknown, operation: string): Record<string, unknown> {
	const result = readInvestigationHandoff(workspace, receipt, operation);
	const verified = receipt as InvestigationHandoff;
	const reference = { result_ref: verified.result_ref, read_path: `/work/${verified.result_ref}` };
	const complete = { ...reference, truncated: false, result };
	if (JSON.stringify(complete).length <= RESULT_CHAR_LIMIT) return complete;
	const priorities = ["status", "summary", "gaps", "coverage", "ref", "cue", "topic", "title", "source", "cues", "citation_refs"];
	const project = (value: unknown, limit: number, depth = 0): unknown => {
		if (typeof value === "string") return value.length <= limit * 50 ? value
			: { excerpt: value.slice(0, limit * 50), omitted_characters: value.length - limit * 50 };
		if (Array.isArray(value)) return { items: depth < 8 ? value.slice(0, limit).map(item => project(item, limit, depth + 1)) : [],
			total_count: value.length, omitted_count: Math.max(0, value.length - (depth < 8 ? limit : 0)) };
		if (!isRecord(value)) return value;
		const keys = Object.keys(value).sort((a, b) => {
			const rank = (key: string) => priorities.includes(key) ? priorities.indexOf(key) : priorities.length;
			return rank(a) - rank(b);
		});
		const selected = depth < 8 ? keys.slice(0, Math.max(12, limit)) : [];
		return { ...Object.fromEntries(selected.map(key => [key, project(value[key], limit, depth + 1)])),
			...(keys.length > selected.length ? { omitted_field_count: keys.length - selected.length } : {}) };
	};
	for (const limit of [20, 10, 5, 2, 1]) {
		const view = { ...reference, truncated: true, result: project(result, limit) };
		if (JSON.stringify(view).length <= RESULT_CHAR_LIMIT) return view;
	}
	return { ...reference, truncated: true, result_omitted: true,
		message: "The result exceeds the inspection limit. Read the full artifact in bounded ranges before judging coverage or selecting evidence." };
}

const legacyGithubRead = {
	name: "github_read", route: "/v1/github-read", parameters: object({ question: nonempty(), repository: nonempty(),
		ref: nonempty(), paths: Type.Array(nonempty(), { minItems: 1 }) }),
	description: "Replay a historical GitHub reading assignment with the exact captured repository, revision and file paths. Available only when the frozen Replay plan contains this operation.",
} as const;

export function createPiInvestigationTools(options: {
	cwd: string; bridge: { baseUrl: string; token: string }; signal: AbortSignal; allowLegacyGithubRead?: boolean;
}): ToolDefinition[] {
	return [...operations, ...(options.allowLegacyGithubRead ? [legacyGithubRead] : [])].map(operation => ({
		name: operation.name, label: operation.name, description: operation.description,
		parameters: operation.parameters, executionMode: "sequential" as const,
		async execute(id, parameters, signal) {
			if (!Value.Check(operation.parameters, parameters)) throw new Error(`Invalid ${operation.name} arguments`);
			const activeSignal = signal ? AbortSignal.any([signal, options.signal]) : options.signal;
			activeSignal.throwIfAborted();
			const body = JSON.stringify({ ...(operation.name === "knowledge_search" ? { limit: 10 } : {}),
				...parameters, agent_session_id: "root", request_id: id,
				...(operation.route === "/v1/wiki" ? { operation: operation.name } : {}) });
			for (let attempt = 0; ; attempt++) {
				let response: Response, receipt: unknown;
				try {
					response = await fetch(`${options.bridge.baseUrl}${operation.route}`, {
						method: "POST", signal: activeSignal,
						headers: { "content-type": "application/json", authorization: `Bearer ${primeExecutionToken(options.bridge.token, "root")}` },
						body, ...({ dispatcher: investigationDispatcher } as object),
					});
					receipt = await response.json();
				} catch (error) {
					activeSignal.throwIfAborted();
					const cause = (error as { cause?: { code?: string } })?.cause;
					if (attempt === 0 && cause?.code && retryableTransportCodes.has(cause.code)) continue;
					throw new Error(`Investigation ${operation.name} transport failed${cause?.code ? ` (${cause.code})` : ""}: ${scrubResearchModelError(cause ?? error)}`);
				}
				if (!response.ok) throw new Error(`Investigation ${operation.name} failed (${response.status}): ${scrubResearchModelError(JSON.stringify(receipt))}`);
				activeSignal.throwIfAborted();
				const view = investigationToolView(options.cwd, receipt, operation.name);
				return { content: [{ type: "text" as const, text: JSON.stringify(view) }], details: view };
			}
		},
	}));
}

export function createPiInvestigationSandbox(cwd: string) {
	return createSrtAgentSandbox({ id: "investigation", role: "research.investigation", workDirectory: join(cwd, "work"),
		readonlyMounts: [{ hostPath: join(cwd, "inputs"), guestPath: "/work/inputs", access: "read-only" }],
		activeTools: ["read", "write"], network: "deny" });
}

export async function runPiInvestigation(args: {
	cwd: string; runtimeRoot: string; sessionDir: string; provider: string; model: string;
	thinking: ThinkingLevel; prompt: string; systemPrompt?: string; allowLegacyGithubRead?: boolean; bridge: { baseUrl: string; token: string };
	env: NodeJS.ProcessEnv; signal: AbortSignal; tracePath: string; conditionsPath: string;
	onActivity?: (activity: AgentStageActivity) => void;
	activity?: Pick<AgentStageActivity, "stageId" | "attemptId" | "role">;
}): Promise<{ usage: ResearchModelUsage; toolCalls: number; rootError?: string }> {
	if (args.env.TELOMI_EVAL_INSTANCE !== "1") throw new Error("Pi Investigation is available only in an evaluation instance");
	args.signal.throwIfAborted();
	const work = join(args.cwd, "work"), agentDir = join(args.runtimeRoot, "pi-investigation-agent");
	for (const directory of [work, agentDir, args.sessionDir, dirname(args.tracePath), dirname(args.conditionsPath)]) mkdirSync(directory, { recursive: true });
	const usage: ResearchModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	let toolCalls = 0;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let sandbox: ReturnType<typeof createSrtAgentSandbox> | undefined;
	const emit = (status: AgentStageActivity["status"], kind: AgentStageActivity["kind"], detail: { text?: string; toolName?: string } = {}) =>
		args.onActivity?.({ ...(args.activity ?? { stageId: "prime-investigation", attemptId: "1", role: "prime_search" }), status, kind, ...detail });
	emit("running", "status");
	try {
		const selector = `${args.provider}/${args.model}`;
		const canonical = args.env.PI_CODING_AGENT_DIR?.trim() || resolveAgentDir(args.env.TELOMI_DATA_DIR);
		const connectionEnv = { ...args.env, PRIME_AGENT_CODING_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: canonical };
		const liveEnv = { ...connectionEnv, TELOMI_PRIME_MODEL_DEFINITIONS: undefined };
		const definition = modelDefinitionHash(selector, connectionEnv);
		const assertConnection = () => {
			args.signal.throwIfAborted();
			if (isProviderCredentialDeleted(args.provider)) throw new Error("Investigation Provider credential was deleted");
			if (modelDefinitionHash(selector, liveEnv) !== definition) throw new Error("Investigation Provider connection changed; start a new investigation");
		};
		assertConnection();
		const paths = { authPath: join(canonical, "auth.json"), modelsPath: join(canonical, "models.json"), signal: args.signal, allowModelNetwork: false };
		const modelRuntime = await ModelRuntime.create(paths);
		await refreshConnectionRuntime(modelRuntime);
		assertConnection();
		const model = modelRuntime.getModel(args.provider, args.model);
		if (!model || !modelRuntime.hasConfiguredAuth(model.provider)) throw new Error(`Pi model is unavailable: ${selector}`);
		modelRuntime.getAuth = async (selected: string | Model<Api>, options?: ModelRuntimeAuthOverrides) => {
			assertConnection();
			const live = await ModelRuntime.create({ ...paths, refreshOnCreate: false });
			await refreshConnectionRuntime(live);
			assertConnection();
			const auth = await (typeof selected === "string" ? live.getAuth(selected, options) : live.getAuth(selected, options));
			assertConnection();
			return auth;
		};
		const prompt = renderAgentPrompt("research", "prime-search", "system", {}, "investigate-pi");
		sandbox = createPiInvestigationSandbox(args.cwd);
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({ cwd: work, agentDir, settingsManager, systemPrompt: args.systemPrompt ?? prompt.content,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await loader.reload();
		const customTools = [...sandbox.toolDefinitions, ...createPiInvestigationTools(args)];
		const expected = customTools.map(tool => tool.name);
		({ session } = await createAgentSession({ cwd: "/work", agentDir, modelRuntime, model, thinkingLevel: args.thinking,
			scopedModels: [{ model, thinkingLevel: args.thinking }], settingsManager, resourceLoader: loader,
			sessionManager: SessionManager.create(work, args.sessionDir), tools: expected, customTools }));
		const activeTools = session.getActiveToolNames();
		if (activeTools.length !== expected.length || expected.some(name => !activeTools.includes(name))) throw new Error("Pi investigation tool allowlist changed");
		writeFileSync(join(args.runtimeRoot, "pi-effective-system-prompt.md"), session.systemPrompt);
		appendFileSync(args.conditionsPath, `${JSON.stringify({ type: "pi_launch", execution_profile: "pi_builtin", framework: "pi",
			provider: args.provider, model: args.model, thinking: args.thinking, model_definition_hash: definition,
			prompt: args.prompt, system_prompt: session.systemPrompt, prompt_config_sha256: prompt.configSha256,
			tools: customTools.map(({ name, description, parameters }) => ({ name, description, parameters })) })}\n`);
		snapshotLogicalWorkspace({ ...sandbox.logicalWorkspace, sessionId: session.sessionId, sessionRole: "root",
			captureMoment: "before-first-agent-turn" }, join(args.runtimeRoot, "logical-workspaces", "root"));
		let liveText = "", lastEmission = 0;
		session.subscribe(event => {
			if (event.type === "message_end") {
				appendFileSync(args.tracePath, `${JSON.stringify({ type: "message", timestamp: Date.now(), message: event.message })}\n`);
				if (event.message.role === "assistant") {
					const item = event.message.usage;
					usage.inputTokens += item.input;
					usage.outputTokens += item.output; usage.costUsd += item.cost.total; usage.calls++;
				}
			}
			if (event.type === "tool_execution_start") { toolCalls++; emit("running", "tool", { toolName: event.toolName }); }
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				liveText = (liveText + event.assistantMessageEvent.delta).slice(-2_000);
				if (Date.now() - lastEmission >= 200) { lastEmission = Date.now(); emit("running", "text", { text: liveText }); }
			}
		});
		const active = session;
		const abort = () => { void active.abort(); };
		args.signal.addEventListener("abort", abort, { once: true });
		try {
			args.signal.throwIfAborted();
			try { await session.prompt(args.prompt, { expandPromptTemplates: false }); }
			catch (error) {
				args.signal.throwIfAborted();
				throw new Error(`model '${selector}' failed: ${scrubResearchModelError(error)}`);
			}
			args.signal.throwIfAborted();
		} finally { args.signal.removeEventListener("abort", abort); }
		const last = [...session.messages].reverse().find(message => message.role === "assistant");
		if (last && `${last.provider}/${last.model}` !== selector) throw new Error("Pi investigation returned a different model");
		const rootError = !last || last.stopReason === "error" || last.stopReason === "aborted"
			? `model '${selector}' failed: ${scrubResearchModelError(last?.errorMessage ?? "no assistant response")}` : undefined;
		if (rootError) observeModelFailureText(rootError);
		emit(rootError ? "failed" : "succeeded", "status");
		return { usage, toolCalls, ...(rootError ? { rootError } : {}) };
	} catch (error) {
		emit(args.signal.aborted ? "cancelled" : "failed", "status");
		const message = scrubResearchModelError(error);
		if (!args.signal.aborted) observeModelFailureText(message);
		throw Object.assign(new Error(message), { usage, toolCalls });
	} finally {
		try { session?.dispose(); } finally { await sandbox?.close(); }
	}
}
