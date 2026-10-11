import { fork } from "node:child_process";
import { on } from "node:events";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedOutputLanguage } from "../../../shared/languages.js";
import { ResearchNodeError } from "../../agent-runtime/retry-policy.js";
import { writeJsonAtomic } from "../../lib/fs.js";
import { sha256 } from "../../lib/hash.js";
import { isRecord, toErrorMessage } from "../../lib/values.js";
import { runPiReader } from "./note-reader-pi.js";
import { publishReaderFile, validateReaderFile, type ReaderFileAcceptanceOptions } from "./reader-delivery.js";
import { assembleReaderNote } from "./reader-assembly.js";
import { snapshotSourceDirectory } from "./source-bundle.js";

type ReaderArgs = Parameters<typeof runPiReader>[0];
type RootConfig = Omit<ReaderArgs, "signal" | "validate" | "env" | "extensions" | "onEvent"> & {
	childModel: string; language: ResolvedOutputLanguage;
};
interface ChildConfig { id: string; work: string; runtimeRoot: string; task: string }
const WORKER = fileURLToPath(new URL("./note-reader-pi-worker.mjs", import.meta.url));
export const officialReaderSubagentPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "../examples/extensions/subagent/index.ts");

/** The upstream tool relaunches the current executable; keep that entry point outside the server. */
export async function runPiReaderSubagents(args: ReaderArgs & { childModel: string; language: ResolvedOutputLanguage;
	onSession?: (session: { id: string; path: string; label: string }) => void }) {
	args.signal.throwIfAborted();
	const configPath = join(args.runtimeRoot, "pi-root-config.json");
	const { signal, validate, env, extensions: _extensions, onEvent: _onEvent, onSession: _onSession, ...config } = args;
	writeJsonAtomic(configPath, config);
	const child = fork(WORKER, [], { cwd: args.runtimeRoot, execArgv: [], detached: true,
		env: { ...env, TELOMI_PI_READER_CONFIG: configPath }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let validations = Promise.resolve();
	let registrationError: Error | undefined;
	const stop = (name: NodeJS.Signals) => {
		if (!child.pid) return;
		try { process.kill(-child.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	};
	let force: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => { stop("SIGTERM"); force ??= setTimeout(() => stop("SIGKILL"), 15_000); };
	const failRegistration = (error: unknown) => {
		registrationError = error instanceof Error ? error : new Error(toErrorMessage(error));
		cancel();
	};
	child.stdout?.on("data", chunk => appendFileSync(join(args.runtimeRoot, "stdout.txt"), chunk));
	child.stderr?.on("data", chunk => appendFileSync(join(args.runtimeRoot, "stderr.txt"), chunk));
	child.on("message", message => {
		if (!isRecord(message)) return;
		if (message.type === "reader_child_registered") {
			try {
				if (typeof message.id !== "string" || !/^sub-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(message.id)) {
					throw new Error("Pi Reader child Session registration has an invalid identity");
				}
				const sessionPath = resolve(args.runtimeRoot, "children", message.id, "session.jsonl");
				if (message.sessionPath !== sessionPath) throw new Error("Pi Reader child Session registration is outside this execution");
				args.onSession?.({ id: message.id, path: sessionPath, label: `Reader ${message.id}` });
				child.send({ type: "reader_child_registered_ack", id: message.id }, error => { if (error) failRegistration(error); });
			} catch (error) { failRegistration(error); }
			return;
		}
		if (message.type !== "stage_output_candidate") return;
		validations = validations.then(async () => {
			let error: string | undefined;
			try { signal.throwIfAborted(); await assembleReaderNote({ work: args.work, runtimeRoot: args.runtimeRoot, signal }); await validate(); }
			catch (cause) {
				error = toErrorMessage(cause);
				appendFileSync(join(args.runtimeRoot, "reader-assembly-errors.jsonl"), `${JSON.stringify({ submission: message.submission, error })}\n`);
			}
			if (child.connected && !signal.aborted) child.send({ type: "stage_output_validation", submission: message.submission,
				accepted: error === undefined, ...(error ? { error } : {}) }, () => undefined);
		});
	});
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	try {
		const code = await new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("close", done); });
		await validations;
		if (signal.aborted) throw new ResearchNodeError("Pi Reader cancelled", "cancelled", false);
		if (registrationError) throw registrationError;
		if (code !== 0) {
			const failure = existsSync(join(args.runtimeRoot, "failure.json"))
				? JSON.parse(readFileSync(join(args.runtimeRoot, "failure.json"), "utf8")) : { error: `Pi Reader worker exited ${code}` };
			throw new ResearchNodeError(failure.error, failure.failureClass === "validation" ? "validation" : "provider", true);
		}
		const result = JSON.parse(readFileSync(join(args.runtimeRoot, "result.json"), "utf8"));
		return { usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
			costUsd: result.usage.cost_usd, calls: result.usage.model_calls } };
	} finally {
		signal.removeEventListener("abort", cancel); if (force) clearTimeout(force);
		stop("SIGKILL"); await validations;
	}
}

/** Wrap permissions and accepted-file delivery, retaining the upstream scheduler and native subprocess transport. */
export function piReaderSubagentExtension(config: RootConfig): NonNullable<ReaderArgs["extensions"]> {
	const discovery = join(config.runtimeRoot, "dispatch");
	mkdirSync(join(discovery, ".pi", "agents"), { recursive: true });
	writeFileSync(join(discovery, ".pi", "agents", "reader.md"),
		`---\nname: reader\ndescription: Read an assigned part of the original question and deliver validated Cue Notes.\nmodel: ${config.childModel}\ntools: read, bash, edit, write\n---\n`);
	writeJsonAtomic(join(config.runtimeRoot, "official-subagent.json"), { path: officialReaderSubagentPath,
		sha256: sha256(readFileSync(officialReaderSubagentPath)), agents_sha256: sha256(readFileSync(join(dirname(officialReaderSubagentPath), "agents.ts"))),
		adaptation: "Unmodified upstream scheduling and subprocess transport; runtime-owned workspaces and validated file receipts" });
	return { additionalExtensionPaths: [officialReaderSubagentPath], extensionsOverride: loaded => {
		const tools = loaded.extensions.flatMap(extension => [...extension.tools.values()]).filter(tool => tool.definition.name === "subagent");
		if (tools.length !== 1) throw new Error("Expected exactly one official subagent extension");
		const tool = tools[0]!;
		const original = tool.definition as ToolDefinition<any, any>;
		const { chain: _chain, ...properties } = original.parameters.properties;
		tool.definition = { ...original, executionMode: "sequential" as const, parameters: { ...original.parameters, properties },
			description: "Delegate to the reader agent using the official single (agent + task) or parallel (tasks array) modes. Runtime pins its model and assigns isolated working directories. Accepted results are file receipts. Chain mode is disabled because it passes unvalidated final text between agents.",
			execute: async (callId, params, signal, onUpdate, context) => {
			signal?.throwIfAborted();
			if (!isRecord(params)) throw new Error("Invalid subagent parameters");
			if (params.chain !== undefined) throw new Error("Reader chain mode is disabled; use single or parallel tasks with accepted file references");
			const parallel = Array.isArray(params.tasks) ? params.tasks : [];
			const list = (parallel.length ? parallel : params.agent && params.task ? [params] : [])
				.map((item: unknown) => { if (!isRecord(item)) throw new Error("Invalid Reader task"); return item; });
			const modeCount = Number(Boolean(parallel.length)) + Number(Boolean(params.agent && params.task));
			const ctx = { ...context, cwd: discovery, hasUI: false };
			if (modeCount !== 1 || parallel.length > 8) return original.execute(callId, params, signal, onUpdate, ctx);
			const allocated: ChildConfig[] = list.map((item: { agent?: unknown; task?: unknown }) => {
				if (item.agent !== "reader" || typeof item.task !== "string" || !item.task.trim()) throw new Error("Only the reader agent with a nonempty task is available");
				const id = `sub-${randomUUID()}`, runtimeRoot = join(config.runtimeRoot, "children", id);
				const work = join(runtimeRoot, "work");
				mkdirSync(work, { recursive: true });
				const child = { id, work, runtimeRoot, task: item.task };
				writeJsonAtomic(join(runtimeRoot, "config.json"), child);
				return child;
			});
			const normalized = list.map((item: Record<string, unknown>, index: number) => ({ ...item, cwd: allocated[index]!.work }));
			const fixed = { ...params, agentScope: "project", confirmProjectAgents: false,
				...(parallel.length ? { tasks: normalized } : { cwd: allocated[0]!.work }) };
			for (const child of allocated) await registerReaderChild(child, signal);
			const native = await original.execute(callId, fixed, signal, onUpdate, ctx);
			signal?.throwIfAborted();
			const receipts = allocated.map(child => {
				const path = join(config.work, "inputs", "reader-results", child.id, "1", "receipt.json");
				if (!existsSync(path)) return { child_id: child.id, task: child.task, status: "failed", error: "No accepted file; inspect retained child diagnostics" };
				const receipt = JSON.parse(readFileSync(path, "utf8"));
				if (receipt.child_id !== child.id || receipt.note_sha256 !== sha256(readFileSync(join(dirname(path), "note.json")))) throw new Error("Reader receipt integrity check failed");
				return receipt;
			});
			const nativeFailures = isRecord(native.details) && Array.isArray(native.details.results)
				&& native.details.results.some((result: unknown) => isRecord(result)
					&& (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"));
			return { ...native, content: [{ type: "text", text: JSON.stringify({ results: receipts }) }],
				isError: ("isError" in native && native.isError === true) || nativeFailures || receipts.some(receipt => receipt.status === "failed") };
		} };
		return loaded;
	} };
}

async function registerReaderChild(child: ChildConfig, signal?: AbortSignal) {
	signal?.throwIfAborted();
	if (!process.send || !process.connected) throw new Error("Pi Reader requires a live Session registration channel");
	const replies = on(process, "message", { signal, close: ["disconnect"] });
	try {
		await new Promise<void>((done, fail) => process.send!({ type: "reader_child_registered", id: child.id,
			sessionPath: join(child.runtimeRoot, "session.jsonl") }, error => error ? fail(error) : done()));
		for await (const [reply] of replies) {
			if (isRecord(reply) && reply.type === "reader_child_registered_ack" && reply.id === child.id) return;
		}
		throw new Error("Pi Reader Session registration channel closed");
	} finally { await replies.return?.(); }
}

export async function runPiReaderWorker(signal: AbortSignal) {
	const configPath = process.env.TELOMI_PI_READER_CONFIG;
	if (!configPath) throw new Error("Pi Reader worker requires its private configuration");
	const config: RootConfig = JSON.parse(readFileSync(configPath, "utf8"));
	const rootMode = !process.argv.includes("--mode");
	if (rootMode) {
		const { requestPrimeOutputValidation } = await import("../../agent-runtime/prime-worker-control.js");
		let submission = 0;
		try {
			await runPiReader({ ...config, env: process.env, signal, extensions: piReaderSubagentExtension(config),
				validate: async () => { const reply = await requestPrimeOutputValidation(++submission, signal); if (!reply.accepted) throw new Error(reply.error); } });
		} finally {
			if (existsSync(join(config.runtimeRoot, "result.json"))) copyFileSync(join(config.runtimeRoot, "result.json"), join(config.runtimeRoot, "root-result.json"));
			// Native subprocess handles keep the worker alive until all cancelled siblings have closed.
			process.once("beforeExit", () => aggregatePiReaderUsage(config));
		}
		return;
	}
	const childRoot = dirname(realpathSync(process.cwd()));
	if (dirname(childRoot) !== resolve(config.runtimeRoot, "children")) throw new Error("Pi child working directory is outside this execution");
	const child: ChildConfig = JSON.parse(readFileSync(join(childRoot, "config.json"), "utf8"));
	if (realpathSync(child.work) !== realpathSync(process.cwd()) || child.runtimeRoot !== childRoot) throw new Error("Pi child configuration mismatch");
	const task = process.argv.at(-1)!;
	if (!task.startsWith("Task: ") || !task.slice(6).trim()) throw new Error("Missing native subagent assignment");
	const [provider, ...parts] = config.childModel.split("/");
	writeJsonAtomic(join(childRoot, "assignment.json"), { child_id: child.id, task: task.slice(6), original_task: child.task });
	// Mounts are supplied by the same SRT tool operations as the standalone Pi Reader.
	const { symlinkSync } = await import("node:fs");
	// A real Source tree lets native find/grep traverse it without special symlink flags.
	snapshotSourceDirectory(join(config.work, "source"), join(child.work, "source"));
	symlinkSync(join(config.work, "inputs"), join(child.work, "inputs"), "dir");
	let submissions = 0;
	let options: ReaderFileAcceptanceOptions | undefined;
	let candidate: Awaited<ReturnType<typeof validateReaderFile>> | undefined;
	try {
		const childPrompt = readFileSync(join(config.work, "inputs", "reader-child-prompt.md"), "utf8");
		const childSystemPrompt = readFileSync(join(config.work, "inputs", "reader-child-system.md"), "utf8");
		await runPiReader({ work: child.work, runtimeRoot: childRoot, provider, modelId: parts.join("/"), thinking: config.thinking,
			systemPrompt: childSystemPrompt,
			userPrompt: `${childPrompt}\n\n<original-reader-context>\n${config.userPrompt}\n</original-reader-context>\n\n<assigned-child-task>\n${task.slice(6)}\n</assigned-child-task>`,
			env: process.env, signal, sessionRole: "child",
			onEvent: event => { if (event.type === "message_end") process.stdout.write(`${JSON.stringify(event)}\n`); },
			validate: async () => {
				const conditions = JSON.parse(readFileSync(join(childRoot, "conditions.json"), "utf8"));
				options = { root: config.work, runtimeRoot: config.runtimeRoot, workspace: child.work,
					identity: { child_id: child.id, session_id: conditions.session_id, revision: 1, task: task.slice(6) },
					submission: ++submissions, language: config.language, signal };
				try { candidate = await validateReaderFile(options); }
				catch (error) { appendFileSync(join(childRoot, "validation-errors.jsonl"), `${JSON.stringify({ submission: submissions, error: toErrorMessage(error) })}\n`); throw error; }
			} });
		if (!options || !candidate) throw new Error("Child completed without accepted output");
		const receipt = publishReaderFile(options, candidate);
		appendFileSync(join(config.runtimeRoot, "reader-delivery.jsonl"), `${JSON.stringify({ type: "reader_delivery_accepted", ...receipt })}\n`);
	} finally {
		const draft = join(child.work, "note.json");
		if (existsSync(draft)) {
			const stat = lstatSync(draft);
			if (stat.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024) copyFileSync(draft, join(childRoot, "last-draft.json"));
		}
		rmSync(child.work, { recursive: true, force: true });
		writeJsonAtomic(join(childRoot, "closed.json"), { at: new Date().toISOString(), cancelled: signal.aborted });
	}
}

function aggregatePiReaderUsage(config: RootConfig) {
	const rootPath = join(config.runtimeRoot, "root-result.json");
	if (!existsSync(rootPath)) return;
	const root = JSON.parse(readFileSync(rootPath, "utf8"));
	const directory = join(config.runtimeRoot, "children");
	const children = existsSync(directory) ? readdirSync(directory).filter(id => existsSync(join(directory, id, "result.json"))) : [];
	for (const id of children) {
		const child = JSON.parse(readFileSync(join(directory, id, "result.json"), "utf8"));
		for (const key of ["input_tokens", "output_tokens", "cost_usd", "model_calls"]) root.usage[key] += child.usage[key];
		for (const [name, count] of Object.entries(child.tool_counts)) root.tool_counts[name] = (root.tool_counts[name] ?? 0) + Number(count);
		root.tool_calls += child.tool_calls; root.turns += child.turns;
	}
	writeJsonAtomic(join(config.runtimeRoot, "result.json"), { ...root, child_count: children.length,
		effective_child_model: config.childModel, delegation: "official_pi_subagent" });
}
