import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isInsideRoot } from "../lib/paths.js";

import { hashDirectory, hashJson, sha256 } from "../lib/hash.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { agentSkillRoot } from "../workspaces/agent-layout.js";
import { bundledAgentSkillPaths, materializeSkills, snapshotSkills } from "../agent-runtime/skill-registry.js";
import { GoalWorkspacePublicationLock } from "../workspaces/publication-lock.js";
import {
	GoalTopicPlanStore,
	parseGoalTopicDocument,
	stringifyGoalTopicDocument,
	TOPIC_PLAN_DOCUMENT_PATH,
	TOPIC_PLAN_SANDBOX_PATH,
	type GoalTopicDocument,
} from "../goals/topic-plan/index.js";
import { comparePaths } from "../lib/paths.js";

const MAIN_WORKSPACE_ROOT = "artifacts/main";
const MAX_CHANGED_FILES = 200;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_PATH_BYTES = 1_024;
export interface MainWorkspaceFileRef {
	path: string;
	sha256: string;
	size: number;
	mode: number;
}

export interface MainWorkspaceChangedFile {
	path: string;
	operation: "add" | "update" | "delete";
	before?: MainWorkspaceFileRef;
	after?: MainWorkspaceFileRef;
}

export interface MainWorkspaceSession {
	id: string;
	goalId: string;
	conversationId: string;
	baseRevision: string;
	capabilityRevision: string;
	sandboxDir: string;
	workDirectory: string;
	runDirectory: string;
	historyDirectory: string;
	createdAt: string;
}

export type MainWorkspacePublishResult =
	| {
			status: "no_change";
			sessionId: string;
			baseRevision: string;
			changedFiles: [];
		}
	| {
			status: "published";
			sessionId: string;
			baseRevision: string;
			publishedRevision: string;
			changedFiles: MainWorkspaceChangedFile[];
			topicPlanDraft?: GoalTopicDocument;
		};

type FileSnapshot = Map<string, MainWorkspaceFileRef>;

class MainWorkspaceStore {
	readonly root: string;

	constructor(
		readonly goalId: string,
		dataDir: string,
	) {
		this.root = join(serverRuntimeDirForGoal(goalId, dataDir), "main-agent");
		for (const directory of ["runs", "sandboxes", "history"]) {
			mkdirSync(join(this.root, directory), { recursive: true });
		}
	}

	sandboxesDir(): string {
		return join(this.root, "sandboxes");
	}

	historyDir(sessionId: string): string {
		return join(this.root, "history", workspaceSegment(sessionId));
	}

	writeRunArtifact(runId: string, relativePath: string, content: string | Buffer): { path: string; sha256: string } {
		return writeImmutable(
			join(this.root, "runs", workspaceSegment(runId), safeRelativePath(relativePath)),
			content,
		);
	}
}

export class MainWorkspaceRuntime {
	private readonly store: MainWorkspaceStore;
	private readonly publicationLock: GoalWorkspacePublicationLock;
	private readonly sessions = new Map<string, MainWorkspaceSession>();
	private readonly baselines = new Map<string, FileSnapshot>();

	constructor(
		private readonly goalDir: string,
		private readonly goalId: string,
		private readonly dataDir: string,
	) {
		this.store = new MainWorkspaceStore(goalId, dataDir);
		this.publicationLock = new GoalWorkspacePublicationLock(goalId, dataDir);
	}

	prepare(input: { conversationId: string }): MainWorkspaceSession {
		const conversationId = input.conversationId.trim();
		if (!conversationId) throw new Error("Main Workspace requires a conversationId");
		const id = `main_${Date.now().toString(36)}_${randomUUID().slice(0, 12)}`;
		const sandboxDir = join(this.store.sandboxesDir(), id);
		if (existsSync(sandboxDir)) throw new Error(`Main Workspace sandbox already exists: ${sandboxDir}`);
		const baseRevision = snapshotRevision(snapshotDirectory(
			join(this.goalDir, MAIN_WORKSPACE_ROOT),
			MAIN_WORKSPACE_ROOT,
		));

		copyDirectory(join(this.goalDir, "artifacts"), join(sandboxDir, "artifacts"));
		const skillRoot = join(sandboxDir, agentSkillRoot("main-agent"));
		materializeSkills(snapshotSkills([
			...bundledAgentSkillPaths("main", "router"),
			join(this.goalDir, agentSkillRoot("main-agent")),
		], { allowOverrides: true }), skillRoot);
		const workDirectory = join(sandboxDir, MAIN_WORKSPACE_ROOT);
		mkdirSync(workDirectory, { recursive: true });
		const topicPlanPath = join(workDirectory, TOPIC_PLAN_SANDBOX_PATH);
		const topicStore = new GoalTopicPlanStore(this.goalId, this.dataDir);
		const topicDocument = topicStore.readMainAgentDocument();
		writeFileSync(topicPlanPath, stringifyGoalTopicDocument(topicDocument), { encoding: "utf-8", mode: 0o600 });
		const baseline = snapshotDirectory(sandboxDir);
		const capabilityRevision = hashDirectory(join(sandboxDir, agentSkillRoot("main-agent")));
		const runDirectory = join(this.store.root, "runs", id);
		mkdirSync(runDirectory, { recursive: true });
		const historyDirectory = this.store.historyDir(id);
		topicStore.writeHistorySnapshot(join(historyDirectory, "topic-plan.jsonl"));
		const session: MainWorkspaceSession = {
			id,
			goalId: this.goalId,
			conversationId,
			baseRevision,
			capabilityRevision,
			sandboxDir,
			workDirectory,
			runDirectory,
			historyDirectory,
			createdAt: new Date().toISOString(),
		};
		this.sessions.set(id, session);
		this.baselines.set(id, baseline);
		this.store.writeRunArtifact(id, "session.json", `${JSON.stringify(session, null, 2)}\n`);
		return session;
	}

	async publish(sessionId: string): Promise<MainWorkspacePublishResult> {
		const session = this.requireSession(sessionId);
		const baseline = this.requireBaseline(sessionId);

		try {
			const candidate = snapshotDirectory(session.sandboxDir);
			const paths = changedPaths(baseline, candidate);
			if (paths.length === 0) {
				return {
					status: "no_change",
					sessionId: session.id,
					baseRevision: session.baseRevision,
					changedFiles: [],
				};
			}
			validateChangedPaths(session.sandboxDir, paths);
			const changedFiles = paths.map((path) => describeChange(path, baseline, candidate));
			let topicPlanDraft: GoalTopicDocument | undefined;
			if (paths.includes(TOPIC_PLAN_DOCUMENT_PATH)) {
				const path = join(session.workDirectory, TOPIC_PLAN_SANDBOX_PATH);
				if (!existsSync(path)) throw new Error("Main Agent cannot delete topic-plan.json");
				topicPlanDraft = parseGoalTopicDocument(readFileSync(path, "utf-8"));
			}
			const publishedCandidate = new Map(candidate);
			if (topicPlanDraft) {
				const previous = baseline.get(TOPIC_PLAN_DOCUMENT_PATH);
				if (previous) publishedCandidate.set(TOPIC_PLAN_DOCUMENT_PATH, previous);
				else publishedCandidate.delete(TOPIC_PLAN_DOCUMENT_PATH);
			}
			const publishedRevision = snapshotRevision(filesUnder(publishedCandidate, MAIN_WORKSPACE_ROOT));

			await this.publicationLock.withLock("main-workspace", () => {
				const liveRevision = snapshotRevision(snapshotDirectory(
					join(this.goalDir, MAIN_WORKSPACE_ROOT),
					MAIN_WORKSPACE_ROOT,
				));
				if (liveRevision !== session.baseRevision) throw new Error("main_workspace_base_drift");
				publishDirectoryAtomically(
					join(session.sandboxDir, MAIN_WORKSPACE_ROOT),
					join(this.goalDir, MAIN_WORKSPACE_ROOT),
					session.id,
					topicPlanDraft ? [TOPIC_PLAN_SANDBOX_PATH] : [],
				);
			});

			return {
				status: "published",
				sessionId: session.id,
				baseRevision: session.baseRevision,
				publishedRevision,
				changedFiles,
				...(topicPlanDraft ? { topicPlanDraft } : {}),
			};
		} finally {
			this.cleanup(session);
		}
	}

	async abort(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) this.cleanup(session);
	}

	writeRunRecord(runId: string, relativePath: string, value: unknown): { path: string; sha256: string } {
		return this.store.writeRunArtifact(runId, relativePath, `${JSON.stringify(value, null, 2)}\n`);
	}

	writeRunMessages(runId: string, messages: readonly unknown[]): { path: string; sha256: string } {
		return this.store.writeRunArtifact(
			runId,
			"main-agent.jsonl",
			messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
		);
	}

	private requireSession(sessionId: string): MainWorkspaceSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`Unknown Main Workspace session: ${sessionId}`);
		return session;
	}

	private requireBaseline(sessionId: string): FileSnapshot {
		const baseline = this.baselines.get(sessionId);
		if (!baseline) throw new Error(`Missing Main Workspace baseline: ${sessionId}`);
		return baseline;
	}

	private cleanup(session: MainWorkspaceSession): void {
		this.sessions.delete(session.id);
		this.baselines.delete(session.id);
		rmSync(session.sandboxDir, { recursive: true, force: true });
		rmSync(session.historyDirectory, { recursive: true, force: true });
	}
}

function copyDirectory(source: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	if (!existsSync(source)) return;
	const sourceStat = lstatSync(source);
	if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
		throw new Error(`Main Workspace snapshot source must be a real directory: ${source}`);
	}
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = join(source, entry.name);
		const to = join(destination, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Main Workspace snapshot cannot contain symlink: ${from}`);
		if (entry.isDirectory()) copyDirectory(from, to);
		else if (entry.isFile()) copyFileSync(from, to);
		else throw new Error(`Main Workspace snapshot only accepts files and directories: ${from}`);
	}
}

function snapshotDirectory(root: string, pathPrefix = ""): FileSnapshot {
	const files: FileSnapshot = new Map();
	if (!existsSync(root)) return files;
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`Main Workspace snapshot root must be a real directory: ${root}`);
	}
	const walk = (directory: string, relativePath: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const nested = relativePath ? `${relativePath}/${entry.name}` : entry.name;
			const absolute = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Main Workspace cannot contain symlink: ${nested}`);
			if (entry.isDirectory()) {
				walk(absolute, nested);
				continue;
			}
			const stat = lstatSync(absolute);
			if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1) {
				throw new Error(`Main Workspace only accepts regular files: ${nested}`);
			}
			const path = pathPrefix ? `${pathPrefix}/${nested}` : nested;
			const content = readFileSync(absolute);
			files.set(path, {
				path,
				sha256: sha256(content),
				size: stat.size,
				mode: stat.mode & 0o777,
			});
		}
	};
	walk(root, "");
	return files;
}

function filesUnder(snapshot: FileSnapshot, root: string): FileSnapshot {
	return new Map([...snapshot].filter(([path]) => path.startsWith(`${root}/`)));
}

function snapshotRevision(snapshot: FileSnapshot): string {
	return hashJson([...snapshot.values()].sort((a, b) => comparePaths(a.path, b.path)));
}

function changedPaths(before: FileSnapshot, after: FileSnapshot): string[] {
	return [...new Set([...before.keys(), ...after.keys()])]
		.filter((path) => !sameFile(before.get(path), after.get(path)))
		.sort();
}

function sameFile(left: MainWorkspaceFileRef | undefined, right: MainWorkspaceFileRef | undefined): boolean {
	return left?.sha256 === right?.sha256
		&& left?.size === right?.size
		&& left?.mode === right?.mode;
}

function validateChangedPaths(sandboxDir: string, paths: string[]): void {
	if (paths.length > MAX_CHANGED_FILES) {
		throw new Error(`Main Workspace changed file count exceeds ${MAX_CHANGED_FILES}`);
	}
	const ownedRoot = join(sandboxDir, MAIN_WORKSPACE_ROOT);
	if (!existsSync(ownedRoot) || !lstatSync(ownedRoot).isDirectory() || lstatSync(ownedRoot).isSymbolicLink()) {
		throw new Error("Main Workspace owned root must be a real directory");
	}
	const root = realpathSync(ownedRoot);
	let totalBytes = 0;
	for (const path of paths) {
		validateOwnedPath(path);
		const absolutePath = resolve(sandboxDir, path);
		if (!existsSync(absolutePath)) continue;
		const stat = lstatSync(absolutePath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
			throw new Error(`Main Workspace only accepts regular files: ${path}`);
		}
		if (!isInsideRoot(root, realpathSync(absolutePath), { rejectDotPrefix: true })) {
			throw new Error(`Main Workspace file escapes the owned root: ${path}`);
		}
		if (stat.size > MAX_FILE_BYTES) throw new Error(`Main Workspace file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
		totalBytes += stat.size;
	}
	if (totalBytes > MAX_TOTAL_BYTES) {
		throw new Error(`Main Workspace changed content exceeds ${MAX_TOTAL_BYTES} bytes`);
	}
	validateCaseCollisions(ownedRoot);
}

function validateOwnedPath(path: string): void {
	const normalized = path.replaceAll("\\", "/");
	if (
		!normalized.startsWith(`${MAIN_WORKSPACE_ROOT}/`)
		|| normalized === MAIN_WORKSPACE_ROOT
		|| isAbsolute(normalized)
		|| normalized.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error(`Main Workspace may only modify ${MAIN_WORKSPACE_ROOT}/**: ${path}`);
	}
	if (Buffer.byteLength(normalized, "utf-8") > MAX_PATH_BYTES) {
		throw new Error(`Main Workspace path exceeds ${MAX_PATH_BYTES} bytes: ${path}`);
	}
}

function validateCaseCollisions(root: string): void {
	const seen = new Map<string, string>();
	const walk = (directory: string, prefix: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) throw new Error(`Main Workspace cannot contain symlink: ${join(prefix, entry.name)}`);
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			const folded = path.normalize("NFC").toLocaleLowerCase("en-US");
			const previous = seen.get(folded);
			if (previous && previous !== path) {
				throw new Error(`Main Workspace contains a case-colliding path: ${previous}, ${path}`);
			}
			seen.set(folded, path);
			if (entry.isDirectory()) walk(join(directory, entry.name), path);
			else if (!entry.isFile()) throw new Error(`Main Workspace only accepts files and directories: ${path}`);
		}
	};
	walk(root, "");
}

function describeChange(path: string, before: FileSnapshot, after: FileSnapshot): MainWorkspaceChangedFile {
	const previous = before.get(path);
	const next = after.get(path);
	return {
		path,
		operation: previous ? next ? "update" : "delete" : "add",
		...(previous ? { before: previous } : {}),
		...(next ? { after: next } : {}),
	};
}

function publishDirectoryAtomically(source: string, target: string, sessionId: string, preserve: string[] = []): void {
	const parent = dirname(target);
	mkdirSync(parent, { recursive: true });
	const staging = join(parent, `.main-publish-${workspaceSegment(sessionId)}`);
	const backup = join(parent, `.main-backup-${workspaceSegment(sessionId)}`);
	rmSync(staging, { recursive: true, force: true });
	rmSync(backup, { recursive: true, force: true });
	copyDirectory(source, staging);
	for (const relativePath of preserve) {
		const livePath = join(target, relativePath);
		const stagedPath = join(staging, relativePath);
		if (existsSync(livePath)) {
			mkdirSync(dirname(stagedPath), { recursive: true });
			copyFileSync(livePath, stagedPath);
		} else {
			rmSync(stagedPath, { force: true });
		}
	}
	const hadTarget = existsSync(target);
	try {
		if (hadTarget) renameSync(target, backup);
		renameSync(staging, target);
		rmSync(backup, { recursive: true, force: true });
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
		throw error;
	}
}

function writeImmutable(path: string, content: string | Buffer): { path: string; sha256: string } {
	const contentHash = sha256(content);
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) {
		if (sha256(readFileSync(path)) !== contentHash) {
			throw new Error(`Immutable Main Workspace artifact already exists with different content: ${path}`);
		}
		return { path, sha256: contentHash };
	}
	writeFileSync(path, content, { flag: "wx", mode: 0o600 });
	return { path, sha256: contentHash };
}

function safeRelativePath(value: string): string {
	const parts = value.split(/[\\/]+/u).filter((part) => part && part !== "." && part !== "..");
	if (parts.length === 0) throw new Error("Main Workspace artifact path is empty");
	return parts.join("/");
}

function workspaceSegment(value: string): string {
	const safe = value.trim().replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 180);
	if (!safe || basename(safe) !== safe) throw new Error("Invalid Main Workspace identity");
	return safe;
}
