/**
 * Multi-account fallback chain, one per Provider.
 *
 * Storage lives in the project agent directory's accounts/<provider>.json (separate from
 * auth.json so we don't fight Pi's credential schema). The currently-active account is
 * mirrored into auth.json's provider slot on every switch so forked CLI subprocesses and
 * single-slot consumers pick it up transparently.
 */

import type { ProviderAccountStatus, ProviderErrorClass } from "../../shared/types.js";

export type {
	ProviderAccountStatus,
	ProviderAccountSummary,
	ProviderAccountsState,
	ProviderErrorClass,
	CodexUsageSnapshot,
	CodexUsageTokenSummary,
	CodexUsageWindow,
} from "../../shared/types.js";

/** Mirrors the per-provider entry shape used by pi-coding-agent's auth.json. */
export type AccountCredential =
	| {
			type: "oauth";
			access?: string;
			refresh?: string;
			expires?: number;
			accountId?: string;
			[k: string]: unknown;
	  }
	| {
			type: "api_key";
			key: string;
	  };

export interface ProviderAccount {
	id: string;
	label: string;
	credential: AccountCredential;
	createdAt: number;
	lastUsedAt?: number;
	lastErrorAt?: number;
	lastErrorMessage?: string;
	lastErrorClass?: ProviderErrorClass;
	status: ProviderAccountStatus;
	/** Epoch ms — skip this account in fallback rotation until this time. */
	cooldownUntil?: number;
}

export interface ProviderAccountsConfig {
	version: 1;
	accounts: ProviderAccount[];
	/** Account ids in the order they should be tried. Defaults to creation order. */
	chainOrder: string[];
	/** Currently-active account; mirrored into auth.json's provider slot. */
	activeId: string | null;
}
