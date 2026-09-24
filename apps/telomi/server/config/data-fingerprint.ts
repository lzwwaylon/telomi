// What a daily snapshot protects, reduced to one comparable value.
//
// `npm run upgrade -- --snapshot-only` records this in `snapshot.json` and skips the next daily
// snapshot while it is unchanged. Everything in the data directory counts, except state that a
// running installation changes by itself: an unknown new kind of state therefore causes a snapshot,
// never a missed one. User Memory counts by content, through Hindsight, because PostgreSQL rewrites
// its files on every stop and start.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { normalizeBaseUrl } from "../goals/memory/hindsight-runtime.js";

/**
 * Data-directory paths left out of the fingerprint, relative and `/`-separated. `*` matches one path
 * segment; a leading `**` matches any number. List only state that changes without any user action,
 * observed on an idle installation or driven by a timer. Anything else counts, including runtime
 * state, since some of it is the user's: pending User Memory deletions, the prompt registry, Research
 * Schedules and Topic Plan Proposals all live under `.pi/runtime`.
 */
export const SELF_CHANGING_STATE = [
	"browser-profile", // managed browser; rewritten whenever it runs (observed idle and on every start)
	"user-memory", // counted by content below; PostgreSQL rewrites its files while idle and on every start
	".pi/runtime/chrome-debug", // managed browser's state file and log, appended while idle (observed)
	".pi/runtime/logs", // server output `npm run upgrade` appends to on every start without a supervisor
	".pi/agent/source-status.json", // connection probe results, rewritten on every start (observed)
	"**/node-evaluation", // Evaluation Cases in every Run root; the hourly retention sweep deletes old ones
	".pi/runtime/harness/*/evaluation/node-backtests", // replays of those Cases, deleted by the same sweep
	".pi/runtime/harness/*/evolution/runs", // automatic Evolution records the sweep compacts; the evolved Skill counts
] as const;

/** `pattern` covers `path` itself or an ancestor of it. */
function covers(pattern: string, path: string): boolean {
	const segments = path.split("/");
	const anywhere = pattern.startsWith("**/");
	const parts = (anywhere ? pattern.slice(3) : pattern).split("/");
	const matchesAt = (start: number) => start + parts.length <= segments.length
		&& parts.every((part, index) => part === "*" || part === segments[start + index]);
	return anywhere ? segments.some((_, start) => matchesAt(start)) : matchesAt(0);
}

type Json = Record<string, unknown>;

/** Credentials the user entered count; OAuth tokens the runtime refreshes by itself do not. */
function credential(value: unknown): unknown {
	const entry = value as Json | undefined;
	return entry?.type === "oauth" ? { type: "oauth", accountId: entry.accountId } : value;
}

/**
 * Agent files that mix user configuration with state the runtime rewrites. Only the configuration
 * counts: the model catalog a periodic sync appends to, refreshed OAuth tokens and per-account
 * usage records (`lastUsedAt`, `status`) do not.
 */
const PROJECTIONS: Record<string, (file: Json) => unknown> = {
	".pi/agent/models.json": (file) => Object.entries((file.providers ?? {}) as Record<string, Json>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, { models, ...connection }]) => [name, connection,
			connection.userSelectedModels === true && Array.isArray(models) ? models.map((model) => (model as Json).id).sort() : null]),
	".pi/agent/auth.json": (file) => Object.entries(file).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, credential(value)]),
	".pi/agent/accounts/*": (file) => ({
		accounts: ((file.accounts ?? []) as Json[]).map(({ id, label, createdAt, credential: value }) => ({ id, label, createdAt, credential: credential(value) })),
		chainOrder: file.chainOrder,
		activeId: file.activeId,
	}),
};

/** Undefined for a file that does not parse, which then counts by size and time like any other. */
function projectedContent(path: string, projection: (file: Json) => unknown): string | undefined {
	try {
		return JSON.stringify(projection(JSON.parse(readFileSync(path, "utf8")) as Json));
	} catch {
		return undefined;
	}
}

/** Every counted file, by its projected content or else its size and modification time, in a stable order. */
export function dataDirectoryEntries(dataDir: string): string[] {
	const entries: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const name = relative(dataDir, path).split(sep).join("/");
			if (SELF_CHANGING_STATE.some((pattern) => covers(pattern, name))) continue;
			if (entry.isDirectory()) {
				visit(path);
				continue;
			}
			const projection = Object.entries(PROJECTIONS).find(([pattern]) => covers(pattern, name))?.[1];
			const projected = projection && projectedContent(path, projection);
			if (projected !== undefined) entries.push(`${name}\t${projected}`);
			else {
				const stat = lstatSync(path);
				entries.push(`${name}\t${stat.size}\t${stat.mtimeMs}`);
			}
		}
	};
	visit(dataDir);
	return entries.sort();
}

/**
 * User Memory's content marker: per bank, its profile update time, fact count and last write. It
 * moves with every retained document, stored or consolidated fact, deleted memory and profile edit.
 * Undefined when Hindsight does not answer, so the caller cannot mistake it for "unchanged".
 */
export async function userMemoryMarker(env: NodeJS.ProcessEnv): Promise<string | undefined> {
	try {
		const response = await fetch(`${normalizeBaseUrl(env.HINDSIGHT_URL)}/banks`, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return undefined;
		const { banks } = await response.json() as { banks?: Array<Record<string, unknown>> };
		if (!Array.isArray(banks)) return undefined;
		return JSON.stringify(banks
			.map((bank) => [bank.bank_id, bank.updated_at, bank.fact_count, bank.last_document_at, bank.last_write_at])
			.sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
	} catch {
		return undefined;
	}
}

/**
 * The fingerprint of what a snapshot protects, or undefined when part of it cannot be read; an
 * undefined fingerprint never matches, so the caller takes the snapshot. Read it while the
 * installation is idle and still running: User Memory is only readable through the running service.
 */
export async function dataFingerprint(dataDir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const memory = await userMemoryMarker(env);
	if (memory === undefined) return undefined;
	const hash = createHash("sha256");
	for (const entry of dataDirectoryEntries(dataDir)) hash.update(`${entry}\n`);
	hash.update(`user-memory\t${memory}\n`);
	return hash.digest("hex");
}
