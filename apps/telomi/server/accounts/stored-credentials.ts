import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { lockSync } from "proper-lockfile";
import { writeFileAtomic } from "../lib/fs.js";
import { logWarning } from "../lib/log.js";

export type StoredCredentials = Record<string, Credential>;
const LOCK_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

export function readStoredCredentials(path: string): StoredCredentials {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("auth.json must contain an object");
	}
	return parsed as StoredCredentials;
}

export function writeStoredCredential(
	path: string,
	providerId: string,
	credential: Credential | null,
): void {
	modifyStoredCredential(path, providerId, () => credential);
}

/**
 * Replace one credential while holding the file lock, deciding from the value that is actually
 * stored at that moment. Activation uses this so a credential written or deleted while a slower
 * request was validating is never silently overwritten: returning `undefined` keeps the newer edit.
 */
export function modifyStoredCredential(
	path: string,
	providerId: string,
	update: (current: Credential | undefined) => Credential | null | undefined,
): boolean {
	return modifyStoredCredentials(path, (credentials) => {
		const next = update(credentials[providerId]);
		if (next === undefined) return undefined;
		if (next) credentials[providerId] = next;
		else delete credentials[providerId];
		return credentials;
	});
}

/** Atomically replace a related credential set under the same file lock. */
export function modifyStoredCredentials(
	path: string,
	update: (current: StoredCredentials) => StoredCredentials | undefined,
): boolean {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (!existsSync(path)) {
		try {
			writeFileSync(path, "{}\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
		}
	}
	const release = acquireLock(path);
	try {
		const next = update(readStoredCredentials(path));
		if (next === undefined) return false;
		writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		return true;
	} finally {
		release();
	}
}

/**
 * How long a writer keeps trying for the lock. A fixed number of short retries starved
 * writers once a dozen processes queued on a loaded machine; each holder is quick, so
 * waiting out a queue is right and giving up is not.
 */
const LOCK_WAIT_MS = 10_000;

function acquireLock(path: string): () => void {
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			// A holder keeps its lock fresh on a timer, and a compromised lock reports through this
			// callback. The library's default reports by throwing from that timer, where no caller
			// can catch it and the process ends. A write here never yields while holding the lock,
			// so nothing should reach this; losing the whole server, and every Run it is carrying,
			// is not the right answer to one credential write if that ever changes.
			return lockSync(path, {
				realpath: false,
				onCompromised: (error) => logWarning(`credential lock on ${path} was compromised`, error.message),
			});
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error
				? String(error.code)
				: undefined;
			if (code !== "ELOCKED" || Date.now() >= deadline) throw error;
			Atomics.wait(LOCK_RETRY_SIGNAL, 0, 0, 25 + Math.floor(Math.random() * 50));
		}
	}
}
