import type { Express, Request, Response } from "express";
import { createServer } from "net";
import { randomUUID } from "crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt, OAuthCredentials } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	completeDeviceCodeLogin,
	DeviceCodeError,
	requestDeviceCode,
	type DeviceCodeStart,
} from "./oauth-codex-device.js";
import { openSse } from "../events/sse.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import { writeStoredCredential } from "./stored-credentials.js";
import { toErrorMessage } from "../lib/values.js";

const AUTH_PATH = resolveAgentPath("auth.json");
const MODELS_PATH = resolveAgentPath("models.json");
/**
 * A completed login prepares an authorization; it does not put it to work. The credential lands in
 * the pending store, and the user activates it with an explicit Apply that validates it first.
 */
const PENDING_AUTH_PATH = resolveAgentPath("auth-pending.json");
const DEVICE_CODE_SUPPORTED_PROVIDERS = new Set(["openai-codex"]);

function saveOAuthCredentials(provider: string, credentials: OAuthCredentials): void {
	writeStoredCredential(PENDING_AUTH_PATH, provider, { type: "oauth", ...credentials });
}

type EventEnvelope =
	| { type: "auth"; url: string; instructions?: string }
	| { type: "device-code"; verificationUrl: string; userCode: string; intervalMs: number }
	| { type: "progress"; message: string }
	| { type: "prompt"; promptId: string; kind: AuthPrompt["type"]; message: string; placeholder?: string; allowEmpty?: boolean; options?: { id: string; label: string }[] }
	| { type: "done" }
	| { type: "error"; message: string }
	| { type: "aborted" };

type SequencedEventEnvelope = EventEnvelope & { sequence: number };

interface OAuthConnection {
	send: (envelope: SequencedEventEnvelope) => void;
	close: () => void;
}

interface PendingPrompt {
	id: string;
	/** Answer used when the user submits an empty value; the first option of a select prompt. */
	fallback?: string;
	resolve: (value: string) => void;
	reject: (err: Error) => void;
}

interface OAuthSession {
	id: string;
	provider: string;
	createdAt: number;
	abort: AbortController;
	queued: SequencedEventEnvelope[];
	connections: Set<OAuthConnection>;
	nextSequence: number;
	pending: PendingPrompt | null;
	finished: boolean;
}

const SESSIONS = new Map<string, OAuthSession>();
// Only one in-flight session per provider (their callback ports are fixed).
const ACTIVE_BY_PROVIDER = new Map<string, string>();

// pi-ai's loginXxx() binds these fixed ports for the OAuth callback HTTP server. We probe them
// before kicking off the flow so a stuck/orphan listener (left over from a prior aborted session
// — see notes in startSession's abort handler) gets a friendly error instead of EADDRINUSE
// surfacing through SSE. Ports verified against
// node_modules/@earendil-works/pi-ai/dist/utils/oauth/{provider}.js. github-copilot uses Device
// Flow and skips this check.
const CALLBACK_PORTS: Record<string, number> = {
	anthropic: 53692,
	"openai-codex": 1455,
	"google-antigravity": 51121,
	"google-gemini-cli": 8085,
};

async function isPortInUse(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const tester = createServer();
		tester.once("error", (err: NodeJS.ErrnoException) => {
			resolve(err.code === "EADDRINUSE");
		});
		tester.once("listening", () => {
			tester.close(() => resolve(false));
		});
		tester.listen(port, "127.0.0.1");
	});
}

function emit(session: OAuthSession, envelope: EventEnvelope): void {
	const sequenced = { ...envelope, sequence: session.nextSequence++ } as SequencedEventEnvelope;
	session.queued.push(sequenced);
	for (const connection of session.connections) {
		try {
			connection.send(sequenced);
		} catch {
			connection.close();
		}
	}
}

function finalize(session: OAuthSession, terminal: EventEnvelope): void {
	if (session.finished) return;
	session.finished = true;
	emit(session, terminal);
	for (const connection of [...session.connections]) connection.close();
	if (session.pending) {
		session.pending.reject(new Error("session ended"));
		session.pending = null;
	}
	if (ACTIVE_BY_PROVIDER.get(session.provider) === session.id) {
		ACTIVE_BY_PROVIDER.delete(session.provider);
	}
	// Keep the session around briefly so SSE clients can read terminal event.
	const cleanup = setTimeout(() => {
		SESSIONS.delete(session.id);
	}, 60_000);
	cleanup.unref();
}

function buildInteraction(session: OAuthSession): AuthInteraction {
	return {
		signal: session.abort.signal,
		notify: (event: AuthEvent) => {
			if (event.type === "auth_url") {
				emit(session, { type: "auth", url: event.url, instructions: event.instructions });
			} else if (event.type === "device_code") {
				emit(session, {
					type: "device-code",
					verificationUrl: event.verificationUri,
					userCode: event.userCode,
					intervalMs: (event.intervalSeconds ?? 5) * 1000,
				});
			} else {
				emit(session, { type: "progress", message: event.message });
			}
		},
		prompt: (prompt: AuthPrompt) => {
			return new Promise<string>((resolve, reject) => {
				if (session.pending) {
					session.pending.reject(new Error("superseded by new prompt"));
				}
				const id = randomUUID();
				const fallback = prompt.type === "select" ? prompt.options[0]?.id : undefined;
				session.pending = { id, fallback, resolve, reject };
				emit(session, {
					type: "prompt",
					promptId: id,
					kind: prompt.type,
					message: prompt.message,
					placeholder: prompt.type === "select" ? fallback : prompt.placeholder,
					allowEmpty: fallback !== undefined,
					...(prompt.type === "select" ? { options: prompt.options.map(({ id: optionId, label }) => ({ id: optionId, label })) } : {}),
				});
			});
		},
	};
}

async function startSession(provider: string): Promise<OAuthSession> {
	// The native login flow writes through this Runtime's credential store, so binding it to the
	// pending path keeps the whole native mechanism intact while leaving active credentials alone.
	const runtime = await ModelRuntime.create({ authPath: PENDING_AUTH_PATH, modelsPath: MODELS_PATH });
	if (!runtime.getProvider(provider)?.auth.oauth) {
		throw new Error(`provider '${provider}' has no OAuth flow`);
	}

	const existingId = ACTIVE_BY_PROVIDER.get(provider);
	if (existingId) {
		const existing = SESSIONS.get(existingId);
		if (existing && !existing.finished) {
			// Idempotent: rapid duplicate clicks (e.g. React StrictMode mount-cleanup-mount in dev,
			// or impatient users) reuse the existing session. SSE clients can subscribe to the same
			// stream and replay queued events.
			return existing;
		}
	}

	const callbackPort = CALLBACK_PORTS[provider];
	if (callbackPort && (await isPortInUse(callbackPort))) {
		throw new Error(
			`OAuth callback port ${callbackPort} is already in use. A previous '${provider}' login is still bound to it (pi-ai's login flow doesn't release the callback server on abort). Either complete the prior login in your browser or restart Telomi (./restart.sh server) to free the port.`,
		);
	}

	const session: OAuthSession = {
		id: randomUUID(),
		provider,
		createdAt: Date.now(),
		abort: new AbortController(),
		queued: [],
		connections: new Set(),
		nextSequence: 1,
		pending: null,
		finished: false,
	};
	SESSIONS.set(session.id, session);
	ACTIVE_BY_PROVIDER.set(provider, session.id);

	// Kick off the login flow without awaiting so the HTTP response can return immediately.
	const interaction = buildInteraction(session);
	(async () => {
		try {
			await runtime.login(provider, "oauth", interaction);
			finalize(session, { type: "done" });
		} catch (err) {
			const message = toErrorMessage(err);
			if (session.abort.signal.aborted) {
				finalize(session, { type: "aborted" });
			} else {
				finalize(session, { type: "error", message });
			}
		}
	})();

	return session;
}

async function startDeviceCodeSession(provider: string): Promise<OAuthSession> {
	if (!DEVICE_CODE_SUPPORTED_PROVIDERS.has(provider)) {
		throw new Error(`provider '${provider}' does not support device-code login`);
	}

	const existingId = ACTIVE_BY_PROVIDER.get(provider);
	if (existingId) {
		const existing = SESSIONS.get(existingId);
		if (existing && !existing.finished) return existing;
	}

	const session: OAuthSession = {
		id: randomUUID(),
		provider,
		createdAt: Date.now(),
		abort: new AbortController(),
		queued: [],
		connections: new Set(),
		nextSequence: 1,
		pending: null,
		finished: false,
	};
	SESSIONS.set(session.id, session);
	ACTIVE_BY_PROVIDER.set(provider, session.id);

	(async () => {
		try {
			emit(session, { type: "progress", message: "Requesting device code from OpenAI…" });
			const start: DeviceCodeStart = await requestDeviceCode({ signal: session.abort.signal });
			emit(session, {
				type: "device-code",
				verificationUrl: start.verificationUrl,
				userCode: start.userCode,
				intervalMs: start.intervalMs,
			});
			const credentials: OAuthCredentials = await completeDeviceCodeLogin({
				deviceCode: start,
				signal: session.abort.signal,
				onProgress: (message) => emit(session, { type: "progress", message }),
			});
			saveOAuthCredentials(provider, credentials);
			finalize(session, { type: "done" });
		} catch (err) {
			if (session.abort.signal.aborted) {
				finalize(session, { type: "aborted" });
				return;
			}
			let message: string;
			if (err instanceof DeviceCodeError) {
				message =
					err.code === "unsupported"
						? "Device-code login is not enabled for this OpenAI client. Use browser login instead."
						: err.code === "expired_or_denied"
							? "Device code expired or was denied. Click Cancel and try again."
							: err.message;
			} else {
				message = toErrorMessage(err);
			}
			finalize(session, { type: "error", message });
		}
	})();

	return session;
}

function parseCursor(value: unknown): number {
	const parsed = typeof value === "string" ? Number(value) : NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function mountOAuthApi(app: Express): void {
	app.get("/api/auth/oauth/providers", async (_req: Request, res: Response) => {
		try {
			const runtime = await ModelRuntime.create({ authPath: AUTH_PATH, modelsPath: MODELS_PATH });
			const providers = runtime.getProviders().flatMap((provider) => {
				const oauth = provider.auth.oauth;
				return oauth ? [{
					id: provider.id,
					name: oauth.name,
					usesCallbackServer: provider.id in CALLBACK_PORTS,
					supportsDeviceCode: DEVICE_CODE_SUPPORTED_PROVIDERS.has(provider.id),
				}] : [];
			});
			res.json({ providers });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.post("/api/auth/:provider/oauth/start", async (req: Request, res: Response) => {
		const provider = typeof req.params.provider === "string" ? req.params.provider : "";
		if (!provider) {
			res.status(400).json({ error: "provider is required" });
			return;
		}
		try {
			const session = await startSession(provider);
			res.json({ sessionId: session.id, provider: session.provider });
		} catch (err) {
			res.status(400).json({ error: toErrorMessage(err) });
		}
	});

	app.post("/api/auth/:provider/device/start", async (req: Request, res: Response) => {
		const provider = typeof req.params.provider === "string" ? req.params.provider : "";
		if (!provider) {
			res.status(400).json({ error: "provider is required" });
			return;
		}
		try {
			const session = await startDeviceCodeSession(provider);
			res.json({ sessionId: session.id, provider: session.provider, mode: "device" });
		} catch (err) {
			res.status(400).json({ error: toErrorMessage(err) });
		}
	});

	app.get("/api/auth/oauth/:sessionId/events", (req: Request, res: Response) => {
		const id = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
		const session = SESSIONS.get(id);
		if (!session) {
			res.status(404).end();
			return;
		}
		const stream = openSse(req, res);
		const cursor = Math.max(parseCursor(req.get("Last-Event-ID")), parseCursor(req.query.cursor));
		for (const env of session.queued) {
			if (env.sequence > cursor) stream.send(env, env.sequence);
		}
		if (session.finished) {
			stream.close();
			return;
		}
		const connection: OAuthConnection = {
			send: (envelope) => { stream.send(envelope, envelope.sequence); },
			close: stream.close,
		};
		session.connections.add(connection);
		stream.onClose(() => session.connections.delete(connection));
	});

	app.post("/api/auth/oauth/:sessionId/input", (req: Request, res: Response) => {
		const id = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
		const session = SESSIONS.get(id);
		if (!session) {
			res.status(404).json({ error: "session not found" });
			return;
		}
		const body = (req.body || {}) as { promptId?: unknown; value?: unknown };
		const promptId = typeof body.promptId === "string" ? body.promptId : "";
		const value = typeof body.value === "string" ? body.value : "";
		if (!session.pending || session.pending.id !== promptId) {
			res.status(409).json({ error: "no matching pending prompt" });
			return;
		}
		const pending = session.pending;
		session.pending = null;
		// The dialog shows the default as a placeholder, so an empty submit means "take the default".
		pending.resolve(value.trim() === "" && pending.fallback !== undefined ? pending.fallback : value);
		res.json({ ok: true });
	});

	app.post("/api/auth/oauth/:sessionId/abort", (req: Request, res: Response) => {
		const id = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
		const session = SESSIONS.get(id);
		if (!session) {
			res.status(404).json({ error: "session not found" });
			return;
		}
		session.abort.abort();
		if (session.pending) {
			const pending = session.pending;
			session.pending = null;
			pending.reject(new Error("aborted"));
		}
		// pi-ai's loginXxx() does not wire AbortSignal into its callback HTTP server, so the
		// underlying promise may sit forever waiting on the OAuth callback. Finalize the
		// orchestrator session anyway so ACTIVE_BY_PROVIDER frees up immediately. The
		// orphaned login() will be discarded when its promise eventually settles
		// (session.finished guards against double-finalization).
		finalize(session, { type: "aborted" });
		res.json({ ok: true });
	});
}
