import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { delay, toErrorMessage } from "../../lib/values.js";
import WebSocket from "ws";

import { safeName } from "../../lib/paths.js";
import { sha256 } from "../../lib/hash.js";
import { resolveDataDir } from "../../config/data-dir.js";
/**
 * Telomi browser-session ownership, built on native agent-browser 0.34.
 *
 * Every browser task runs inside a stable Telomi namespace (AGENT_BROWSER_NAMESPACE)
 * so agent-browser keeps all of its daemon sidecars - `<session>.{pid,sock,stream,
 * target,config}` - under `<home>/namespaces/<namespace>/run/`, never in the global
 * `~/.agent-browser` root. Each actual run gets a fresh, pinned session; cleanup
 * reads the native `.target` sidecar to close exactly that run's tab, detaches the
 * daemon with `agent-browser close`, and proves the daemon is gone from the OS
 * process table. It never signals a pid it cannot confirm is our agent-browser
 * process, and never touches a session or file outside its own namespace.
 */

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
// Every CDP HTTP read here has a fallback; a browser that stops answering must not hold it for minutes.
const CDP_HTTP_TIMEOUT_MS = 2_000;
/** agent-browser daemon self-shutdown backstop for a leaked/crashed owner. */
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_WORKSPACES = 2;
/** CSS viewport every task tab gets. A CDP-attached pinned tab otherwise inherits the host window. */
const TASK_VIEWPORT = { width: 1280, height: 720 };
const SCREENSHOT_TIMEOUT_MS = 5_000;

export type BrowserReleaseReason =
	| "completed"
	| "aborted"
	| "error"
	| "shutdown"
	| "crash-backstop";

/** Exact environment a single run's browser subprocesses must inherit. */
export interface BrowserRunEnv {
	AGENT_BROWSER_CONFIG: string;
	AGENT_BROWSER_SOCKET_DIR: string;
	AGENT_BROWSER_CDP: string;
	AGENT_BROWSER_NAMESPACE: string;
	AGENT_BROWSER_SESSION: string;
	AGENT_BROWSER_PIN_TAB: "1";
	AGENT_BROWSER_IDLE_TIMEOUT_MS: string;
}

interface ActiveTask {
	controller: AbortController;
	ownerId: string;
	scopeId: string;
	goalId: string;
	runId: string;
	sessionId: string;
	startedAt: string;
	admitted: boolean;
	admission?: Promise<void>;
	control: BrowserControl;
	viewportReady: boolean;
	inFlight: number;
	idleWaiters: Array<() => void>;
	agentWaiters: PendingControl[];
}

export type BrowserControl = "agent" | "delegating" | "user";
export type BrowserSessionState = "queued" | "starting" | "live";

interface PendingAdmission {
	task: ActiveTask;
	signal?: AbortSignal;
	resolve(): void;
	reject(error: unknown): void;
	onAbort?: () => void;
}

interface PendingControl {
	signal?: AbortSignal;
	resolve(): void;
	reject(error: unknown): void;
	onAbort?: () => void;
}

interface CdpTargetInfo {
	targetId: string;
	type: string;
	openerId?: string;
	openerFrameId?: string;
}

/** Internal observability snapshot of a goal's active browser task. */
export interface BrowserObservation {
	sessionId: string;
	runId: string;
	startedAt: string;
	live: boolean;
	state: BrowserSessionState;
	pinned?: boolean;
	targetId?: string;
	url?: string;
	control: BrowserControl;
}

/** Safe, presentational view for the UI - no raw CDP target handles. */
export interface BrowserTaskView {
	sessionId: string;
	runId: string;
	startedAt: string;
	live: boolean;
	state: BrowserSessionState;
	pinned?: boolean;
	url?: string;
	title?: string;
	control: BrowserControl;
}

export interface BrowserGoalTaskView extends BrowserTaskView {
	goalId: string;
}

export type BrowserSessionEvent =
	| { kind: "begin"; goalId: string; sessionId: string }
	| { kind: "release"; sessionId: string; reason: BrowserReleaseReason; outcome: string }
	| { kind: "sweep"; reclaimed: number }
	| { kind: "error"; sessionId?: string; message: string };

export interface BrowserSessionRegistryOptions {
	/** Stable namespace; defaults to TELOMI_BROWSER_NAMESPACE or a data-root hash. */
	namespace?: string;
	/** Data root used to derive a deterministic default namespace. */
	dataRoot?: string;
	cdpUrl?: string;
	/** agent-browser home; sidecars live under `<home>/namespaces/<ns>/run`. */
	daemonHome?: string;
	agentBrowserBin?: string;
	idleTimeoutMs?: number;
	sweepIntervalMs?: number;
	maxConcurrentWorkspaces?: number;
	onEvent?: (event: BrowserSessionEvent) => void;
	isProcessAlive?: (pid: number) => boolean;
	/** Confirms a pid is really our agent-browser daemon before any signal. */
	isAgentBrowserProcess?: (pid: number) => boolean;
}

export class BrowserSessionRegistry {
	private readonly active = new Map<string, ActiveTask>();
	private readonly closing = new Map<string, { task: ActiveTask; promise: Promise<void> }>();
	private readonly namespace: string;
	private readonly cdpUrl: string;
	private readonly daemonHome: string;
	private readonly runDir: string;
	private readonly agentBrowserBin: string;
	private readonly idleTimeoutMs: number;
	private readonly sweepIntervalMs: number;
	private readonly maxConcurrentWorkspaces: number;
	private readonly onEvent?: (event: BrowserSessionEvent) => void;
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly isAgentBrowserProcess: (pid: number) => boolean;
	private readonly queue: PendingAdmission[] = [];
	private activeWorkspaces = 0;
	private sweepTimer?: ReturnType<typeof setInterval>;

	constructor(options: BrowserSessionRegistryOptions = {}) {
		this.namespace = normalizeNamespace(
			options.namespace ?? process.env.TELOMI_BROWSER_NAMESPACE ?? defaultNamespace(options.dataRoot),
		);
		this.cdpUrl = normalizeCdpUrl(options.cdpUrl ?? process.env.TELOMI_BROWSER_HOST_CDP_URL ?? DEFAULT_CDP_URL);
		const daemonHome = options.daemonHome
			?? process.env.AGENT_BROWSER_SOCKET_DIR
			?? defaultSocketDirectory(options.dataRoot);
		mkdirSync(daemonHome, { recursive: true, mode: 0o700 });
		this.daemonHome = realpathSync(daemonHome);
		this.runDir = join(this.daemonHome, "namespaces", this.namespace, "run");
		this.agentBrowserBin = options.agentBrowserBin ?? process.env.AGENT_BROWSER_BIN ?? "agent-browser";
		writeFileSync(join(this.daemonHome, "config.json"), "{}\n", { mode: 0o600 });
		this.idleTimeoutMs = options.idleTimeoutMs
			?? positiveInt(process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS);
		this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
		this.maxConcurrentWorkspaces = options.maxConcurrentWorkspaces
			?? positiveInt(process.env.TELOMI_BROWSER_MAX_CONCURRENT_WORKSPACES, DEFAULT_MAX_CONCURRENT_WORKSPACES);
		this.onEvent = options.onEvent;
		this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
		this.isAgentBrowserProcess = options.isAgentBrowserProcess ?? isAgentBrowserProcess;
	}

	get config(): {
		namespace: string;
		cdpUrl: string;
		daemonHome: string;
		runDir: string;
		idleTimeoutMs: number;
		maxConcurrentWorkspaces: number;
		activeWorkspaces: number;
		queuedWorkspaces: number;
	} {
		return {
			namespace: this.namespace,
			cdpUrl: this.cdpUrl,
			daemonHome: this.daemonHome,
			runDir: this.runDir,
			idleTimeoutMs: this.idleTimeoutMs,
			maxConcurrentWorkspaces: this.maxConcurrentWorkspaces,
			activeWorkspaces: this.activeWorkspaces,
			queuedWorkspaces: this.queue.length,
		};
	}

	/** Begin a run: allocate a fresh, pinned session and return its exact env. */
	beginRun(goalId: string, runId: string): BrowserRunEnv {
		return this.beginTask({ ownerId: goalId, scopeId: `goal:${goalId}`, goalId, runId });
	}

	/** Register one Agent-owned Browser workspace. Capacity is acquired lazily on first use. */
	beginTask(input: { ownerId: string; scopeId: string; goalId: string; runId: string }): BrowserRunEnv {
		if (this.closing.has(input.ownerId)) throw new Error(`Browser workspace '${input.ownerId}' is still closing`);
		const existing = this.active.get(input.ownerId);
		if (existing) {
			if (existing.controller.signal.aborted) throw new Error(`Browser workspace '${input.ownerId}' is awaiting cleanup`);
			if (existing.scopeId === input.scopeId && existing.runId === input.runId) {
				return this.envForSession(existing.sessionId);
			}
			throw new Error(`Browser owner '${input.ownerId}' already has an active workspace`);
		}
		const sessionId = sessionIdFor(input.runId, input.ownerId);
		this.active.set(input.ownerId, {
			controller: new AbortController(),
			ownerId: input.ownerId,
			scopeId: input.scopeId,
			goalId: input.goalId,
			runId: input.runId,
			sessionId,
			startedAt: new Date().toISOString(),
			admitted: false,
			control: "agent",
			viewportReady: false,
			inFlight: 0,
			idleWaiters: [],
			agentWaiters: [],
		});
		this.onEvent?.({ kind: "begin", goalId: input.goalId, sessionId });
		return this.envForSession(sessionId);
	}

	/** Execute one validated agent-browser invocation on the host for this run. */
	async execute(
		ownerId: string,
		args: string[],
		options: { signal?: AbortSignal; onData?: (chunk: Buffer) => void } = {},
	): Promise<{ exitCode: number }> {
		const task = this.active.get(ownerId);
		if (!task) throw new Error(`No active Browser workspace for owner: ${ownerId}`);
		validateAgentBrowserArgs(args);
		if (["help", "--help", "-h"].includes(args[0] ?? "")) {
			options.onData?.(Buffer.from(`${browserHelpText()}\n`));
			return { exitCode: 0 };
		}
		await this.admit(task, options.signal);
		if (["open", "read", "reload"].includes(args[0] ?? "")) return this.navigate(task, args, options);
		return { exitCode: await this.runAgentCommand(task, args, options) };
	}

	/**
	 * A navigation may land on a site verification interstitial (Cloudflare and the like) that
	 * clears itself a few seconds later and then reloads the real page. Returning the interstitial
	 * as if it were the page makes the Agent give up on a source it could have read, so the
	 * Runtime waits for the challenge to clear and repeats the navigation. One that does not clear
	 * is reported as a blocked page with what to do instead, not as page text.
	 */
	private async navigate(
		task: ActiveTask,
		args: string[],
		options: { signal?: AbortSignal; onData?: (chunk: Buffer) => void },
	): Promise<{ exitCode: number }> {
		const attempt = async (): Promise<{ exitCode: number; output: string }> => {
			const chunks: Buffer[] = [];
			const exitCode = await this.runAgentCommand(task, args, { signal: options.signal, onData: (chunk) => chunks.push(chunk) });
			return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
		};
		let result = await attempt();
		for (let round = 0; result.exitCode === 0 && looksLikeChallenge(result.output) && round < CHALLENGE_POLLS; round++) {
			await this.runAgentCommand(task, ["wait", String(CHALLENGE_POLL_MS)], { signal: options.signal });
			const title: Buffer[] = [];
			await this.runAgentCommand(task, ["get", "title"], { signal: options.signal, onData: (chunk) => title.push(chunk) });
			if (looksLikeChallenge(Buffer.concat(title).toString("utf8"))) continue;
			result = await attempt();
		}
		if (result.exitCode === 0 && looksLikeChallenge(result.output)) {
			const target = args[0] === "open" || (args[0] === "read" && args[1]) ? args[1] : "the current page";
			options.onData?.(Buffer.from(
				`page_blocked: ${target} answered with a site verification challenge that did not clear within `
				+ `${(CHALLENGE_POLLS * CHALLENGE_POLL_MS) / 1000}s. The site is refusing automated access right now. `
				+ "Record the source as blocked with this reason, then try a publisher mirror or archive URL, "
				+ "or find the same content through another Provider. Do not retry the same URL in a loop.\n",
			));
			return { exitCode: 1 };
		}
		options.onData?.(Buffer.from(result.output));
		return { exitCode: result.exitCode };
	}

	/** Download one page-owned attachment into a Runtime-validated path. */
	async download(
		ownerId: string,
		ref: string,
		outputPath: string,
		options: { signal?: AbortSignal; onData?: (chunk: Buffer) => void } = {},
	): Promise<{ exitCode: number }> {
		const task = this.active.get(ownerId);
		if (!task) throw new Error(`No active Browser workspace for owner: ${ownerId}`);
		if (!/^@e[1-9][0-9]*$/u.test(ref)) throw new Error("Browser download requires a current snapshot ref");
		await this.admit(task, options.signal);
		return { exitCode: await this.runAgentCommand(task, ["download", ref, outputPath], options) };
	}

	/** Exact env of a goal's active run, or undefined if no run is active. */
	envForActiveRun(goalId: string): BrowserRunEnv | undefined {
		const task = this.active.get(goalId);
		return task ? this.envForSession(task.sessionId) : undefined;
	}

	/**
	 * End a run: close exactly this run's tab and detach its daemon. Idempotent
	 * and safe if the run never opened a browser. Clears the active slot only if
	 * it still points at this run.
	 */
	async endRun(goalId: string, runId: string, reason: BrowserReleaseReason): Promise<void> {
		const current = this.active.get(goalId) ?? this.closing.get(goalId)?.task;
		if (!current || current.runId !== runId) return;
		await this.endTask(goalId, reason);
	}

	/** Release one Agent workspace and its global capacity permit. */
	async endTask(ownerId: string, reason: BrowserReleaseReason): Promise<void> {
		const closing = this.closing.get(ownerId);
		if (closing) return closing.promise;
		const task = this.active.get(ownerId);
		if (!task) return;
		this.active.delete(ownerId);
		task.controller.abort(new Error(`Browser workspace '${ownerId}' was released`));
		this.settleAgentWaiters(task, new Error(`Browser workspace '${ownerId}' was released`));
		this.cancelAdmission(task, new Error(`Browser workspace '${ownerId}' was released`));
		const cleanup = (async () => {
			try {
				// A command may still be starting the daemon. Detach only after it finishes.
				if (task.inFlight > 0) await new Promise<void>((resolve) => task.idleWaiters.push(resolve));
				await this.detach(task.sessionId, reason);
				if (task.admitted) {
					task.admitted = false;
					this.activeWorkspaces -= 1;
				}
			} catch (error) {
				// Keep the owner and permit until teardown succeeds; sweep retries aborted tasks.
				this.active.set(ownerId, task);
				throw error;
			} finally {
				this.closing.delete(ownerId);
				this.drainQueue();
			}
		})();
		this.closing.set(ownerId, { task, promise: cleanup });
		return cleanup;
	}

	/** Release every Browser workspace belonging to one Prime/Research scope. */
	async endScope(scopeId: string, reason: BrowserReleaseReason): Promise<void> {
		await Promise.all([...this.active.values(), ...[...this.closing.values()].map(({ task }) => task)]
			.filter((task) => task.scopeId === scopeId)
			.map((task) => this.endTask(task.ownerId, reason)));
	}

	/** Observability snapshots for every active Browser Worker in one goal. */
	observations(goalId: string): BrowserObservation[] {
		return [...this.active.values()]
			.filter((candidate) => candidate.goalId === goalId)
			.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
			.map((task) => {
				const target = this.readTargetSidecar(task.sessionId);
				const live = Boolean(target?.targetId) && this.isSessionLive(task.sessionId);
				return {
					sessionId: task.sessionId,
					runId: task.runId,
					startedAt: task.startedAt,
					live,
					state: live ? "live" : task.admitted ? "starting" : "queued",
					control: task.control,
					...(target?.pinned !== undefined ? { pinned: target.pinned } : {}),
					...(target?.targetId ? { targetId: target.targetId } : {}),
					...(target?.url ? { url: target.url } : {}),
				};
			});
	}

	/** Observability snapshot for the newest active browser task in a goal. */
	observe(goalId: string): BrowserObservation | undefined {
		return this.observations(goalId)[0];
	}

	/**
	 * Safe UI view of a goal's active browser task. Resolves the page title from
	 * the shared CDP host by the bound target id, but never returns the raw target
	 * handle or the CDP url to callers.
	 */
	async describe(goalId: string): Promise<BrowserTaskView | undefined> {
		return (await this.describeAll(goalId))[0];
	}

	/** Safe UI views for every active Browser Worker in a goal. */
	async describeAll(goalId: string): Promise<BrowserTaskView[]> {
		const observations = this.observations(goalId);
		let targets: Array<{ id?: string; title?: string }> = [];
		if (observations.some((observation) => observation.targetId)) {
			try {
				targets = await (await this.cdpFetch("/json/list")).json() as Array<{ id?: string; title?: string }>;
			} catch {
				/* titles are best-effort */
			}
		}
		return observations.map((observation) => {
			const title = targets.find((target) => target.id === observation.targetId)?.title;
			return {
				sessionId: observation.sessionId,
				runId: observation.runId,
				startedAt: observation.startedAt,
				live: observation.live,
				state: observation.state,
				control: observation.control,
				...(observation.pinned !== undefined ? { pinned: observation.pinned } : {}),
				...(observation.url ? { url: observation.url } : {}),
				...(title ? { title } : {}),
			};
		});
	}

	/** Safe UI views for every active Browser Worker across all goals. */
	async describeActive(): Promise<BrowserGoalTaskView[]> {
		const goalIds = new Set([...this.active.values()].map((task) => task.goalId));
		return (await Promise.all([...goalIds].map(async (goalId) => (
			(await this.describeAll(goalId)).map((task) => ({ ...task, goalId }))
		)))).flat();
	}

	/** Loopback stream port for a goal-owned Session. Never expose it to the browser client. */
	streamPort(goalId: string, sessionId: string): number | undefined {
		const task = this.taskFor(goalId, sessionId);
		if (!task || !this.isSessionLive(sessionId)) return undefined;
		try {
			const port = Number.parseInt(readFileSync(join(this.runDir, `${sessionId}.stream`), "utf-8").trim(), 10);
			return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
		} catch {
			return undefined;
		}
	}

	/** Transfer one Session between the Agent Tool and an observing user. */
	async setControl(goalId: string, sessionId: string, control: "agent" | "user"): Promise<void> {
		const task = this.taskFor(goalId, sessionId);
		if (!task) throw new Error("Browser Session is no longer active");
		if (control === "agent") {
			task.control = "agent";
			this.settleAgentWaiters(task);
			return;
		}
		if (task.control === "user") return;
		task.control = "delegating";
		if (task.inFlight > 0) await new Promise<void>((resolve) => task.idleWaiters.push(resolve));
		if (this.taskFor(goalId, sessionId) !== task) throw new Error("Browser Session ended during handoff");
		task.control = "user";
	}

	canAcceptUserInput(goalId: string, sessionId: string): boolean {
		return this.taskFor(goalId, sessionId)?.control === "user";
	}

	/** Capture a PNG of a goal's active session, or undefined when it has no tab. */
	async screenshot(goalId: string): Promise<Buffer | undefined> {
		const task = [...this.active.values()]
			.filter((candidate) => candidate.goalId === goalId)
			.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
		return task ? this.captureSessionScreenshot(task.sessionId) : undefined;
	}

	/** Current-page seed for one goal-owned Session's observation stream. */
	async screenshotSession(goalId: string, sessionId: string): Promise<Buffer | undefined> {
		return this.taskFor(goalId, sessionId) ? this.captureSessionScreenshot(sessionId) : undefined;
	}

	/**
	 * Read the task tab's pixels straight over CDP. Going through the daemon's command channel
	 * would broadcast a `screenshot` command to every observer and compete with the Agent's
	 * own commands.
	 */
	private async captureSessionScreenshot(sessionId: string): Promise<Buffer | undefined> {
		const targetId = this.readTargetSidecar(sessionId)?.targetId;
		if (!targetId || !this.isSessionLive(sessionId)) return undefined;
		let socketUrl: string | undefined;
		try {
			const targets = await (await this.cdpFetch("/json")).json() as Array<{ id?: string; webSocketDebuggerUrl?: string }>;
			socketUrl = targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl;
		} catch {
			return undefined;
		}
		if (!socketUrl) return undefined;
		return new Promise((resolve) => {
			const socket = new WebSocket(socketUrl);
			let settled = false;
			const finish = (png?: Buffer) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try { socket.close(); } catch { /* already unavailable */ }
				resolve(png);
			};
			const timer = setTimeout(() => finish(), SCREENSHOT_TIMEOUT_MS);
			socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } })));
			socket.once("error", () => finish());
			socket.once("close", () => finish());
			socket.on("message", (data) => {
				try {
					const response = JSON.parse(data.toString()) as { id?: number; result?: { data?: string } };
					if (response.id === 1) finish(typeof response.result?.data === "string" ? Buffer.from(response.result.data, "base64") : undefined);
				} catch {
					finish();
				}
			});
		});
	}

	/** Live daemon session ids in this namespace: `<session>.pid` with an alive pid. */
	liveSessions(): string[] {
		let entries: string[];
		try {
			entries = readdirSync(this.runDir);
		} catch {
			return [];
		}
		const live: string[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".pid")) continue;
			const sessionId = entry.slice(0, -".pid".length);
			const pid = this.readPid(sessionId);
			if (pid !== undefined && this.isProcessAlive(pid)) live.push(sessionId);
		}
		return live;
	}

	/** Reclaim dead idle workspaces and orphaned namespace daemons. */
	async sweep(reason: BrowserReleaseReason = "crash-backstop"): Promise<number> {
		let reclaimed = 0;
		for (const task of [...this.active.values()]) {
			// Never reclaim a startup, an in-flight command, or a user-controlled tab.
			if (this.active.get(task.ownerId) !== task || task.inFlight > 0) continue;
			if (!task.controller.signal.aborted
				&& (!task.admitted || !task.viewportReady || task.control !== "agent" || this.isSessionLive(task.sessionId))) continue;
			await this.endTask(task.ownerId, reason);
			reclaimed += 1;
		}
		for (const sessionId of this.liveSessions()) {
			if ([...this.active.values(), ...[...this.closing.values()].map(({ task }) => task)]
				.some((task) => task.sessionId === sessionId)) continue;
			await this.detach(sessionId, reason);
			reclaimed += 1;
		}
		if (reclaimed > 0) this.onEvent?.({ kind: "sweep", reclaimed });
		return reclaimed;
	}

	/** Detach every namespace daemon. Used on SIGINT/SIGTERM. */
	async shutdownAll(reason: BrowserReleaseReason = "shutdown"): Promise<void> {
		this.stopSweep();
		await Promise.all([...this.active.keys(), ...this.closing.keys()].map((ownerId) => this.endTask(ownerId, reason)));
		for (const sessionId of this.liveSessions()) await this.detach(sessionId, reason);
	}

	startSweep(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => {
			void this.sweep().catch((error) => this.onEvent?.({
				kind: "error",
				message: `sweep failed: ${toErrorMessage(error)}`,
			}));
		}, this.sweepIntervalMs);
		this.sweepTimer.unref?.();
	}

	stopSweep(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
	}

	private taskFor(goalId: string, sessionId: string): ActiveTask | undefined {
		return [...this.active.values()].find((task) => task.goalId === goalId && task.sessionId === sessionId);
	}

	private async runAgentCommand(
		task: ActiveTask,
		args: string[],
		options: { signal?: AbortSignal; onData?: (chunk: Buffer) => void },
	): Promise<number> {
		if (this.active.get(task.ownerId) !== task) throw new Error("Browser workspace is no longer active");
		while (task.control !== "agent") {
			await this.waitForAgentControl(task, options.signal);
			if (this.active.get(task.ownerId) !== task) throw new Error("Browser workspace is no longer active");
		}
		options = { ...options, signal: options.signal
			? AbortSignal.any([options.signal, task.controller.signal]) : task.controller.signal };
		task.inFlight += 1;
		try {
			if (!task.viewportReady) {
				// Pins the tab and fixes its CSS viewport before the first real command, so frames,
				// screenshots and user input all describe the same 1280x720 page.
				task.viewportReady = true;
				await this.spawnAgentBrowser(
					["set", "viewport", String(TASK_VIEWPORT.width), String(TASK_VIEWPORT.height)],
					task.sessionId,
					{ signal: options.signal },
				);
			}
			return await this.spawnAgentBrowser(args, task.sessionId, options);
		} finally {
			task.inFlight -= 1;
			if (task.inFlight === 0) this.settleIdleWaiters(task);
		}
	}

	private settleIdleWaiters(task: ActiveTask): void {
		for (const resolve of task.idleWaiters.splice(0)) resolve();
	}

	private waitForAgentControl(task: ActiveTask, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(cancelledError(signal));
		return new Promise((resolve, reject) => {
			const pending: PendingControl = { signal, resolve, reject };
			if (signal) {
				pending.onAbort = () => {
					const index = task.agentWaiters.indexOf(pending);
					if (index >= 0) task.agentWaiters.splice(index, 1);
					reject(cancelledError(signal));
				};
				signal.addEventListener("abort", pending.onAbort, { once: true });
			}
			task.agentWaiters.push(pending);
		});
	}

	private settleAgentWaiters(task: ActiveTask, error?: Error): void {
		for (const pending of task.agentWaiters.splice(0)) {
			if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
			if (error) pending.reject(error);
			else pending.resolve();
		}
	}

	private envForSession(sessionId: string): BrowserRunEnv {
		return {
			AGENT_BROWSER_CONFIG: join(this.daemonHome, "config.json"),
			AGENT_BROWSER_SOCKET_DIR: this.daemonHome,
			AGENT_BROWSER_CDP: this.cdpUrl,
			AGENT_BROWSER_NAMESPACE: this.namespace,
			AGENT_BROWSER_SESSION: sessionId,
			AGENT_BROWSER_PIN_TAB: "1",
			AGENT_BROWSER_IDLE_TIMEOUT_MS: String(this.idleTimeoutMs),
		};
	}

	private admit(task: ActiveTask, signal?: AbortSignal): Promise<void> {
		if (task.admitted) return Promise.resolve();
		if (signal?.aborted) return Promise.reject(cancelledError(signal));
		if (task.admission) return task.admission;
		if (this.activeWorkspaces < this.maxConcurrentWorkspaces) {
			task.admitted = true;
			this.activeWorkspaces += 1;
			return Promise.resolve();
		}
		const admission = new Promise<void>((resolve, reject) => {
			const pending: PendingAdmission = { task, signal, resolve, reject };
			if (signal) {
				pending.onAbort = () => {
					const index = this.queue.indexOf(pending);
					if (index >= 0) this.queue.splice(index, 1);
					reject(cancelledError(signal));
				};
				signal.addEventListener("abort", pending.onAbort, { once: true });
			}
			this.queue.push(pending);
		});
		task.admission = admission.finally(() => {
			if (task.admission) task.admission = undefined;
		});
		return task.admission;
	}

	private cancelAdmission(task: ActiveTask, error: Error): void {
		const index = this.queue.findIndex((pending) => pending.task === task);
		if (index < 0) return;
		const [pending] = this.queue.splice(index, 1);
		if (pending?.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		pending?.reject(error);
	}

	private drainQueue(): void {
		while (this.activeWorkspaces < this.maxConcurrentWorkspaces && this.queue.length > 0) {
			const pending = this.queue.shift()!;
			if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
			if (pending.signal?.aborted || this.active.get(pending.task.ownerId) !== pending.task) {
				pending.reject(pending.signal?.aborted
					? cancelledError(pending.signal)
					: new Error(`Browser workspace '${pending.task.ownerId}' is no longer active`));
				continue;
			}
			pending.task.admitted = true;
			this.activeWorkspaces += 1;
			pending.resolve();
		}
	}

	private isSessionLive(sessionId: string): boolean {
		const pid = this.readPid(sessionId);
		return pid !== undefined && this.isProcessAlive(pid);
	}

	/**
	 * Detach one session: close exactly its bound tab (native `.target` sidecar),
	 * detach the daemon, and confirm the daemon left the OS process table.
	 */
	private async detach(sessionId: string, reason: BrowserReleaseReason): Promise<void> {
		const target = this.readTargetSidecar(sessionId);
		if (target?.targetId) {
			for (const descendant of (await this.descendantTargetIds(target.targetId)).reverse()) {
				await this.closeTarget(descendant);
			}
			await this.closeTarget(target.targetId);
		}
		const pid = this.readPid(sessionId);
		if (pid === undefined || !this.isProcessAlive(pid)) {
			this.removeSidecars(sessionId);
			this.onEvent?.({ kind: "release", sessionId, reason, outcome: "closed" });
			return;
		}
		await this.runAgentBrowser(["--session", sessionId, "close"]);
		const outcome = await this.confirmDaemonGone(sessionId);
		this.removeSidecars(sessionId);
		this.onEvent?.({ kind: "release", sessionId, reason, outcome });
	}

	/** Close exactly one CDP target (the task's own tab). */
	private async closeTarget(targetId: string): Promise<void> {
		try {
			const response = await this.cdpFetch(`/json/close/${encodeURIComponent(targetId)}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
		} catch (error) {
			this.onEvent?.({
				kind: "error",
				sessionId: targetId,
				message: `close target failed: ${toErrorMessage(error)}`,
			});
		}
	}

	/** Return every page opened from this workspace's pinned target. */
	private async descendantTargetIds(rootTargetId: string): Promise<string[]> {
		const targets = await this.cdpTargetInfos();
		const owned = new Set([rootTargetId]);
		const descendants: string[] = [];
		let added = true;
		while (added) {
			added = false;
			for (const target of targets) {
				if (target.type !== "page" || owned.has(target.targetId)) continue;
				if (!owned.has(target.openerId ?? "") && !owned.has(target.openerFrameId ?? "")) continue;
				owned.add(target.targetId);
				descendants.push(target.targetId);
				added = true;
			}
		}
		return descendants;
	}

	private cdpFetch(path: string): Promise<Response> {
		return fetch(`${this.cdpUrl}${path}`, { signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS) });
	}

	private async cdpTargetInfos(): Promise<CdpTargetInfo[]> {
		try {
			const version = await (await this.cdpFetch("/json/version")).json() as { webSocketDebuggerUrl?: string };
			if (!version.webSocketDebuggerUrl) return [];
			return await new Promise((resolve) => {
				const socket = new WebSocket(version.webSocketDebuggerUrl!);
				const timer = setTimeout(() => finish([]), 2_000);
				let settled = false;
				const finish = (targets: CdpTargetInfo[]) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					try { socket.close(); } catch { /* already unavailable */ }
					resolve(targets);
				};
				socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" })));
				socket.once("error", () => finish([]));
				socket.once("close", () => finish([]));
				socket.on("message", (data) => {
					try {
						const response = JSON.parse(data.toString()) as { id?: number; result?: { targetInfos?: CdpTargetInfo[] } };
						if (response.id === 1) finish(response.result?.targetInfos ?? []);
					} catch {
						finish([]);
					}
				});
			});
		} catch {
			return [];
		}
	}

	/**
	 * Prove the daemon is gone from the OS process table. `close` is graceful and
	 * usually enough; if a pid lingers we only signal it after confirming, via the
	 * process table, that it is still our agent-browser daemon - never a recycled
	 * pid that now belongs to an unrelated process.
	 */
	private async confirmDaemonGone(sessionId: string): Promise<string> {
		if (await this.waitGone(sessionId, 2_000)) return "closed";
		const pid = this.readPid(sessionId);
		if (pid === undefined) return "closed";
		if (!this.isAgentBrowserProcess(pid)) {
			// Stale sidecar whose pid was recycled by an unrelated process: never
			// signal it. Drop our own namespace sidecars so we stop tracking it.
			this.removeSidecars(sessionId);
			return "stale-pid";
		}
		this.signal(pid, "SIGTERM");
		if (await this.waitGone(sessionId, 2_000)) return "terminated";
		const lingering = this.readPid(sessionId);
		if (lingering !== undefined && this.isAgentBrowserProcess(lingering)) {
			this.signal(lingering, "SIGKILL");
		}
		if (await this.waitGone(sessionId, 1_000)) return "killed";
		throw new Error(`Browser daemon '${sessionId}' is still alive after teardown`);
	}

	/** True once the session's daemon pid is gone or dead. Re-reads each poll. */
	private async waitGone(sessionId: string, timeoutMs: number): Promise<boolean> {
		const steps = Math.max(1, Math.ceil(timeoutMs / 50));
		for (let attempt = 0; attempt < steps; attempt += 1) {
			const pid = this.readPid(sessionId);
			if (pid === undefined || !this.isProcessAlive(pid)) return true;
			await delay(50);
		}
		const pid = this.readPid(sessionId);
		return pid === undefined || !this.isProcessAlive(pid);
	}

	private signal(pid: number, signal: NodeJS.Signals): void {
		try {
			process.kill(pid, signal);
		} catch {
			/* already gone */
		}
	}

	private readPid(sessionId: string): number | undefined {
		try {
			const pid = Number.parseInt(readFileSync(join(this.runDir, `${sessionId}.pid`), "utf-8").trim(), 10);
			return Number.isInteger(pid) && pid > 0 ? pid : undefined;
		} catch {
			return undefined;
		}
	}

	private readTargetSidecar(sessionId: string): { targetId?: string; url?: string; pinned?: boolean } | undefined {
		try {
			const raw = JSON.parse(readFileSync(join(this.runDir, `${sessionId}.target`), "utf-8")) as Record<string, unknown>;
			return {
				...(typeof raw.targetId === "string" ? { targetId: raw.targetId } : {}),
				...(typeof raw.url === "string" && raw.url ? { url: raw.url } : {}),
				...(typeof raw.pinned === "boolean" ? { pinned: raw.pinned } : {}),
			};
		} catch {
			return undefined;
		}
	}

	private removeSidecars(sessionId: string): void {
		for (const suffix of ["pid", "sock", "stream", "target", "config", "version"]) {
			rmSync(join(this.runDir, `${sessionId}.${suffix}`), { force: true });
		}
	}

	private runAgentBrowser(args: string[]): Promise<boolean> {
		return this.spawnAgentBrowser(args).then((exitCode) => exitCode === 0);
	}

	private spawnAgentBrowser(
		args: string[],
		sessionId?: string,
		options: { signal?: AbortSignal; onData?: (chunk: Buffer) => void } = {},
	): Promise<number> {
		if (options.signal?.aborted) return Promise.resolve(1);
		return new Promise((resolve) => {
			const child = spawn(this.agentBrowserBin, args, {
				stdio: options.onData ? ["ignore", "pipe", "pipe"] : "ignore",
				detached: false,
				env: {
					...process.env,
					AGENT_BROWSER_CONFIG: join(this.daemonHome, "config.json"),
					AGENT_BROWSER_SOCKET_DIR: this.daemonHome,
					AGENT_BROWSER_CDP: this.cdpUrl,
					AGENT_BROWSER_NAMESPACE: this.namespace,
					...(sessionId ? { AGENT_BROWSER_SESSION: sessionId } : {}),
					AGENT_BROWSER_PIN_TAB: "1",
					AGENT_BROWSER_IDLE_TIMEOUT_MS: String(this.idleTimeoutMs),
				},
			});
			let settled = false;
			const onAbort = () => child.kill("SIGTERM");
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout?.on("data", options.onData ?? (() => undefined));
			child.stderr?.on("data", options.onData ?? (() => undefined));
			const finish = (exitCode: number) => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", onAbort);
				resolve(exitCode);
			};
			child.on("error", () => {
				this.onEvent?.({ kind: "error", message: `spawn ${this.agentBrowserBin} failed` });
				finish(1);
			});
			// "close" fires after the output streams have drained; "exit" can precede the last chunk.
			child.on("close", (code) => finish(code ?? 1));
		});
	}
}

function sessionIdFor(runId: string, ownerId: string): string {
	return `r-${sha256(`${runId}\0${ownerId}`, "base64url").slice(0, 10)}`;
}

function defaultNamespace(dataRoot?: string): string {
	const seed = dataRoot ?? resolveDataDir();
	return `telomi-${sha256(seed).slice(0, 10)}`;
}

function defaultSocketDirectory(dataRoot?: string): string {
	const seed = dataRoot ?? resolveDataDir();
	const root = process.platform === "win32" ? tmpdir() : "/tmp";
	return join(root, `telomi-ab-${sha256(seed).slice(0, 10)}`);
}

function normalizeNamespace(value: string): string {
	return safeName(value) || "telomi-default";
}

function normalizeCdpUrl(value: string): string {
	const trimmed = value.trim();
	if (/^\d+$/u.test(trimmed)) return `http://127.0.0.1:${trimmed}`;
	try {
		return new URL(trimmed).origin;
	} catch {
		return DEFAULT_CDP_URL;
	}
}

function positiveInt(value: string | undefined, fallback: number): number {
	if (!value?.trim()) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function processIsAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Confirm a pid is a live agent-browser process via the OS process table. */
function isAgentBrowserProcess(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	const result = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf-8" });
	if (result.status !== 0 || typeof result.stdout !== "string") return false;
	const executable = basename(result.stdout.trim());
	return executable === "agent-browser"
		|| /^agent-browser-(?:darwin|linux)-(?:arm64|x64)$/u.test(executable);
}

/**
 * Usage lines an Agent gets back with a rejected or malformed command. The Runtime knows the
 * command set; the Agent should not have to guess it from a Skill or from agent-browser's own
 * CLI errors.
 */
const BROWSER_USAGE: Record<string, string> = {
	open: "open <http(s) url>",
	read: "read [http(s) url]  (agent-readable text of the current or given page)",
	click: "click <selector|@ref> [--new-tab]",
	dblclick: "dblclick <selector|@ref>",
	type: "type <selector|@ref> <text>",
	fill: "fill <selector|@ref> <text>",
	press: "press <key>  (Enter, Tab, Control+a)",
	keyboard: "keyboard type <text> | keyboard inserttext <text>",
	hover: "hover <selector|@ref>",
	focus: "focus <selector|@ref>",
	check: "check <selector|@ref>",
	uncheck: "uncheck <selector|@ref>",
	select: "select <selector|@ref> <value...>",
	drag: "drag <source selector> <target selector>",
	scroll: "scroll <up|down|left|right> [px] [-s <selector>]",
	scrollintoview: "scrollintoview <selector|@ref>",
	wait: "wait <selector|ms> | wait --url <url> | wait --text <text> | wait --load <load|domcontentloaded|networkidle>",
	snapshot: "snapshot [-i|--interactive] [-u|--urls] [-c|--compact] [-d <depth>] [-s <selector>]",
	get: "get title | get url | get text <sel> | get html <sel> | get value <sel> | get attr <sel> <name> | get count <sel> | get box <sel> | get styles <sel>",
	is: "is visible|enabled|checked <selector>",
	find: "find <role|text|label|placeholder|alt|title|testid|first|last|nth> <value> <action> [text]",
	back: "back", forward: "forward", reload: "reload", console: "console", errors: "errors",
	diff: "diff snapshot",
	skills: "skills list | skills get <name> [--full]  (agent-browser's own usage guide)",
	help: "help  (this command list)",
};

/** What the Runtime keeps to itself, and what the Agent should do instead. */
const BROWSER_BLOCKED: Record<string, string> = {
	eval: "arbitrary JavaScript can read or send anything on the page; use snapshot, get, read and find instead",
	upload: "sending local files to a website is not available; retain material with materialize_source instead",
	download: "Runtime saves attachments itself: materialize_source({kind: \"element\", ref: \"@eN\"})",
	screenshot: "Runtime keeps files out of the sandbox; use snapshot, get text or materialize_source",
	pdf: "Runtime keeps files out of the sandbox; use materialize_source({kind: \"current_page\"})",
	connect: "Runtime owns the browser connection",
	close: "Runtime owns the session lifecycle; a child session is released when the child ends",
	install: "Runtime owns the browser installation",
	session: "Runtime owns the session; every command already runs in this execution's own session",
};

function browserUsageList(): string {
	return `Browser commands: ${Object.values(BROWSER_USAGE).join(" ; ")}. Blocked: ${Object.keys(BROWSER_BLOCKED).join(", ")}.`;
}

const CHALLENGE_POLLS = 5;
const CHALLENGE_POLL_MS = 3_000;
// Titles and markup of the interstitials Cloudflare, Akamai, and similar WAFs serve before a page.
const CHALLENGE_PATTERN = /Just a moment|请稍候|Un momento|Attention Required! \| Cloudflare|_cf_chl_opt|challenge-error-text|cf-browser-verification|Verify you are human|Checking your browser|Checking if the site connection is secure/u;

/** Whether command output shows a verification interstitial rather than the page itself. */
export function looksLikeChallenge(output: string): boolean {
	return CHALLENGE_PATTERN.test(output);
}

function browserUsageError(command: string, problem: string): Error {
	const usage = BROWSER_USAGE[command];
	return new Error(`${problem}. Usage: ${usage ?? browserUsageList()}`);
}

function validateAgentBrowserArgs(args: readonly string[]): void {
	if (args.length === 0) throw new Error(`agent-browser requires a command. ${browserUsageList()}`);
	const forbiddenFlags = [
		"--session", "--namespace", "--cdp", "--config", "--auto-connect",
		"--profile", "--restore", "--state", "--headers", "--executable-path", "--extension",
		"--init-script", "--enable", "--args", "--proxy", "--allow-file-access", "--download",
		"--download-path", "--action-policy", "--confirm-actions", "--fn",
	];
	if (args.some((arg) => forbiddenFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
		throw new Error("Runtime owns the agent-browser session, startup configuration, credentials, scripts, and downloads; drop that option");
	}
	const harmlessFlags = new Set(["--headed", "--debug", "--json", "--quiet", "--verbose", "--content-boundaries"]);
	let commandIndex = 0;
	while (commandIndex < args.length && harmlessFlags.has(args[commandIndex] ?? "")) commandIndex += 1;
	const command = args[commandIndex] ?? "";
	if (command === "--help" || command === "-h" || command === "help") return;
	if (command.startsWith("-")) {
		throw new Error(`Unsupported agent-browser global option: ${command}. ${browserUsageList()}`);
	}
	if (command in BROWSER_BLOCKED) {
		throw new Error(`Browser command '${command}' is blocked: ${BROWSER_BLOCKED[command]}`);
	}
	if (!(command in BROWSER_USAGE)) {
		throw new Error(`Unknown Browser command '${command}'. ${browserUsageList()}`);
	}
	const commandArgs = args.slice(commandIndex + 1);
	const count = (min: number, max = min) => {
		if (commandArgs.length < min || commandArgs.length > max) {
			throw browserUsageError(command, `Browser ${command} takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, got ${commandArgs.length}`);
		}
	};
	switch (command) {
		case "open": {
			count(1);
			if (!isHttpUrl(commandArgs[0] ?? "")) throw browserUsageError(command, "Browser open requires an HTTP(S) URL");
			break;
		}
		case "read": {
			count(0, 1);
			if (commandArgs[0] !== undefined && !isHttpUrl(commandArgs[0])) throw browserUsageError(command, "Browser read takes an HTTP(S) URL");
			break;
		}
		case "click": {
			const positional = commandArgs.filter((arg) => arg !== "--new-tab");
			if (positional.length !== 1 || commandArgs.length > 2) throw browserUsageError(command, "Browser click takes one selector or @ref and optionally --new-tab");
			break;
		}
		case "dblclick": case "hover": case "focus": case "check": case "uncheck": case "scrollintoview": case "press": count(1); break;
		case "type": case "fill": case "drag": count(2); break;
		case "keyboard": {
			count(2);
			if (!["type", "inserttext"].includes(commandArgs[0] ?? "")) throw browserUsageError(command, "Browser keyboard supports type or inserttext");
			break;
		}
		case "select": count(2, 64); break;
		case "find": {
			count(3, 4);
			if (!["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"].includes(commandArgs[0] ?? "")) {
				throw browserUsageError(command, `Browser find does not know locator '${commandArgs[0]}'`);
			}
			break;
		}
		case "scroll": validateScrollArgs(commandArgs); break;
		case "wait": validateWaitArgs(commandArgs); break;
		case "snapshot": validateSnapshotArgs(commandArgs); break;
		case "get": validateGetArgs(commandArgs); break;
		case "is": validateIsArgs(commandArgs); break;
		case "back": case "forward": case "reload": case "console": case "errors": count(0); break;
		case "diff": {
			if (commandArgs.length !== 1 || commandArgs[0] !== "snapshot") throw browserUsageError(command, "Browser diff supports only snapshot comparison");
			break;
		}
		case "skills": {
			if (!(commandArgs[0] === "list" && commandArgs.length === 1)
				&& !(commandArgs[0] === "get" && commandArgs.length >= 2 && commandArgs.length <= 3 && (commandArgs[2] === undefined || commandArgs[2] === "--full"))) {
				throw browserUsageError(command, "Browser skills supports list or get <name> [--full]");
			}
			break;
		}
		default: break;
	}
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** `help` is not an agent-browser command; answer it with the Runtime's own command list. */
export function browserHelpText(): string {
	return browserUsageList();
}

function validateScrollArgs(args: readonly string[]): void {
	let positional = args;
	const selectorIndex = args.findIndex((arg) => arg === "-s" || arg === "--selector");
	if (selectorIndex >= 0) {
		if (selectorIndex !== args.length - 2) throw browserUsageError("scroll", "Browser scroll selector must be the final option");
		positional = args.slice(0, selectorIndex);
	}
	if (positional.length < 1 || positional.length > 2 || !["up", "down", "left", "right"].includes(positional[0] ?? "")) {
		throw browserUsageError("scroll", "Browser scroll needs a direction and an optional pixel amount");
	}
	if (positional[1] !== undefined && !/^\d+$/u.test(positional[1])) throw browserUsageError("scroll", "Browser scroll amount must be a whole number of pixels");
}

function validateWaitArgs(args: readonly string[]): void {
	if (args.length === 1 && !args[0]?.startsWith("-")) return;
	if (args.length === 2 && ["--url", "--text"].includes(args[0] ?? "")) return;
	if (args.length === 2 && args[0] === "--load" && ["load", "domcontentloaded", "networkidle"].includes(args[1] ?? "")) return;
	throw browserUsageError("wait", "Browser wait supports only a selector, fixed wait, URL, text, or load state");
}

function validateSnapshotArgs(args: readonly string[]): void {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (["-i", "--interactive", "-u", "--urls", "-c", "--compact"].includes(arg)) continue;
		if (["-d", "--depth", "-s", "--selector"].includes(arg) && args[index + 1]) {
			index += 1;
			continue;
		}
		throw browserUsageError("snapshot", `Unsupported Browser snapshot option: ${arg}`);
	}
}

function validateGetArgs(args: readonly string[]): void {
	const kind = args[0] ?? "";
	if (["title", "url"].includes(kind) && args.length === 1) return;
	if (["text", "html", "value", "count", "box", "styles"].includes(kind) && args.length === 2) return;
	if (kind === "attr" && args.length === 3) return;
	if (kind === "cdp-url") throw browserUsageError("get", "Browser get cdp-url is blocked: Runtime owns the browser connection");
	throw browserUsageError("get", `Unsupported Browser get arguments: ${args.join(" ") || "(none)"}`);
}

function validateIsArgs(args: readonly string[]): void {
	if (args.length === 2 && ["visible", "enabled", "checked"].includes(args[0] ?? "")) return;
	throw browserUsageError("is", `Unsupported Browser is arguments: ${args.join(" ") || "(none)"}`);
}

function cancelledError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Browser workspace request was cancelled");
}
