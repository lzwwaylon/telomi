import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { readJson, writeFileAtomic } from "../lib/fs.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import type { AccountCredential, ProviderAccount, ProviderAccountsConfig } from "./types.js";
import { readStoredCredentials, writeStoredCredential } from "./stored-credentials.js";

export const AUTH_JSON_PATH = resolveAgentPath("auth.json");
export const CODEX_PROVIDER_KEY = "openai-codex";

export function accountsConfigPath(provider: string): string {
	return resolveAgentPath("accounts", `${provider}.json`);
}

function emptyConfig(): ProviderAccountsConfig {
	return { version: 1, accounts: [], chainOrder: [], activeId: null };
}

export function loadAccountsConfig(provider: string): ProviderAccountsConfig {
	const path = accountsConfigPath(provider);
	const parsed = existsSync(path) ? readJson(path) : null;
	if (parsed === null) return emptyConfig();
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${provider}.json must contain an object`);
	const obj = parsed as Partial<ProviderAccountsConfig>;
	if (Object.keys(obj).sort().join(",") !== "accounts,activeId,chainOrder,version"
		|| obj.version !== 1 || !Array.isArray(obj.accounts) || !obj.accounts.every(isValidAccount)
		|| !Array.isArray(obj.chainOrder) || !obj.chainOrder.every((id) => typeof id === "string")) {
		throw new Error(`${provider}.json does not match the current account schema`);
	}
	const accounts = obj.accounts;
	const ids = new Set(accounts.map((a) => a.id));
	if (ids.size !== accounts.length || obj.chainOrder.length !== accounts.length
		|| new Set(obj.chainOrder).size !== obj.chainOrder.length || obj.chainOrder.some((id) => !ids.has(id))
		|| (obj.activeId !== null && (typeof obj.activeId !== "string" || !ids.has(obj.activeId)))) {
		throw new Error(`${provider}.json account order or active account is invalid`);
	}
	return { version: 1, accounts, chainOrder: obj.chainOrder, activeId: obj.activeId };
}

function isValidAccount(input: unknown): input is ProviderAccount {
	if (!input || typeof input !== "object") return false;
	const a = input as Record<string, unknown>;
	const allowed = new Set([
		"id", "label", "credential", "createdAt", "lastUsedAt", "lastErrorAt", "lastErrorMessage",
		"lastErrorClass", "status", "cooldownUntil",
	]);
	if (Object.keys(a).some((key) => !allowed.has(key))) return false;
	if (typeof a.id !== "string" || !a.id) return false;
	if (typeof a.label !== "string") return false;
	if (typeof a.createdAt !== "number") return false;
	if (!["ok", "expired", "rate-limited", "auth-error", "unknown"].includes(String(a.status))) return false;
	for (const key of ["lastUsedAt", "lastErrorAt", "cooldownUntil"] as const) {
		if (a[key] !== undefined && typeof a[key] !== "number") return false;
	}
	if (a.lastErrorMessage !== undefined && typeof a.lastErrorMessage !== "string") return false;
	if (a.lastErrorClass !== undefined && !["auth", "quota", "transient", "permanent"].includes(String(a.lastErrorClass))) return false;
	if (!a.credential || typeof a.credential !== "object") return false;
	const t = (a.credential as Record<string, unknown>).type;
	if (t !== "oauth" && t !== "api_key") return false;
	return true;
}

export function saveAccountsConfig(provider: string, config: ProviderAccountsConfig): void {
	const path = accountsConfigPath(provider);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Set the provider's auth.json slot to the given credential. Used when:
 *  - a goal runner switches active account at runtime;
 *  - the manager boots and needs subprocesses to see the chain head;
 *  - an account is deleted that was previously active.
 *
 * The app-owned CredentialStore file helper uses the same lock convention as Pi.
 */
export function mirrorActiveCredentialToAuthJson(provider: string, credential: AccountCredential | null): void {
	writeStoredCredential(AUTH_JSON_PATH, provider, credential as Credential | null);
}

/** Read the existing auth.json slot for the provider, if any. */
export function readCredentialFromAuthJson(provider: string): AccountCredential | null {
	try {
		return (readStoredCredentials(AUTH_JSON_PATH)[provider] as AccountCredential | undefined) ?? null;
	} catch {
		return null;
	}
}
