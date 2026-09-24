import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	accountsConfigPath,
	CODEX_PROVIDER_KEY,
	loadAccountsConfig,
	mirrorActiveCredentialToAuthJson,
	saveAccountsConfig,
} from "./store.js";
import {
	isRequestCancellation,
	QUOTA_COOLDOWN_MS,
} from "./error-classify.js";
import type {
	ProviderAccount,
	ProviderAccountSummary,
	ProviderAccountsConfig,
	ProviderAccountsState,
	AccountCredential,
	ProviderErrorClass,
} from "./types.js";

export interface FallbackCandidate {
	account: ProviderAccount;
	credentialSnapshot: AccountCredential;
}

class ProviderAccountManager extends EventEmitter {
	private config: ProviderAccountsConfig = { version: 1, accounts: [], chainOrder: [], activeId: null };
	/** Serial mutex for any state-mutating operation (load excluded). */
	private writeChain: Promise<unknown> = Promise.resolve();
	private loaded = false;
	private loadPromise: Promise<void> | null = null;

	constructor(readonly provider: string) {
		super();
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		if (this.loadPromise) return this.loadPromise;
		this.loadPromise = this.loadOnce();
		try {
			await this.loadPromise;
		} finally {
			this.loadPromise = null;
		}
	}

	private async loadOnce(): Promise<void> {
		const config = loadAccountsConfig(this.provider);
		this.config = config;
		this.loaded = true;
		const active = this.getActiveCredential();
		if (active) mirrorActiveCredentialToAuthJson(this.provider, active);
		this.emit("change", this.snapshot());
	}

	private serialize<T>(fn: () => Promise<T> | T): Promise<T> {
		const next = this.writeChain.then(() => fn());
		this.writeChain = next.catch(() => undefined);
		return next as Promise<T>;
	}

	private suggestLabelFromCredential(cred: AccountCredential, fallback: string): string {
		if (cred.type === "oauth" && typeof cred.accountId === "string" && cred.accountId.length >= 8) {
			return `OAuth · ${cred.accountId.slice(0, 8)}`;
		}
		if (cred.type === "api_key" && cred.key) {
			return `API Key · ${cred.key.slice(-4)}`;
		}
		return fallback;
	}

	getActiveCredential(): AccountCredential | null {
		const active = this.findActiveAccount();
		return active ? cloneCredential(active.credential) : null;
	}

	getCredential(id: string): AccountCredential | null {
		const account = this.config.accounts.find((candidate) => candidate.id === id);
		return account ? cloneCredential(account.credential) : null;
	}

	private findActiveAccount(): ProviderAccount | null {
		const id = this.config.activeId;
		if (!id) return null;
		return this.config.accounts.find((a) => a.id === id) ?? null;
	}

	hasAnyAccount(): boolean {
		return this.config.accounts.length > 0;
	}

	snapshot(): ProviderAccountsState {
		const order = this.config.chainOrder;
		const indexById = new Map(order.map((id, i) => [id, i]));
		const accounts: ProviderAccountSummary[] = this.config.accounts
			.slice()
			.sort((a, b) => (indexById.get(a.id) ?? 999) - (indexById.get(b.id) ?? 999))
			.map((a) => ({
				id: a.id,
				label: a.label,
				type: a.credential.type,
				accountId: a.credential.type === "oauth" ? a.credential.accountId : undefined,
				maskedToken: maskToken(a.credential),
				createdAt: a.createdAt,
				lastUsedAt: a.lastUsedAt,
				lastErrorAt: a.lastErrorAt,
				lastErrorMessage: a.lastErrorMessage,
				lastErrorClass: a.lastErrorClass,
				status: a.status,
				cooldownUntil: a.cooldownUntil,
				isActive: a.id === this.config.activeId,
				chainPosition: indexById.get(a.id) ?? -1,
			}));
		return {
			accounts,
			chainOrder: [...order],
			activeId: this.config.activeId,
		};
	}

	addAccount(input: { label?: string; credential: AccountCredential }): Promise<ProviderAccountSummary> {
		return this.serialize(() => {
			const id = randomUUID();
			const account: ProviderAccount = {
				id,
				label: (input.label || "").trim() || this.suggestLabelFromCredential(input.credential, "新账号"),
				credential: cloneCredential(input.credential),
				createdAt: Date.now(),
				status: "ok",
			};
			this.config.accounts.push(account);
			this.config.chainOrder.push(id);
			if (!this.config.activeId) {
				this.config.activeId = id;
				mirrorActiveCredentialToAuthJson(this.provider, account.credential);
			}
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
			return this.snapshot().accounts.find((a) => a.id === id)!;
		});
	}

	/**
	 * Idempotent import: dedupe by stable identity (`accountId` for OAuth, full
	 * `key` for api_key). Backs the "收纳当前" button + the auto-capture hooks
	 * after every Provider-tab OAuth/Set-key, both of which fire whether or not
	 * the credential is actually new. Three outcomes:
	 *  - `noop`    : exact-equal credential already in chain (returns existing)
	 *  - `updated` : same identity, fresh tokens → update in place + reset error/cooldown
	 *  - `added`   : new identity → push to chain tail
	 */
	importOrUpdate(input: { label?: string; credential: AccountCredential; activate?: boolean }): Promise<{
		result: "added" | "updated" | "noop";
		account: ProviderAccountSummary;
	}> {
		return this.serialize(() => {
			const incoming = cloneCredential(input.credential);
			const existingIdx = this.config.accounts.findIndex((a) =>
				credentialIdentityEquals(a.credential, incoming),
			);

			if (existingIdx < 0) {
				const id = randomUUID();
				const account: ProviderAccount = {
					id,
					label:
						(input.label || "").trim() ||
						this.suggestLabelFromCredential(incoming, "新账号"),
					credential: incoming,
					createdAt: Date.now(),
					status: "ok",
				};
				this.config.accounts.push(account);
				this.config.chainOrder.push(id);
				if (!this.config.activeId || input.activate) {
					this.config.activeId = id;
					mirrorActiveCredentialToAuthJson(this.provider, account.credential);
				}
				saveAccountsConfig(this.provider, this.config);
				this.emit("change", this.snapshot());
				return {
					result: "added" as const,
					account: this.snapshot().accounts.find((a) => a.id === id)!,
				};
			}

			const existing = this.config.accounts[existingIdx];
			if (input.activate && this.config.activeId !== existing.id) {
				this.config.activeId = existing.id;
				mirrorActiveCredentialToAuthJson(this.provider, existing.credential);
				saveAccountsConfig(this.provider, this.config);
				this.emit("change", this.snapshot());
			}
			if (credentialBodyEquals(existing.credential, incoming)) {
				return {
					result: "noop" as const,
					account: this.snapshot().accounts.find((a) => a.id === existing.id)!,
				};
			}

			existing.credential = incoming;
			existing.status = "ok";
			existing.lastErrorClass = undefined;
			existing.lastErrorMessage = undefined;
			existing.cooldownUntil = undefined;
			if (this.config.activeId === existing.id) {
				mirrorActiveCredentialToAuthJson(this.provider, existing.credential);
			}
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
			return {
				result: "updated" as const,
				account: this.snapshot().accounts.find((a) => a.id === existing.id)!,
			};
		});
	}

	removeAccount(id: string): Promise<void> {
		return this.serialize(() => {
			const idx = this.config.accounts.findIndex((a) => a.id === id);
			if (idx < 0) return;
			this.config.accounts.splice(idx, 1);
			this.config.chainOrder = this.config.chainOrder.filter((x) => x !== id);
			if (this.config.activeId === id) {
				this.config.activeId = this.config.chainOrder[0] ?? null;
				const next = this.findActiveAccount();
				mirrorActiveCredentialToAuthJson(this.provider, next ? next.credential : null);
			}
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
		});
	}

	/** Drop every account: the provider-level delete means no credential of this provider survives. */
	clear(): Promise<void> {
		return this.serialize(() => {
			if (this.config.accounts.length === 0) return;
			this.config = { version: 1, accounts: [], chainOrder: [], activeId: null };
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
		});
	}

	renameAccount(id: string, label: string): Promise<void> {
		return this.serialize(() => {
			const account = this.config.accounts.find((a) => a.id === id);
			if (!account) return;
			account.label = label.trim() || account.label;
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
		});
	}

	reorderChain(orderedIds: string[]): Promise<void> {
		return this.serialize(() => {
			const seen = new Set<string>();
			const next: string[] = [];
			for (const id of orderedIds) {
				if (seen.has(id)) continue;
				if (!this.config.accounts.some((a) => a.id === id)) continue;
				next.push(id);
				seen.add(id);
			}
			for (const a of this.config.accounts) if (!seen.has(a.id)) next.push(a.id);
			this.config.chainOrder = next;
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
		});
	}

	setActive(id: string): Promise<void> {
		return this.serialize(() => {
			const account = this.config.accounts.find((a) => a.id === id);
			if (!account) return;
			this.config.activeId = id;
			mirrorActiveCredentialToAuthJson(this.provider, account.credential);
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
		});
	}

	updateCredential(id: string, credential: AccountCredential): Promise<void> {
		return this.serialize(() => {
			const account = this.config.accounts.find((a) => a.id === id);
			if (!account) return;
			account.credential = cloneCredential(credential);
			account.status = "ok";
			account.lastErrorClass = undefined;
			account.lastErrorMessage = undefined;
			account.cooldownUntil = undefined;
			if (this.config.activeId === id) {
				mirrorActiveCredentialToAuthJson(this.provider, account.credential);
			}
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
		});
	}

	/**
	 * Pick the first chain account that hasn't been tried in this request and
	 * isn't currently in cooldown. Returns the credential snapshot the caller
	 * should install via authStorage.set().
	 *
	 * Strategy: try the explicitly-active account first, then preserve the
	 * user's fallback chain order for every remaining account.
	 */
	pickFallbackCandidate(triedIds: ReadonlySet<string>): FallbackCandidate | null {
		const now = Date.now();
		const order = this.config.activeId
			? [this.config.activeId, ...this.config.chainOrder.filter((id) => id !== this.config.activeId)]
			: this.config.chainOrder;
		for (const id of order) {
			if (triedIds.has(id)) continue;
			const account = this.config.accounts.find((a) => a.id === id);
			if (!account) continue;
			if (account.status === "auth-error") continue;
			if (account.cooldownUntil && account.cooldownUntil > now) continue;
			return { account, credentialSnapshot: cloneCredential(account.credential) };
		}
		// Cooldown exhausted — relax constraint and accept any non-tried account.
		for (const id of order) {
			if (triedIds.has(id)) continue;
			const account = this.config.accounts.find((a) => a.id === id);
			if (!account) continue;
			if (account.status === "auth-error") continue;
			return { account, credentialSnapshot: cloneCredential(account.credential) };
		}
		return null;
	}

	recordSuccess(id: string): Promise<void> {
		return this.serialize(() => {
			const account = this.config.accounts.find((a) => a.id === id);
			if (!account) return;
			account.lastUsedAt = Date.now();
			account.status = "ok";
			account.lastErrorClass = undefined;
			account.lastErrorMessage = undefined;
			// Successful call doesn't auto-promote to active — that's user-controlled.
			// But if active is in cooldown and this isn't, do swap to keep things sane.
			const active = this.findActiveAccount();
			if (
				active &&
				active.id !== id &&
				active.cooldownUntil &&
				active.cooldownUntil > Date.now() &&
				(!account.cooldownUntil || account.cooldownUntil <= Date.now())
			) {
				this.config.activeId = id;
				mirrorActiveCredentialToAuthJson(this.provider, account.credential);
			}
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
		});
	}

	/**
	 * Only auth and quota are attributed to the credential. Every other bucket belongs to the
	 * request, travels back with it, and leaves the account's verdict and the chain alone.
	 */
	recordFailure(id: string, errorClass: ProviderErrorClass, errorMessage: string): Promise<void> {
		return this.serialize(() => {
			if (isRequestCancellation(errorMessage)) return;
			if (errorClass !== "auth" && errorClass !== "quota") return;
			const account = this.config.accounts.find((a) => a.id === id);
			if (!account) return;
			account.lastErrorAt = Date.now();
			account.lastErrorMessage = errorMessage.slice(0, 500);
			account.lastErrorClass = errorClass;
			if (errorClass === "auth") account.status = "auth-error";
			else {
				account.status = "rate-limited";
				account.cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
			}
			if (this.config.activeId === id) {
				const replacement = this.config.chainOrder
					.map((candidateId) => this.config.accounts.find((candidate) => candidate.id === candidateId))
					.find((candidate) =>
						candidate
						&& candidate.id !== id
						&& candidate.status !== "auth-error"
						&& (!candidate.cooldownUntil || candidate.cooldownUntil <= Date.now()));
				if (replacement) {
					this.config.activeId = replacement.id;
					mirrorActiveCredentialToAuthJson(this.provider, replacement.credential);
				}
			}
			saveAccountsConfig(this.provider, this.config);
			this.emit("change", this.snapshot());
		});
	}

	getActiveSummary(): ProviderAccountSummary | null {
		const snap = this.snapshot();
		return snap.accounts.find((a) => a.isActive) ?? null;
	}

	isLoaded(): boolean {
		return this.loaded;
	}
}

function cloneCredential(c: AccountCredential): AccountCredential {
	return JSON.parse(JSON.stringify(c)) as AccountCredential;
}

/** Same identity? — accountId for OAuth, full key for api_key. Used to find the
 *  chain entry that should absorb a refresh, vs. one that's a brand-new sibling. */
function credentialIdentityEquals(a: AccountCredential, b: AccountCredential): boolean {
	if (a.type !== b.type) return false;
	if (a.type === "api_key" && b.type === "api_key") return a.key === b.key;
	if (a.type === "oauth" && b.type === "oauth") {
		const aid = typeof a.accountId === "string" ? a.accountId : "";
		const bid = typeof b.accountId === "string" ? b.accountId : "";
		// OAuth without accountId can't be deduped reliably — fall back to access-token equality.
		if (!aid || !bid) return typeof a.access === "string" && a.access === b.access;
		return aid === bid;
	}
	return false;
}

/** Byte-equal? — used after identity match to skip the "no real change" no-op. */
function credentialBodyEquals(a: AccountCredential, b: AccountCredential): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function maskToken(c: AccountCredential): string | undefined {
	if (c.type === "api_key" && typeof c.key === "string" && c.key.length >= 8) {
		return `${c.key.slice(0, 4)}…${c.key.slice(-4)}`;
	}
	if (c.type === "oauth" && typeof c.access === "string" && c.access.length >= 12) {
		return `${c.access.slice(0, 6)}…${c.access.slice(-4)}`;
	}
	return undefined;
}

const managers = new Map<string, ProviderAccountManager>();

/** Global change feed: emits ("change", provider, snapshot) whenever any provider's chain changes. */
export const accountManagerEvents = new EventEmitter();

export function accountManagerFor(provider: string): ProviderAccountManager {
	let manager = managers.get(provider);
	if (!manager) {
		manager = new ProviderAccountManager(provider);
		manager.on("change", (snapshot: ProviderAccountsState) => accountManagerEvents.emit("change", provider, snapshot));
		managers.set(provider, manager);
	}
	return manager;
}

/** Providers with a chain file on disk, loaded so runtime lookups can stay synchronous. */
export async function loadAllAccountManagers(): Promise<ProviderAccountManager[]> {
	const dir = dirname(accountsConfigPath(CODEX_PROVIDER_KEY));
	const providers = new Set([CODEX_PROVIDER_KEY]);
	if (existsSync(dir)) {
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".json")) providers.add(file.slice(0, -".json".length));
		}
	}
	// Retired codex chain files are not current Provider account configurations.
	providers.delete("codex");
	const loaded: ProviderAccountManager[] = [];
	for (const provider of providers) {
		const manager = accountManagerFor(provider);
		await manager.load();
		loaded.push(manager);
	}
	return loaded;
}

export function loadedAccountSnapshots(): Record<string, ProviderAccountsState> {
	const out: Record<string, ProviderAccountsState> = {};
	for (const [provider, manager] of managers) {
		if (manager.isLoaded() && manager.hasAnyAccount()) out[provider] = manager.snapshot();
	}
	return out;
}

/** True once the provider's chain has entries; runtime callers then route through the chain. */
export function hasAccountChain(provider: string): boolean {
	const manager = managers.get(provider);
	return Boolean(manager?.isLoaded() && manager.hasAnyAccount());
}

export const codexAccountManager = accountManagerFor(CODEX_PROVIDER_KEY);
export type { ProviderAccountManager };
