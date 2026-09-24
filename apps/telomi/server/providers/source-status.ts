/**
 * The verified state of every external source: whether the credential or browser login it runs on
 * still works. Verification runs at startup, before each research run, once a day and on request
 * from the settings page; the outcome is what the page shows next to each source and what a later
 * delivery filters the Provider Catalog by.
 *
 * Browser-backed sources are refreshed from the browser before they are checked, so a login that
 * came back in the browser repairs itself here; only a login that is gone is reported.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { sourceUnavailable, type SourceReasonCode, type SourceState, type SourceStatus } from "../../shared/sources.js";
import { ResearchNodeError } from "../agent-runtime/retry-policy.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import { refreshBrowserSessions } from "../config/local-credentials.js";
import { loadSettings, saveSettings } from "../config/settings.js";
import { toErrorMessage } from "../lib/values.js";
import { YouTubeMediaExtractor } from "../research/sources/providers/youtube/media-extractor.js";
import { browserHostAvailable } from "./browser/startup.js";
import { captureSearchCredential } from "./search-credentials.js";
import { SOURCE_DESCRIPTORS, sourceDescriptor, type SourceDescriptor } from "./source-descriptors.js";
import { getResearchSourceServiceClient } from "./source-service-client.js";

export const SOURCE_STATUS_FILE = "source-status.json";
const VERIFY_TIMEOUT_MS = 45_000;

export interface SourceStatusDependencies {
	sourceService: {
		verifyCredential(sourceId: string, credential: Record<string, string | null>, signal?: AbortSignal): Promise<void>;
		listSources(signal?: AbortSignal): Promise<string[]>;
	};
	env?: NodeJS.ProcessEnv;
	/** Re-read browser logins before checking browser-backed sources. */
	refreshBrowserSessions?: () => Promise<unknown>;
	/** One account-scoped YouTube call; throws `youtube_ytdlp_authorization_required` when logged out. */
	probeYouTube?: (signal: AbortSignal) => Promise<void>;
	probeBrowser?: (env: NodeJS.ProcessEnv) => Promise<boolean>;
	statusPath?: string;
	now?: () => Date;
	/** Told whenever a source's state changes; a restart that reads the same state back is not a change. */
	onChange?: (event: { sourceId: string; state: SourceState; previous: SourceState | null; ts: string }) => void;
}

export class SourceStatusMonitor {
	private readonly env: NodeJS.ProcessEnv;
	private readonly statusPath: string;
	private readonly now: () => Date;
	private statuses: Map<string, SourceStatus> | undefined;
	private inFlight: Promise<void> | undefined;

	constructor(private readonly deps: SourceStatusDependencies) {
		this.env = deps.env ?? process.env;
		this.statusPath = deps.statusPath ?? resolveAgentPath(SOURCE_STATUS_FILE);
		this.now = deps.now ?? (() => new Date());
	}

	get verifying(): boolean {
		return this.inFlight !== undefined;
	}

	status(id: string): SourceStatus | null {
		return this.load().get(id) ?? null;
	}

	/** Record an outcome established elsewhere, such as a credential the entry point just validated. */
	record(id: string, state: SourceState, code?: SourceReasonCode, reason?: string): SourceStatus {
		const status: SourceStatus = {
			state, checkedAt: this.now().toISOString(), ...(code ? { code } : {}), ...(reason ? { reason } : {}),
		};
		const previous = this.load().get(id)?.state ?? null;
		this.load().set(id, status);
		this.persist();
		if (previous !== state) this.deps.onChange?.({ sourceId: id, state, previous, ts: status.checkedAt });
		return status;
	}

	/** Whether a key-based source has no key to use, judged from the stored credential without calling the service. */
	lacksCredential(id: string): boolean {
		const source = sourceDescriptor(id);
		if (!source || source.verify !== "source_service") return false;
		const capture = captureSearchCredential(source.provider.id, this.env);
		return Boolean(capture.credential) && !isConfigured(source, capture.credential!);
	}

	isEnabled(id: string): boolean {
		return !(loadSettings().disabledSources ?? []).includes(id);
	}

	setEnabled(id: string, enabled: boolean): void {
		if (!sourceDescriptor(id)) throw new Error(`unknown source '${id}'`);
		const settings = loadSettings();
		const disabled = new Set(settings.disabledSources ?? []);
		if (enabled) disabled.delete(id); else disabled.add(id);
		saveSettings({ ...settings, disabledSources: [...disabled] });
	}

	/** Registry ids the Provider Catalog leaves out: switched off, needing a login, or failed. */
	excludedSourceIds(): string[] {
		return SOURCE_DESCRIPTORS
			.filter((source) => !this.isEnabled(source.id) || sourceUnavailable(this.status(source.id)))
			.map((source) => source.provider.id);
	}

	/** Verify again unless every enabled source was checked within `maxAgeMs`. */
	async verifyIfStale(maxAgeMs: number): Promise<void> {
		const cutoff = this.now().getTime() - maxAgeMs;
		const fresh = SOURCE_DESCRIPTORS.every((source) => {
			const status = this.status(source.id);
			return !this.isEnabled(source.id) || (status !== null && Date.parse(status.checkedAt) >= cutoff);
		});
		if (!fresh) await this.verifyAll();
	}

	async verify(id: string): Promise<SourceStatus> {
		const source = sourceDescriptor(id);
		if (!source) throw new Error(`unknown source '${id}'`);
		const registered = await this.registeredSources([source]);
		await this.prepare([source]);
		return await this.check(source, registered);
	}

	/**
	 * Verify every source. Concurrent calls share one pass. A browser host that just started still
	 * rotates its Google session for a moment; `settleRetryMs` re-checks a browser-backed source
	 * that did not pass once after that long, so a launch is not reported as a lost login.
	 */
	verifyAll(options: { settleRetryMs?: number } = {}): Promise<void> {
		return this.inFlight ??= this.run(options).finally(() => { this.inFlight = undefined; });
	}

	private async run(options: { settleRetryMs?: number }): Promise<void> {
		const sources = SOURCE_DESCRIPTORS.filter((source) => this.isEnabled(source.id));
		// The service list can take a while on a cold start; the browser logins are read after it so
		// the check states what the browser holds now, not what it held when the pass began.
		const registered = await this.registeredSources(sources);
		await this.prepare(sources);
		await Promise.all(sources.map((source) => this.check(source, registered)));
		if (!options.settleRetryMs) return;
		const unsettled = sources.filter((source) => source.auth === "browser_session" && this.status(source.id)?.state !== "ok");
		if (unsettled.length === 0) return;
		await new Promise((resolve) => setTimeout(resolve, options.settleRetryMs));
		await this.prepare(unsettled);
		await Promise.all(unsettled.map((source) => this.check(source, registered)));
	}

	private async prepare(sources: readonly SourceDescriptor[]): Promise<void> {
		if (!sources.some((source) => source.auth === "browser_session")) return;
		await (this.deps.refreshBrowserSessions ?? refreshBrowserSessions)().catch(() => undefined);
	}

	/** The Source Service's own id list, or the failure that stands in for it. */
	private async registeredSources(sources: readonly SourceDescriptor[]): Promise<Set<string> | Error> {
		if (!sources.some((source) => source.verify === "source_service")) return new Set();
		try {
			return new Set(await this.deps.sourceService.listSources(AbortSignal.timeout(VERIFY_TIMEOUT_MS)));
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	}

	private async check(source: SourceDescriptor, registered: Set<string> | Error): Promise<SourceStatus> {
		const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
		let outcome: Outcome;
		try {
			outcome = await this.probe(source, registered, signal);
		} catch (error) {
			outcome = signal.aborted ? { state: "error", code: "timeout" } : { state: "error", reason: toErrorMessage(error) };
		}
		return this.record(source.id, outcome.state, outcome.code, outcome.reason);
	}

	private async probe(source: SourceDescriptor, registered: Set<string> | Error, signal: AbortSignal): Promise<Outcome> {
		switch (source.verify) {
			case "none":
				return { state: "ok" };
			case "browser":
				return await (this.deps.probeBrowser ?? browserHostAvailable)(this.env)
					? { state: "ok" }
					: { state: "error", code: "browser_unavailable" };
			case "youtube": {
				if (!this.env.PI_YOUTUBE_YTDLP_COOKIE_FILE?.trim() && !this.env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER?.trim()) {
					return { state: "needs_login", code: "no_login" };
				}
				try {
					await (this.deps.probeYouTube ?? probeYouTubeAccount)(signal);
					return { state: "ok" };
				} catch (error) {
					if (error instanceof ResearchNodeError && error.code === "youtube_ytdlp_authorization_required") {
						return { state: "needs_login", code: "login_rejected" };
					}
					throw error;
				}
			}
			case "source_service": {
				const sourceId = source.provider.id;
				if (registered instanceof Error) return { state: "error", code: "service_unavailable", reason: toErrorMessage(registered) };
				if (!registered.has(sourceId)) return { state: "error", code: "not_registered", reason: sourceId };
				const capture = captureSearchCredential(sourceId, this.env);
				// An unmanaged remote service authenticates on its own; the probe answers for it.
				if (capture.credential && !isConfigured(source, capture.credential)) {
					return source.auth === "browser_session" ? { state: "needs_login", code: "no_login" } : { state: "unconfigured" };
				}
				try {
					await this.deps.sourceService.verifyCredential(sourceId, capture.credential ?? {}, signal);
					return { state: "ok" };
				} catch (error) {
					const rejected = error instanceof ResearchNodeError && error.failureClass === "permanent";
					if (rejected && source.auth === "browser_session") {
						return { state: "needs_login", code: "login_rejected", reason: toErrorMessage(error) };
					}
					return { state: "error", reason: toErrorMessage(error) };
				}
			}
		}
	}

	private load(): Map<string, SourceStatus> {
		if (this.statuses) return this.statuses;
		this.statuses = new Map();
		if (existsSync(this.statusPath)) {
			try {
				const parsed = JSON.parse(readFileSync(this.statusPath, "utf8")) as Record<string, SourceStatus>;
				for (const [id, status] of Object.entries(parsed)) {
					if (sourceDescriptor(id) && typeof status?.state === "string" && typeof status.checkedAt === "string") {
						this.statuses.set(id, status);
					}
				}
			} catch {
				// An unreadable file is the same as no history; the next verification rewrites it.
			}
		}
		return this.statuses;
	}

	private persist(): void {
		mkdirSync(dirname(this.statusPath), { recursive: true });
		writeFileSync(this.statusPath, `${JSON.stringify(Object.fromEntries(this.load()), null, 2)}\n`, { mode: 0o600 });
	}
}

type Outcome = { state: SourceState; code?: SourceReasonCode; reason?: string };

function isConfigured(source: SourceDescriptor, credential: Record<string, string | null>): boolean {
	return (source.fields ?? []).some((field) => !field.optional && Boolean(credential[field.env]));
}

async function probeYouTubeAccount(signal: AbortSignal): Promise<void> {
	try {
		await new YouTubeMediaExtractor().listAccountSubscriptions({ offset: 0, limit: 1, signal });
	} catch (error) {
		// Logged out, yt-dlp cannot resolve the account's subscription feed and says only that.
		if (error instanceof Error && /Failed to resolve url/u.test(error.message)) {
			throw new ResearchNodeError("YouTube rejected the browser login", "permanent", false, {
				code: "youtube_ytdlp_authorization_required", cause: error,
			});
		}
		throw error;
	}
}

let defaultMonitor: SourceStatusMonitor | undefined;
let changeListener: SourceStatusDependencies["onChange"];

export function getSourceStatusMonitor(): SourceStatusMonitor {
	return defaultMonitor ??= new SourceStatusMonitor({
		sourceService: getResearchSourceServiceClient(),
		onChange: (event) => changeListener?.(event),
	});
}

/** Where the process-wide monitor reports state changes; the app publishes them as an App Event. */
export function setSourceStatusChangeListener(listener: SourceStatusDependencies["onChange"]): void {
	changeListener = listener;
}
