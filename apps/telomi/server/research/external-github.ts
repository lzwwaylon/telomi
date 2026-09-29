import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { sha256 } from "../lib/hash.js";
import { assertInsideRoot, assertSafeRelativePath } from "../lib/paths.js";
import { materializeFindOutSources, loadFindOutSources, type FindOutSourceMember } from "./pipeline/find-out-sources.js";
import { createResearchSourceRegistry } from "./sources/builtin-registry.js";
import { executeDeepSearch } from "./deep-search.js";

/** Acquire versioned official repository files through the GitHub Provider, then ask Cornell to verify them. */
export async function readExternalGithub(input: {
	goalDir: string; goalId: string; runDir: string; investigationId: string; sequence: number;
	question: string; repository: string; ref: string; paths: string[];
	signal: AbortSignal; env: NodeJS.ProcessEnv;
}) {
	if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(input.repository)) throw new Error("GitHub repository is invalid");
	if (!input.ref || input.ref.length > 100 || /\s/u.test(input.ref)) throw new Error("GitHub ref is invalid");
	if (input.paths.length < 1 || input.paths.length > 5 || new Set(input.paths).size !== input.paths.length) {
		throw new Error("GitHub reading requires 1 to 5 distinct paths");
	}
	for (const path of input.paths) assertSafeRelativePath(path, "GitHub file path");
	input.signal.throwIfAborted();
	const alreadySaved = savedGithubPaths(input.goalDir, input.repository, input.paths);
	if (alreadySaved.length === input.paths.length) {
		throw new Error(`All requested GitHub files are already saved in this Goal: ${alreadySaved.join(", ")}. Acquire the missing dependency instead.`);
	}
	const sourceRunId = `external-${input.investigationId}-${input.sequence}`;
	const sourceRunRoot = join(input.goalDir, "wiki", "runs", sourceRunId);
	const stagedRunRoot = join(input.runDir, `external-source-${input.sequence}`);
	const request = { repository: input.repository, ref: input.ref, paths: input.paths };
	if (!existsSync(sourceRunRoot)) {
		rmSync(stagedRunRoot, { recursive: true, force: true });
		mkdirSync(stagedRunRoot, { recursive: true });
		const providerWorkspace = join(input.runDir, `github-provider-${input.sequence}`);
		mkdirSync(providerWorkspace, { recursive: true });
		const registry = createResearchSourceRegistry(input.env);
		const members: FindOutSourceMember[] = [];
		for (const [index, path] of input.paths.entries()) {
			input.signal.throwIfAborted();
			const rows = await registry.search("github", {
				query: `file:${input.repository}:${path}@${input.ref}`, maxResults: 1,
				criterionIds: [], purpose: `Prime investigation: ${input.question}`,
				workspaceDir: providerWorkspace, signal: input.signal,
				providerRequest: { operation: "download_file", parameters: {
					repository: input.repository, path, ref: input.ref,
				} },
			}, { recorder: { runDir: input.runDir, nodeId: "prime-investigation", attemptId: "attempt-1" } });
			const row = rows[0];
			const artifactPath = row?.metadata?.artifact_path;
			if (!row || rows.length !== 1 || typeof artifactPath !== "string") throw new Error(`GitHub Provider did not download '${path}'`);
			assertSafeRelativePath(artifactPath, "GitHub Provider artifact");
			const file = assertInsideRoot(providerWorkspace, artifactPath, "GitHub Provider artifact", { allowRoot: false });
			const stat = lstatSync(file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000
				|| !realpathSync(file).startsWith(`${realpathSync(providerWorkspace)}${sep}`)) {
				throw new Error("GitHub Provider material is not a bounded regular file");
			}
			const materialRoot = join(input.runDir, `github-material-${input.sequence}-${index + 1}`);
			rmSync(materialRoot, { recursive: true, force: true });
			mkdirSync(dirname(join(materialRoot, path)), { recursive: true });
			copyFileSync(file, join(materialRoot, path));
			const id = sha256(row.url).slice(0, 24);
			members.push({ candidateId: `candidate:${id}`, sourceId: `source:${id}`,
				providerId: "github", title: row.title, url: row.url,
				summary: row.snippet, sourceDirectory: materialRoot });
		}
		materializeFindOutSources({ artifactStore: new RunArtifactStore(stagedRunRoot), sequence: 1,
			workingDirectory: join(input.runDir, `github-build-${input.sequence}`), members,
			organization: { groups: [], ungrouped: members.map((member) => ({
				candidate_id: member.candidateId, reason: "Pinned official repository file",
			})) } });
		writeFileSync(join(stagedRunRoot, "external-request.json"), `${JSON.stringify(request)}\n`);
		mkdirSync(dirname(sourceRunRoot), { recursive: true });
		renameSync(stagedRunRoot, sourceRunRoot);
	}
	if (JSON.stringify(JSON.parse(readFileSync(join(sourceRunRoot, "external-request.json"), "utf-8"))) !== JSON.stringify(request)) {
		throw new Error("External Source run belongs to different GitHub files");
	}
	const sources = loadFindOutSources(new RunArtifactStore(sourceRunRoot).describeDirectory("artifacts/find-out-sources/sequence-1"));
	const reading = await executeDeepSearch({ goalDir: input.goalDir, goalId: input.goalId,
		invocationId: `${input.investigationId}-external-${input.sequence}`,
		question: `${input.question}\n\nCheck the newly pinned ${input.repository}@${input.ref} files first: ${input.paths.join(", ")}. Compare with other saved Sources when needed.`,
		signal: input.signal, env: input.env });
	return { ...reading, provider: "github", repository: input.repository, ref: input.ref,
		sources: sources.map((source) => ({ id: source.id, title: source.title,
			revision_sha256: source.revisionSha256, url: source.url })) };
}

function savedGithubPaths(goalDir: string, repository: string, paths: string[]): string[] {
	const runsRoot = join(goalDir, "wiki", "runs");
	const base = `https://github.com/${repository}`.toLowerCase();
	const found = new Set<string>();
	for (const runId of readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
		const runRoot = join(runsRoot, runId);
		const sequencesRoot = join(runRoot, "artifacts", "find-out-sources");
		if (!existsSync(sequencesRoot)) continue;
		for (const sequence of readdirSync(sequencesRoot).filter((name) => /^sequence-\d+$/u.test(name))) {
			for (const source of loadFindOutSources(new RunArtifactStore(runRoot).describeDirectory(`artifacts/find-out-sources/${sequence}`))) {
				for (const member of source.members) {
					const url = member.canonicalLocator.replace(/\/?(?:\.git)?$/u, "").toLowerCase();
					if (url !== base && !url.startsWith(`${base}/`)) continue;
					for (const path of paths) if (member.path && existsSync(join(source.directoryPath, member.path, path))) found.add(path);
				}
			}
		}
	}
	return paths.filter((path) => found.has(path));
}
