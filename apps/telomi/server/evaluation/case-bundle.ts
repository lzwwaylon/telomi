import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	cpSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { runtimeControlRoot } from "../workspaces/server-runtime-paths.js";
import { listFilesRecursive } from "../lib/fs.js";
import { toErrorMessage } from "../lib/values.js";
import { sha256, createSha256 } from "../lib/hash.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import type { WorkspaceSnapshotRecord } from "../observability/run-records.js";
import type { NodeEvaluationCase } from "../agent-runtime/node-evaluation.js";
import { isFileNameSegment } from "../lib/paths.js";

const BLOCK = 512;
const CHUNK = 1024 * 1024;
const MAX_ENTRY_BYTES = 0o77777777777;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{64}$/u;

export interface CaseBundleManifest {
	schema_version: 1;
	goal_id: string;
	goal_title: string;
	source_run_id: string;
	case_id: string;
	agent_id: string;
	node_id: string;
	attempt_id: string;
	runtime_build: string;
	agent_bundle_sha256: string;
	capability_snapshot_id: string | null;
	workspace: { input_tree_sha: string; output_tree_sha: string; exclude: string[]; input_tree_source?: string } | null;
	provider_calls: { path: string; sha256: string } | null;
	files: Array<{ path: string; sha256: string; mode: number; bytes: number }>;
	/** Additive export diagnostics for optional workspace materialization. */
	warnings?: string[];
}

export interface TarEntryHeader {
	name: string;
	size: number;
	type: string;
}

export type TarInput = { name: string } & ({ content: Buffer } | { path: string });

export function writeTar(path: string, entries: Iterable<TarInput>): void {
	const fd = openSync(path, "w", 0o600);
	try {
		for (const entry of entries) {
			if ("content" in entry) writeTarEntry(fd, entry.name, entry.content.byteLength, [entry.content]);
			else writeTarEntry(fd, entry.name, statSync(entry.path).size, fileChunks(entry.path));
		}
		writeSync(fd, Buffer.alloc(BLOCK * 2));
	} finally {
		closeSync(fd);
	}
}

export function readTar(path: string, visit: (entry: TarEntryHeader, chunks: Iterable<Buffer>) => void): void {
	const fd = openSync(path, "r");
	try {
		const total = fstatSync(fd).size;
		let position = 0;
		const header = Buffer.alloc(BLOCK);
		while (position + BLOCK <= total) {
			if (readSync(fd, header, 0, BLOCK, position) !== BLOCK) throw new Error("Truncated tar header");
			position += BLOCK;
			if (header.every((byte) => byte === 0)) break;
			const entry = parseTarHeader(header);
			const dataStart = position;
			if (dataStart + entry.size > total) throw new Error(`Truncated tar entry '${entry.name}'`);
			visit(entry, {
				*[Symbol.iterator]() {
					let offset = 0;
					while (offset < entry.size) {
						const chunk = Buffer.alloc(Math.min(CHUNK, entry.size - offset));
						const bytes = readSync(fd, chunk, 0, chunk.byteLength, dataStart + offset);
						if (bytes !== chunk.byteLength) throw new Error(`Truncated tar entry '${entry.name}'`);
						offset += bytes;
						yield chunk;
					}
				},
			});
			position = dataStart + Math.ceil(entry.size / BLOCK) * BLOCK;
		}
	} finally {
		closeSync(fd);
	}
}

export async function createCaseBundle(input: {
	dataDir: string;
	goalId: string;
	goalTitle: string;
	casePath: string;
	value: NodeEvaluationCase;
	runtimeBuild: string;
	agentBundleSha256: string;
	capabilitySnapshotId?: string;
	capabilityContentDirectory?: string;
	restoreTree: (treeSha: string, destination: string) => Promise<unknown>;
}): Promise<{ path: string; manifest: CaseBundleManifest; cleanup: () => void }> {
	const temporary = mkdtempSync(join(runtimeTempDirectory(input.dataDir), "bundle-export-"));
	try {
		const files = bundleFiles("case", dirname(input.casePath));
		if (input.capabilitySnapshotId) {
			if (!input.capabilityContentDirectory) throw new Error(`Capability Snapshot '${input.capabilitySnapshotId}' is unavailable`);
			files.push(...bundleFiles("capability", input.capabilityContentDirectory));
		}
		const warnings: string[] = [];
		const workspace = completeWorkspace(input.value.workspace);
		if (input.value.workspace && !workspace) {
			warnings.push("workspace trees omitted because the case does not contain both input and output tree shas");
		}
		if (workspace) {
			for (const [phase, treeSha] of [["input", workspace.input_tree_sha], ["output", workspace.output_tree_sha]] as const) {
				const destination = join(temporary, "workspace", phase);
				mkdirSync(destination, { recursive: true });
				try {
					await input.restoreTree(treeSha, destination);
					files.push(...bundleFiles(`workspace/${phase}`, destination));
				} catch (error) {
					rmSync(destination, { recursive: true, force: true });
					warnings.push(`workspace/${phase} omitted: ${toErrorMessage(error)}`);
				}
			}
		}
		files.sort((left, right) => left.path.localeCompare(right.path));
		const manifest: CaseBundleManifest = {
			schema_version: 1,
			goal_id: input.goalId,
			goal_title: input.goalTitle,
			source_run_id: input.value.runId,
			case_id: input.value.caseId,
			agent_id: input.value.agentId,
			node_id: input.value.nodeId,
			attempt_id: input.value.attemptId,
			runtime_build: input.runtimeBuild,
			agent_bundle_sha256: input.agentBundleSha256,
			capability_snapshot_id: input.capabilitySnapshotId ?? null,
			workspace,
			provider_calls: input.value.observed.providerCalls
				? { path: `case/${input.value.observed.providerCalls.ref}`, sha256: input.value.observed.providerCalls.sha256 }
				: null,
			files: files.map(({ absolutePath: _absolutePath, ...file }) => file),
			...(warnings.length ? { warnings } : {}),
		};
		const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
		const tarPath = join(temporary, "case-bundle.tar");
		const blobs = new Map(files.map((file) => [file.sha256, file.absolutePath]));
		writeTar(tarPath, [
			{ name: "manifest.json", content: manifestBytes },
			...[...blobs].sort(([left], [right]) => left.localeCompare(right)).map(([digest, path]) => ({ name: `blobs/${digest}`, path })),
		]);
		return { path: tarPath, manifest, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
}

export function importCaseBundle(input: {
	path: string;
	dataDir: string;
	ensureGoal: (id: string, title: string) => void;
	capabilityContentHash: (directory: string, expectedHash: string) => string;
}): { ok: true; goalId: string; caseRef: { sourceRunId: string; caseId: string }; bundleSha256: string; capabilitySnapshotId: string | null } {
	const source = safeRegularFile(input.path, "Case Bundle");
	const temporary = mkdtempSync(join(runtimeTempDirectory(input.dataDir), "bundle-import-"));
	try {
		let manifestBytes: Buffer | undefined;
		const blobs = new Map<string, { path: string; bytes: number }>();
		readTar(source, (entry, chunks) => {
			if (entry.type !== "0" && entry.type !== "\0") throw new Error(`Unexpected tar entry type for '${entry.name}'`);
			const name = entry.name.replace(/^\.\//u, "");
			if (name === "manifest.json") {
				if (manifestBytes) throw new Error("Bundle contains duplicate manifest.json entries");
				if (entry.size > MAX_MANIFEST_BYTES) throw new Error("manifest.json exceeds 64 MiB");
				manifestBytes = Buffer.concat([...chunks]);
				return;
			}
			const digest = name.startsWith("blobs/") ? name.slice("blobs/".length) : "";
			if (!SHA_PATTERN.test(digest) || blobs.has(digest)) throw new Error(`Unexpected tar entry '${entry.name}'`);
			const path = join(temporary, digest);
			const hash = createSha256();
			const fd = openSync(path, "wx", 0o600);
			try {
				for (const chunk of chunks) {
					hash.update(chunk);
					writeSync(fd, chunk);
				}
			} finally {
				closeSync(fd);
			}
			const actual = hash.digest("hex");
			if (actual !== digest) throw new Error(`Blob ${digest} hashed to ${actual}: bundle rejected`);
			blobs.set(digest, { path, bytes: entry.size });
		});
		if (!manifestBytes) throw new Error("Bundle has no manifest.json");
		const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf-8")) as unknown);
		validateBundleFiles(manifest, blobs);
		const caseManifestFile = manifest.files.find((file) => file.path === "case/manifest.json")!;
		const nodeCase = JSON.parse(readFileSync(blobs.get(caseManifestFile.sha256)!.path, "utf-8")) as NodeEvaluationCase;
		validateCaseIdentity(nodeCase, manifest);
		const bundleSha256 = sha256(manifestBytes);
		const runtimeRoot = serverRuntimeDirForGoal(manifest.goal_id, input.dataDir);
		const importedRoot = join(runtimeRoot, "evaluation", "imported-cases", bundleSha256);
		const capabilityRoot = manifest.capability_snapshot_id
			? join(runtimeRoot, "evaluation", "capability-snapshots", manifest.capability_snapshot_id)
			: undefined;
		const staging = join(temporary, "content");
		for (const file of manifest.files) {
			const destination = bundleDestination(staging, manifest.case_id, file.path);
			mkdirSync(dirname(destination), { recursive: true });
			cpSync(blobs.get(file.sha256)!.path, destination);
			chmodSync(destination, file.mode);
		}
		if (nodeCase.input?.fileCount === 0) {
			const caseRoot = join(staging, "node-evaluation", "cases", manifest.case_id);
			mkdirSync(resolveInside(nodeCase.input.root === "case" ? caseRoot : staging, nodeCase.input.ref), { recursive: true });
		}
		if (manifest.capability_snapshot_id) {
			const capabilityDirectory = join(staging, "capability");
			if (!existsSync(capabilityDirectory)) throw new Error("Bundle references a Capability Snapshot but has no capability files");
			const contentHash = input.capabilityContentHash(capabilityDirectory, manifest.capability_snapshot_id.slice("caps_".length));
			if (manifest.capability_snapshot_id !== `caps_${contentHash}`) {
				throw new Error(`Capability Snapshot '${manifest.capability_snapshot_id}' content hash is ${contentHash}`);
			}
		}
		input.ensureGoal(manifest.goal_id, manifest.goal_title);
		if (capabilityRoot) registerCapabilitySnapshot(capabilityRoot, manifest, staging, input.capabilityContentHash);
		materializeImportedCase(importedRoot, manifest, staging);
		return {
			ok: true,
			goalId: manifest.goal_id,
			caseRef: { sourceRunId: manifest.source_run_id, caseId: manifest.case_id },
			bundleSha256,
			capabilitySnapshotId: manifest.capability_snapshot_id,
		};
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function bundleFiles(prefix: string, root: string): Array<CaseBundleManifest["files"][number] & { absolutePath: string }> {
	return listFilesRecursive(root, { absolute: true, includeNonRegular: true, strict: true }).map((absolutePath) => {
		const stat = lstatSync(absolutePath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Bundle source is not one regular file: ${absolutePath}`);
		if (stat.size > MAX_ENTRY_BYTES) throw new Error(`Bundle file '${absolutePath}' is over 8 GiB and cannot be exported`);
		return {
			path: `${prefix}/${relative(root, absolutePath).split(sep).join("/")}`,
			sha256: fileSha256(absolutePath),
			mode: stat.mode & 0o777,
			bytes: stat.size,
			absolutePath,
		};
	});
}

function completeWorkspace(value: WorkspaceSnapshotRecord | undefined): CaseBundleManifest["workspace"] {
	return value?.input_tree_sha && value.output_tree_sha
		? {
			input_tree_sha: value.input_tree_sha,
			output_tree_sha: value.output_tree_sha,
			exclude: [...value.exclude],
			...(value.input_tree_source ? { input_tree_source: value.input_tree_source } : {}),
		}
		: null;
}

function validateManifest(value: unknown): CaseBundleManifest {
	if (!value || typeof value !== "object") throw new Error("Bundle manifest must be an object");
	const manifest = value as CaseBundleManifest;
	if (manifest.schema_version !== 1 || !Array.isArray(manifest.files)) throw new Error("Bundle manifest is not schema_version 1");
	for (const [field, fieldValue] of Object.entries({
		goal_id: manifest.goal_id,
		goal_title: manifest.goal_title,
		source_run_id: manifest.source_run_id,
		case_id: manifest.case_id,
		agent_id: manifest.agent_id,
		node_id: manifest.node_id,
		attempt_id: manifest.attempt_id,
		runtime_build: manifest.runtime_build,
	})) if (typeof fieldValue !== "string" || !fieldValue) throw new Error(`Bundle manifest ${field} is required`);
	for (const [field, fieldValue] of [["goal_id", manifest.goal_id], ["source_run_id", manifest.source_run_id], ["case_id", manifest.case_id]] as const) {
		if (!isFileNameSegment(fieldValue)) throw new Error(`Bundle manifest ${field} is invalid`);
	}
	if (!SHA_PATTERN.test(manifest.agent_bundle_sha256)) throw new Error("Bundle manifest agent_bundle_sha256 is invalid");
	if (manifest.capability_snapshot_id !== null && !/^caps_[a-f0-9]{64}$/u.test(manifest.capability_snapshot_id)) {
		throw new Error("Bundle manifest capability_snapshot_id is invalid");
	}
	if (manifest.workspace !== null && (!SHA_PATTERN.test(manifest.workspace.input_tree_sha)
		|| !SHA_PATTERN.test(manifest.workspace.output_tree_sha) || !Array.isArray(manifest.workspace.exclude))) {
		throw new Error("Bundle manifest workspace is invalid");
	}
	if (manifest.provider_calls !== null && (!safeBundlePath(manifest.provider_calls.path)
		|| !manifest.provider_calls.path.startsWith("case/") || !SHA_PATTERN.test(manifest.provider_calls.sha256))) {
		throw new Error("Bundle manifest provider_calls is invalid");
	}
	return manifest;
}

function validateBundleFiles(
	manifest: CaseBundleManifest,
	blobs: Map<string, { path: string; bytes: number }>,
): void {
	const paths = new Set<string>();
	for (const file of manifest.files) {
		if (!safeBundlePath(file.path) || !/^(?:case|capability|workspace\/(?:input|output))\//u.test(file.path)) {
			throw new Error(`Bundle file path '${file.path}' is invalid`);
		}
		if (paths.has(file.path)) throw new Error(`Bundle file path '${file.path}' is duplicated`);
		paths.add(file.path);
		if (!SHA_PATTERN.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
			|| !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error(`Bundle file '${file.path}' is invalid`);
		const blob = blobs.get(file.sha256);
		if (!blob) throw new Error(`Bundle is missing blob ${file.sha256} for ${file.path}`);
		if (blob.bytes !== file.bytes) throw new Error(`Blob ${file.sha256} has ${blob.bytes} bytes, manifest says ${file.bytes}`);
	}
	if (!paths.has("case/manifest.json")) throw new Error("Bundle has no case/manifest.json");
	const listed = new Set(manifest.files.map((file) => file.sha256));
	for (const digest of blobs.keys()) if (!listed.has(digest)) throw new Error(`Blob ${digest} is not listed in the manifest`);
	if (manifest.provider_calls && !manifest.files.some((file) => file.path === manifest.provider_calls!.path
		&& file.sha256 === manifest.provider_calls!.sha256)) throw new Error("Bundle provider_calls does not match a bundled file");
	if (manifest.capability_snapshot_id === null && manifest.files.some((file) => file.path.startsWith("capability/"))) {
		throw new Error("Bundle contains capability files without a capability_snapshot_id");
	}
}

function validateCaseIdentity(value: unknown, manifest: CaseBundleManifest): void {
	const nodeCase = value as Partial<NodeEvaluationCase> | null;
	if (!nodeCase || nodeCase.schemaVersion !== 1 || nodeCase.caseId !== manifest.case_id
		|| nodeCase.runId !== manifest.source_run_id || nodeCase.agentId !== manifest.agent_id
		|| nodeCase.nodeId !== manifest.node_id || nodeCase.attemptId !== manifest.attempt_id) {
		throw new Error("Bundled Node Evaluation Case identity does not match the bundle manifest");
	}
}

function bundleDestination(root: string, caseId: string, path: string): string {
	if (path.startsWith("case/")) return resolveInside(join(root, "node-evaluation", "cases", caseId), path.slice(5));
	if (path.startsWith("capability/")) return resolveInside(join(root, "capability"), path.slice(11));
	return resolveInside(root, path);
}

function registerCapabilitySnapshot(
	root: string,
	manifest: CaseBundleManifest,
	staging: string,
	contentHash: (directory: string, expectedHash: string) => string,
): void {
	const id = manifest.capability_snapshot_id!;
	if (existsSync(root)) {
		if (contentHash(join(root, "content"), id.slice("caps_".length)) !== id.slice("caps_".length)) throw new Error(`Capability Snapshot '${id}' already exists with different content`);
		return;
	}
	const temporary = `${root}.${randomUUID()}.tmp`;
	mkdirSync(temporary, { recursive: true });
	cpSync(join(staging, "capability"), join(temporary, "content"), { recursive: true });
	writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify({
		schemaVersion: 1,
		id,
		goalId: manifest.goal_id,
		workspaceContentHash: id.slice("caps_".length),
		createdAt: new Date().toISOString(),
		ref: `evaluation/capability-snapshots/${id}/content`,
	}, null, 2)}\n`, { mode: 0o600 });
	mkdirSync(dirname(root), { recursive: true });
	renameSync(temporary, root);
}

function materializeImportedCase(root: string, manifest: CaseBundleManifest, staging: string): void {
	if (existsSync(root)) {
		verifyMaterializedFiles(root, manifest);
		return;
	}
	const temporary = `${root}.${randomUUID()}.tmp`;
	mkdirSync(dirname(root), { recursive: true });
	renameSync(staging, temporary);
	rmSync(join(temporary, "capability"), { recursive: true, force: true });
	renameSync(temporary, root);
}

function verifyMaterializedFiles(root: string, manifest: CaseBundleManifest): void {
	for (const file of manifest.files.filter((item) => !item.path.startsWith("capability/"))) {
		const path = bundleDestination(root, manifest.case_id, file.path);
		const content = readFileSync(safeRegularFile(path, `Imported bundle file '${file.path}'`));
		if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) throw new Error(`Imported bundle file '${file.path}' changed`);
	}
}

function safeBundlePath(path: unknown): path is string {
	return typeof path === "string" && path.length > 0 && !isAbsolute(path) && !path.includes("\0")
		&& path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}


function resolveInside(root: string, path: string): string {
	const target = resolve(root, path);
	const rel = relative(root, target);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Bundle path escapes its root: ${path}`);
	return target;
}

function runtimeTempDirectory(dataDir: string): string {
	const root = join(runtimeControlRoot(resolve(dataDir)), "evaluation-bundles");
	mkdirSync(root, { recursive: true });
	return root;
}

function safeRegularFile(path: string, label: string): string {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be one regular file`);
	return realpathSync(path);
}

function parseTarHeader(block: Buffer): TarEntryHeader {
	const sizeField = block.subarray(124, 136);
	if (sizeField[0]! & 0x80) throw new Error("Tar entry uses base-256 size: files over 8 GiB are not supported");
	const name = tarField(block, 0, 100);
	const prefix = tarField(block, 345, 155);
	const expected = Number.parseInt(tarField(block, 148, 8).trim() || "0", 8);
	let sum = 0;
	for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
	if (sum !== expected) throw new Error(`Tar header checksum mismatch at '${name}'`);
	const size = Number.parseInt(tarField(block, 124, 12).trim() || "0", 8);
	if (!Number.isSafeInteger(size) || size > MAX_ENTRY_BYTES) throw new Error(`Tar entry '${name}' is over 8 GiB and cannot be imported`);
	return { name: prefix ? `${prefix}/${name}` : name, size, type: String.fromCharCode(block[156]!) };
}

function tarField(block: Buffer, start: number, length: number): string {
	const slice = block.subarray(start, start + length);
	const end = slice.indexOf(0);
	return slice.subarray(0, end === -1 ? length : end).toString("utf-8");
}

function writeTarEntry(fd: number, name: string, size: number, chunks: Iterable<Buffer>): void {
	if (size > MAX_ENTRY_BYTES) throw new Error(`Tar entry '${name}' is over 8 GiB and cannot be exported`);
	if (Buffer.byteLength(name) > 100) throw new Error(`Tar entry name '${name}' exceeds 100 bytes`);
	const header = Buffer.alloc(BLOCK);
	header.write(name, 0, "utf-8");
	header.write("0000644\0", 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write("0", 156);
	header.write("ustar\0", 257);
	header.write("00", 263);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	writeSync(fd, header);
	let written = 0;
	for (const chunk of chunks) {
		written += chunk.byteLength;
		writeSync(fd, chunk);
	}
	if (written !== size) throw new Error(`Tar entry '${name}' wrote ${written} bytes, expected ${size}`);
	const padding = (BLOCK - (size % BLOCK)) % BLOCK;
	if (padding) writeSync(fd, Buffer.alloc(padding));
}

function* fileChunks(path: string): Generator<Buffer> {
	const fd = openSync(path, "r");
	try {
		for (let position = 0;;) {
			const chunk = Buffer.alloc(CHUNK);
			const bytes = readSync(fd, chunk, 0, CHUNK, position);
			if (bytes === 0) return;
			position += bytes;
			yield chunk.subarray(0, bytes);
		}
	} finally {
		closeSync(fd);
	}
}

function fileSha256(path: string): string {
	const hash = createSha256();
	for (const chunk of fileChunks(path)) hash.update(chunk);
	return hash.digest("hex");
}
