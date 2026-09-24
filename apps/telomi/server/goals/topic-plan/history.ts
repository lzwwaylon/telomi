import { writeFileAtomic } from "../../lib/fs.js";
import { sha256 } from "../../lib/hash.js";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	truncateSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import {
	hashGoalTopicDocument,
	stringifyGoalTopicDocument,
	TOPIC_PLAN_DOCUMENT_PATH,
	validateConfirmedGoalTopicDocument,
	type ConfirmedGoalTopicDocument,
} from "./document.js";

export interface GoalTopicPlanHistoryEntry {
	schema_version: 1;
	goal_id: string;
	version: string;
	previous_version?: string;
	proposal_id?: string;
	confirmed_at: string;
	content_sha256: string;
	plan: ConfirmedGoalTopicDocument;
}

export class GoalTopicPlanHistory {
	readonly path: string;

	constructor(private readonly goalId: string, dataDir: string) {
		this.path = join(serverRuntimeDirForGoal(goalId, dataDir), "topic-plan", "history.jsonl");
	}

	list(): GoalTopicPlanHistoryEntry[] {
		if (!existsSync(this.path)) return [];
		const content = readFileSync(this.path, "utf-8");
		const complete = content.endsWith("\n");
		const lines = content.split("\n");
		if (complete) lines.pop();
		const entries: GoalTopicPlanHistoryEntry[] = [];
		for (const [index, line] of lines.entries()) {
			if (!line.trim()) continue;
			try {
				const entry = validateHistoryEntry(JSON.parse(line) as GoalTopicPlanHistoryEntry, this.goalId);
				const previous = entries.at(-1);
				if ((previous?.version ?? undefined) !== entry.previous_version) {
					throw new Error("Topic Plan history chain is invalid");
				}
				entries.push(entry);
			} catch (error) {
				if (!complete && index === lines.length - 1) break;
				throw error;
			}
		}
		return entries;
	}

	latest(): GoalTopicPlanHistoryEntry | undefined {
		return this.list().at(-1);
	}

	confirm(document: ConfirmedGoalTopicDocument, expectedVersion: string | null, proposalId: string): GoalTopicPlanHistoryEntry {
		this.repairTornTail();
		const plan = validateConfirmedGoalTopicDocument(document);
		const latest = this.latest();
		if (latest && latest.version !== expectedVersion) {
			throw new Error(`Topic Plan confirmation is stale: expected ${latest.version}`);
		}
		const contentSha256 = hashGoalTopicDocument(plan);
		if (latest?.content_sha256 === contentSha256) return latest;
		const confirmedAt = new Date().toISOString();
		const version = sha256(JSON.stringify({
			goalId: this.goalId,
			previousVersion: latest?.version ?? null,
			confirmedAt,
			contentSha256,
			nonce: randomUUID(),
		}));
		const entry: GoalTopicPlanHistoryEntry = {
			schema_version: 1,
			goal_id: this.goalId,
			version,
			...(latest ? { previous_version: latest.version } : {}),
			proposal_id: proposalId,
			confirmed_at: confirmedAt,
			content_sha256: contentSha256,
			plan,
		};
		this.append(entry);
		return entry;
	}

	private append(entry: GoalTopicPlanHistoryEntry): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const fd = openSync(this.path, "a", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(entry)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	materializeCurrent(goalDir: string, entry = this.latest()): void {
		if (!entry) return;
		const path = join(goalDir, TOPIC_PLAN_DOCUMENT_PATH);
		const content = stringifyGoalTopicDocument(entry.plan);
		if (existsSync(path) && readFileSync(path, "utf-8") === content) return;
		writeFileAtomic(path, content, { mode: 0o600 });
	}

	/**
	 * Rebuild this Goal's durable history from a snapshot written by writeSnapshot().
	 * The snapshot carries the authoritative confirmed revisions and plans; the Goal identity,
	 * content hashes and the version chain come from this store, so nothing is inferred.
	 */
	restoreSnapshot(snapshot: string): GoalTopicPlanHistoryEntry[] {
		if (this.list().length) throw new Error("Topic Plan history already exists for this Goal");
		const entries: GoalTopicPlanHistoryEntry[] = [];
		for (const line of snapshot.split("\n")) {
			if (!line.trim()) continue;
			const value = JSON.parse(line) as { version?: unknown; confirmed_at?: unknown; plan?: unknown };
			if (typeof value.version !== "string" || typeof value.confirmed_at !== "string" || !value.plan) {
				throw new Error("Topic Plan history snapshot entry is invalid");
			}
			const plan = validateConfirmedGoalTopicDocument(value.plan as ConfirmedGoalTopicDocument);
			const previous = entries.at(-1);
			entries.push(validateHistoryEntry({
				schema_version: 1,
				goal_id: this.goalId,
				version: value.version,
				...(previous ? { previous_version: previous.version } : {}),
				confirmed_at: value.confirmed_at,
				content_sha256: hashGoalTopicDocument(plan),
				plan,
			}, this.goalId));
		}
		if (!entries.length) throw new Error("Topic Plan history snapshot is empty");
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileAtomic(this.path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
		return entries;
	}

	writeSnapshot(path: string): void {
		const content = this.list().map((entry) => JSON.stringify({
			version: entry.version,
			confirmed_at: entry.confirmed_at,
			plan: entry.plan,
		})).join("\n");
		writeFileAtomic(path, content ? `${content}\n` : "", { mode: 0o600 });
	}

	private repairTornTail(): void {
		if (!existsSync(this.path)) return;
		const content = readFileSync(this.path);
		if (content.length === 0 || content.at(-1) === 0x0a) return;
		const newline = content.lastIndexOf(0x0a);
		truncateSync(this.path, newline < 0 ? 0 : newline + 1);
	}
}

function validateHistoryEntry(value: GoalTopicPlanHistoryEntry, goalId: string): GoalTopicPlanHistoryEntry {
	if (!value || value.schema_version !== 1 || value.goal_id !== goalId
		|| !/^[a-f0-9]{40,64}$/u.test(value.version)
		|| (value.previous_version !== undefined && !/^[a-f0-9]{40,64}$/u.test(value.previous_version))
		|| (value.proposal_id !== undefined && !/^topic_proposal_[A-Za-z0-9._-]+$/u.test(value.proposal_id))
		|| !Number.isFinite(Date.parse(value.confirmed_at))
		|| !/^[a-f0-9]{64}$/u.test(value.content_sha256)) {
		throw new Error("Topic Plan history entry is invalid");
	}
	const plan = validateConfirmedGoalTopicDocument(value.plan);
	if (hashGoalTopicDocument(plan) !== value.content_sha256) throw new Error("Topic Plan history content hash is invalid");
	return { ...value, plan };
}
