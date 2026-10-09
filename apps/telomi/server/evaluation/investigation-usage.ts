import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { readRuntimeRecords, type RuntimeContextEvent } from "../observability/run-records.js";

type StageKind = "root" | "search" | "reader" | "writer";
export interface InvestigationStageUsage {
	kind: StageKind;
	executionId: string;
	status: string;
	source: "root-usage" | "terminal-metrics" | "native-trace" | "partial-records";
	usage: ResearchModelUsage;
	toolCalls: number;
	complete: boolean;
	evidenceRefs: string[];
}

export interface InvestigationUsageSummary {
	schemaVersion: 1;
	scope: "live-investigation";
	usage: ResearchModelUsage;
	toolCalls: number;
	complete: boolean;
	stages: InvestigationStageUsage[];
	missing: string[];
	tokenAccounting: {
		inputTokens: "uncached input; cached read/write tokens are excluded";
		cacheReadTokens: null;
		cacheWriteTokens: null;
		totalTokens: null;
	};
	costBasis: string;
}

const empty = (): ResearchModelUsage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => nonnegative(value) && Number.isInteger(value);
function metrics(value: unknown): ResearchModelUsage | undefined {
	const item = record(value);
	return nonnegative(item.input_tokens) && nonnegative(item.output_tokens) && nonnegative(item.cost_usd) && count(item.model_calls)
		? { inputTokens: item.input_tokens, outputTokens: item.output_tokens, costUsd: item.cost_usd, calls: item.model_calls } : undefined;
}
/** Preserve individually known spend even if another metric is absent. */
function knownMetrics(value: unknown, fallback: ResearchModelUsage = empty()): ResearchModelUsage {
	const item = record(value);
	return { inputTokens: nonnegative(item.input_tokens) ? item.input_tokens : fallback.inputTokens,
		outputTokens: nonnegative(item.output_tokens) ? item.output_tokens : fallback.outputTokens,
		costUsd: nonnegative(item.cost_usd) ? item.cost_usd : fallback.costUsd,
		calls: count(item.model_calls) ? item.model_calls : fallback.calls };
}
function children(path: string, directories: boolean): string[] {
	if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return [];
	return readdirSync(path, { withFileTypes: true }).filter(entry => directories ? entry.isDirectory() : entry.isFile()).map(entry => entry.name).sort();
}
function traceFile(directory: string, ref: unknown): string | undefined {
	return typeof ref === "string" && basename(ref) === ref && ref.endsWith(".jsonl") ? join(directory, ref) : undefined;
}

/** Called after bridge/worker settlement, before immutable Case capture. Search
 * terminal metrics already include acquisition Root, Provider children and Organizer.
 * Failed executions retain known recorded spend, but never become complete by inference. */
export function collectInvestigationUsage(input: {
	runDir: string;
	goalDir: string;
	investigationId: string;
	rootUsage?: ResearchModelUsage;
	rootToolCalls?: number;
}): InvestigationUsageSummary {
	if (!/^[a-f0-9]{24}$/u.test(input.investigationId)) throw new Error("Invalid investigation usage scope");
	const stages: InvestigationStageUsage[] = [];
	const missing: string[] = [];
	const seenExecutions = new Map<string, string>();
	const seenResponses = new Set<string>();
	const recover = (paths: string[], executionId: string): { usage: ResearchModelUsage; toolCalls: number; evidenceRefs: string[] } => {
		const usage = empty();
		let toolCalls = 0;
		const evidenceRefs: string[] = [];
		for (const path of [...new Set(paths)]) {
			if (!existsSync(path)) continue;
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink()) { missing.push(`${executionId}: unsafe usage trace ${path}`); continue; }
			evidenceRefs.push(path);
			let sessionId: string | undefined;
			for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
				if (!line.trim()) continue;
				let row: Record<string, unknown>;
				try { row = record(JSON.parse(line)); } catch { missing.push(`${executionId}: malformed trace line ${index + 1}`); continue; }
				if (row.type === "session" && typeof row.id === "string") sessionId = row.id;
				const message = row.type === "message" ? record(row.message) : row;
				if (message.role !== "assistant") continue;
				const key = typeof message.responseId === "string" && message.responseId ? JSON.stringify([message.provider, message.model, message.responseId])
					: sessionId && typeof row.id === "string" ? `${sessionId}:${row.id}` : `${path}:${index}`;
				if (seenResponses.has(key)) continue;
				seenResponses.add(key);
				const raw = record(message.usage);
				const fields = { input_tokens: raw.input, output_tokens: raw.output, cost_usd: record(raw.cost).total, model_calls: Object.keys(raw).length ? 1 : undefined };
				if (!metrics(fields)) missing.push(`${executionId}: assistant usage unavailable at ${path}:${index + 1}`);
				add(usage, knownMetrics(fields));
				toolCalls += Array.isArray(message.content) ? message.content.filter(part => record(part).type === "toolCall").length : 0;
			}
		}
		return { usage, toolCalls, evidenceRefs };
	};
	const rootFields = input.rootUsage && { input_tokens: input.rootUsage.inputTokens, output_tokens: input.rootUsage.outputTokens,
		cost_usd: input.rootUsage.costUsd, model_calls: input.rootUsage.calls };
	const rootUsage = metrics(rootFields);
	const rootComplete = Boolean(rootUsage && count(input.rootToolCalls));
	const recoveredRoot = rootUsage ? undefined : recover([join(input.runDir, "trace.jsonl")], input.investigationId);
	if (!rootComplete) missing.push("Investigation Root has no complete terminal usage/tool count");
	stages.push({ kind: "root", executionId: input.investigationId, status: rootComplete ? "settled" : "unknown", source: rootUsage ? "root-usage" : "native-trace",
		usage: rootUsage ?? knownMetrics(rootFields, recoveredRoot!.usage), toolCalls: count(input.rootToolCalls) ? input.rootToolCalls : recoveredRoot?.toolCalls ?? 0,
		complete: rootComplete, evidenceRefs: recoveredRoot?.evidenceRefs ?? [join(input.runDir, "trace.jsonl")] });

	const collect = (directory: string, kind: Exclude<StageKind, "root">, agent: string, expected = false): void => {
		let events: RuntimeContextEvent[];
		try { events = readRuntimeRecords(directory, "research"); }
		catch {
			missing.push(`${kind}: unreadable Runtime records at ${directory}`);
			// A truncated final record must not erase the spend of earlier attempts.
			events = [];
			try {
				for (const line of readFileSync(join(directory, "runtime--research.jsonl"), "utf8").split("\n")) {
					try { const item = record(JSON.parse(line)); if (typeof item.type === "string") events.push(item as RuntimeContextEvent); } catch { /* partial record */ }
				}
			} catch { /* the missing entry above preserves the unavailable scope */ }
		}
		const ids = new Set(events.filter(event => event.agent === agent && (event.type === "runtime.agent_bound"
			|| event.type === "node_execution" && event.node_type === "agent")).flatMap(event => typeof event.execution_id === "string" ? [event.execution_id] : []));
		if (expected && !ids.size) missing.push(`${kind}: invocation has no recorded execution at ${directory}`);
		for (const executionId of ids) {
			const owned = events.filter(event => event.agent === agent && event.execution_id === executionId);
			const terminals = owned.filter(event => event.type === "node_execution" && event.node_type === "agent");
			const terminal = terminals[0];
			const raw = record(record(terminal?.output).metrics);
			const usage = metrics(raw);
			const fingerprint = JSON.stringify([terminal?.status, raw]);
			const identity = `${kind}:${executionId}`;
			const previous = seenExecutions.get(identity);
			if (previous !== undefined) {
				if (previous !== fingerprint) missing.push(`${identity}: conflicting duplicated execution metrics`);
				continue;
			}
			seenExecutions.set(identity, fingerprint);
			const conflict = terminals.some(event => JSON.stringify([event.status, record(record(event.output).metrics)]) !== fingerprint);
			const complete = Boolean(terminal && ["succeeded", "failed", "cancelled", "interrupted"].includes(String(terminal.status)) && usage && count(raw.tool_calls) && !conflict);
			const status = typeof terminal?.status === "string" ? terminal.status : "unfinished";
			if (!complete) missing.push(`${identity}: incomplete terminal metrics (${status})`);
			const binding = owned.find(event => event.type === "runtime.agent_bound");
			const path = traceFile(directory, terminal?.trace_ref ?? binding?.session_file);
			const recoveryPaths = kind === "search" ? searchTraces(directory, executionId, path, ids.size === 1) : path ? [path] : [];
			const recovered = usage ? undefined : recover(recoveryPaths, executionId);
			stages.push({ kind, executionId, status, source: usage ? "terminal-metrics" : Object.keys(raw).length ? "partial-records" : "native-trace", usage: usage ?? knownMetrics(raw, recovered!.usage),
				toolCalls: count(raw.tool_calls) ? raw.tool_calls : recovered?.toolCalls ?? 0, complete,
				evidenceRefs: [join(directory, "runtime--research.jsonl"), ...(recovered?.evidenceRefs ?? [])] });
		}
	};
	const writerExpected = children(input.runDir, true).some(name => /^answer-\d+$/u.test(name))
		|| existsSync(join(input.runDir, "result.json"));
	collect(input.runDir, "writer", "report_writer", writerExpected);
	for (const directory of children(input.runDir, true).filter(name => /^external-search-\d+$/u.test(name))) collect(join(input.runDir, directory), "search", "prime_search", true);
	const readers = join(input.goalDir, ".pi", "runtime", "note-reading");
	for (const directory of children(readers, true).filter(name => new RegExp(`^${input.investigationId}-(?:external-)?[0-9]+$`, "u").test(name))) {
		collect(join(readers, directory), "reader", "note_agent", true);
	}
	const usage = empty();
	for (const stage of stages) add(usage, stage.usage);
	return { schemaVersion: 1, scope: "live-investigation", usage, toolCalls: stages.reduce((sum, stage) => sum + stage.toolCalls, 0),
		complete: stages.every(stage => stage.complete) && missing.length === 0, stages, missing,
		tokenAccounting: { inputTokens: "uncached input; cached read/write tokens are excluded", cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null },
		costBasis: "Recorded model-price estimates, including recorded failed attempts; not an account bill. Cache token totals are not retained by terminal metrics. Main pre-turn work and Provider HTTP/service charges are outside this scope." };
}

function add(total: ResearchModelUsage, usage: ResearchModelUsage): void {
	total.inputTokens += usage.inputTokens; total.outputTokens += usage.outputTokens; total.costUsd += usage.costUsd; total.calls += usage.calls;
}

/** Exact runtime session layouts only; never recurse through Source/input/Case copies. */
function searchTraces(directory: string, executionId: string, rootTrace: string | undefined, singleExecution: boolean): string[] {
	const archives = basename(executionId) === executionId ? [join(directory, "prime-search-traces", executionId)] : [];
	const workspaces = singleExecution ? children(join(directory, "workspaces"), true).filter(name => /^search-batch-\d+$/u.test(name))
		.map(name => join(directory, "workspaces", name, "runtime")) : [];
	const native = (root: string): string[] => ["acquisition-session", "organizer-session"].flatMap(scope => {
		const session = join(root, scope, "session");
		return children(session, false).filter(name => name.endsWith(".jsonl")).map(name => join(session, name));
	});
	const rootFiles = archives.flatMap(native);
	const chosen = rootFiles.length ? archives : workspaces;
	const files = rootFiles.length ? rootFiles : workspaces.flatMap(native);
	if (!files.length && rootTrace) files.push(rootTrace);
	for (const root of [...new Set([...archives, ...chosen])]) {
		const childrenRoot = join(root, "acquisition-session", "session-artifacts");
		for (const child of children(childrenRoot, true).filter(name => /^sub-[A-Za-z0-9-]+$/u.test(name))) {
			for (const file of children(join(childrenRoot, child), false).filter(name => name.endsWith(".jsonl"))) files.push(join(childrenRoot, child, file));
		}
	}
	return files;
}
