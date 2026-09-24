import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { toErrorMessage } from "../lib/values.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ISSUER = "https://auth.openai.com";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export type DeviceCodeStart = {
	verificationUrl: string;
	userCode: string;
	deviceAuthId: string;
	intervalMs: number;
};

type UserCodeResp = {
	device_auth_id?: string;
	user_code?: string;
	usercode?: string;
	interval?: string | number;
};

type PollSuccess = {
	authorization_code: string;
	code_challenge: string;
	code_verifier: string;
};

type TokenResp = {
	id_token?: string;
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
};

type JwtPayload = Record<string, unknown> & {
	[K in typeof JWT_CLAIM_PATH]?: { chatgpt_account_id?: string };
};

export class DeviceCodeError extends Error {
	readonly code: "unsupported" | "expired_or_denied" | "transport" | "invalid_response";
	constructor(code: DeviceCodeError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

function decodeJwtPayload(token: string): JwtPayload | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const json = Buffer.from(padded, "base64").toString("utf-8");
		return JSON.parse(json) as JwtPayload;
	} catch {
		return null;
	}
}

function extractAccountId(accessToken: string): string | null {
	const payload = decodeJwtPayload(accessToken);
	const claim = payload?.[JWT_CLAIM_PATH];
	const id = claim?.chatgpt_account_id;
	return typeof id === "string" && id ? id : null;
}

function parseInterval(raw: unknown): number {
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw)) * 1000;
	if (typeof raw === "string") {
		const n = parseInt(raw.trim(), 10);
		if (Number.isFinite(n)) return Math.max(0, n) * 1000;
	}
	return 5000;
}

export async function requestDeviceCode(opts: {
	issuer?: string;
	clientId?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}): Promise<DeviceCodeStart> {
	const issuer = (opts.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
	const clientId = opts.clientId ?? CLIENT_ID;
	const f = opts.fetchImpl ?? fetch;
	const url = `${issuer}/api/accounts/deviceauth/usercode`;
	let resp: Response;
	try {
		resp = await f(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ client_id: clientId }),
			signal: opts.signal,
		});
	} catch (err) {
		throw new DeviceCodeError("transport", `usercode request failed: ${toErrorMessage(err)}`);
	}
	if (resp.status === 404) {
		throw new DeviceCodeError("unsupported", "OpenAI does not expose device-code login for this client.");
	}
	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new DeviceCodeError(
			"transport",
			`usercode request returned ${resp.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
		);
	}
	let json: UserCodeResp;
	try {
		json = (await resp.json()) as UserCodeResp;
	} catch {
		throw new DeviceCodeError("invalid_response", "usercode response was not valid JSON");
	}
	const userCode = json.user_code ?? json.usercode;
	const deviceAuthId = json.device_auth_id;
	if (!userCode || !deviceAuthId) {
		throw new DeviceCodeError("invalid_response", `usercode response missing fields: ${JSON.stringify(json).slice(0, 200)}`);
	}
	return {
		verificationUrl: `${issuer}/codex/device`,
		userCode,
		deviceAuthId,
		intervalMs: parseInterval(json.interval),
	};
}

async function pollAuthorizationCode(opts: {
	issuer: string;
	deviceAuthId: string;
	userCode: string;
	intervalMs: number;
	maxWaitMs?: number;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}): Promise<PollSuccess> {
	const f = opts.fetchImpl ?? fetch;
	const url = `${opts.issuer}/api/accounts/deviceauth/token`;
	const maxWait = opts.maxWaitMs ?? 15 * 60 * 1000;
	const start = Date.now();
	while (true) {
		if (opts.signal?.aborted) throw new DeviceCodeError("transport", "aborted");
		let resp: Response;
		try {
			resp = await f(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ device_auth_id: opts.deviceAuthId, user_code: opts.userCode }),
				signal: opts.signal,
			});
		} catch (err) {
			throw new DeviceCodeError("transport", `token poll failed: ${toErrorMessage(err)}`);
		}
		if (resp.ok) {
			let body: PollSuccess;
			try {
				body = (await resp.json()) as PollSuccess;
			} catch {
				throw new DeviceCodeError("invalid_response", "token poll response was not valid JSON");
			}
			if (!body.authorization_code || !body.code_challenge || !body.code_verifier) {
				throw new DeviceCodeError(
					"invalid_response",
					`token poll response missing fields: ${JSON.stringify(body).slice(0, 200)}`,
				);
			}
			return body;
		}
		if (resp.status === 403 || resp.status === 404) {
			const elapsed = Date.now() - start;
			if (elapsed >= maxWait) {
				throw new DeviceCodeError("expired_or_denied", "device-code login timed out (15 min); ask user to retry");
			}
			const wait = Math.min(opts.intervalMs, maxWait - elapsed);
			await sleep(wait, opts.signal);
			continue;
		}
		const body = await resp.text().catch(() => "");
		throw new DeviceCodeError(
			"transport",
			`token poll returned ${resp.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
		);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DeviceCodeError("transport", "aborted"));
			return;
		}
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			signal?.removeEventListener("abort", onAbort);
			reject(new DeviceCodeError("transport", "aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function exchangeCodeForTokens(opts: {
	issuer: string;
	clientId: string;
	authorizationCode: string;
	codeVerifier: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}): Promise<{ idToken: string; accessToken: string; refreshToken: string; expiresIn: number }> {
	const f = opts.fetchImpl ?? fetch;
	const url = `${opts.issuer}/oauth/token`;
	const redirectUri = `${opts.issuer}/deviceauth/callback`;
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: opts.authorizationCode,
		redirect_uri: redirectUri,
		client_id: opts.clientId,
		code_verifier: opts.codeVerifier,
	});
	let resp: Response;
	try {
		resp = await f(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: body.toString(),
			signal: opts.signal,
		});
	} catch (err) {
		throw new DeviceCodeError("transport", `token exchange failed: ${toErrorMessage(err)}`);
	}
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new DeviceCodeError(
			"transport",
			`token exchange returned ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
		);
	}
	let json: TokenResp;
	try {
		json = (await resp.json()) as TokenResp;
	} catch {
		throw new DeviceCodeError("invalid_response", "token exchange response was not valid JSON");
	}
	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new DeviceCodeError(
			"invalid_response",
			`token exchange response missing fields: ${JSON.stringify({ ...json, access_token: !!json.access_token }).slice(0, 200)}`,
		);
	}
	return {
		idToken: json.id_token ?? "",
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		expiresIn: json.expires_in,
	};
}

/**
 * After {@link requestDeviceCode} returns, the caller shows the verification URL
 * and userCode to the user, then calls this to block until the user approves.
 *
 * Returns credentials in the same shape as pi-ai's loginOpenAICodex output, so
 * oaccounts/auth-api.ts can persist them through the existing auth.json path unchanged.
 */
export async function completeDeviceCodeLogin(opts: {
	deviceCode: DeviceCodeStart;
	issuer?: string;
	clientId?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	maxWaitMs?: number;
	onProgress?: (msg: string) => void;
}): Promise<OAuthCredentials> {
	const issuer = (opts.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
	const clientId = opts.clientId ?? CLIENT_ID;
	opts.onProgress?.("Waiting for you to enter the code in your browser…");
	const codeResp = await pollAuthorizationCode({
		issuer,
		deviceAuthId: opts.deviceCode.deviceAuthId,
		userCode: opts.deviceCode.userCode,
		intervalMs: opts.deviceCode.intervalMs,
		maxWaitMs: opts.maxWaitMs,
		fetchImpl: opts.fetchImpl,
		signal: opts.signal,
	});
	opts.onProgress?.("Approval received, exchanging for access token…");
	const tokens = await exchangeCodeForTokens({
		issuer,
		clientId,
		authorizationCode: codeResp.authorization_code,
		codeVerifier: codeResp.code_verifier,
		fetchImpl: opts.fetchImpl,
		signal: opts.signal,
	});
	const accountId = extractAccountId(tokens.accessToken);
	if (!accountId) {
		throw new DeviceCodeError("invalid_response", "could not extract chatgpt_account_id from access token");
	}
	return {
		access: tokens.accessToken,
		refresh: tokens.refreshToken,
		expires: Date.now() + tokens.expiresIn * 1000,
		accountId,
	};
}
