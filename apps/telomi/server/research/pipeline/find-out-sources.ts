import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256, stableJson } from "../../lib/hash.js";
import type { LogicalSource } from "../research-types.js";
import type { PublishedArtifactDirectoryRef, RunArtifactStore } from "../../agent-runtime/artifact-store.js";
import { assertSafeRelativePath } from "../../lib/paths.js";
import { inspectSourceDirectory, snapshotSourceDirectory } from "./source-bundle.js";
import { safeName } from "../../lib/paths.js";

export interface FindOutSourceMember {
	candidateId: string;
	sourceId: string;
	providerId: string;
	title: string;
	url: string;
	summary: string;
	sourceDirectory: string;
	changeKind?: "new" | "changed" | "unchanged";
}

export interface FindOutSourceOrganization {
	groups: Array<{ id: string; title: string; members: string[]; evidence: string }>;
	ungrouped: Array<{ candidate_id: string; reason: string }>;
}

export const FIND_OUT_SOURCE_MANIFEST_SCHEMA_VERSION = 3;

interface FindOutSourceManifest {
	schema_version: typeof FIND_OUT_SOURCE_MANIFEST_SCHEMA_VERSION;
	sequence: number;
	sources: Array<{
		source_id: string;
		title: string;
		path: string;
		organization_kind: "cross_provider" | "ungrouped";
		organization_reason: string;
		group_id?: string;
		update_context?: {
			new_member_paths: string[];
			changed_member_paths: string[];
		};
		members: Array<{
			candidate_id: string;
			source_id: string;
			provider_id: string;
			title: string;
			canonical_locator: string;
			path: string;
			summary: string;
			change_kind?: "new" | "changed" | "unchanged";
		}>;
		revision_sha256: string;
	}>;
}

export function materializeFindOutSources(input: {
	artifactStore: RunArtifactStore;
	sequence: number;
	workingDirectory: string;
	organization: FindOutSourceOrganization;
	members: readonly FindOutSourceMember[];
}): { artifact: PublishedArtifactDirectoryRef; sources: LogicalSource[] } {
	const root = join(input.workingDirectory, "find-out-sources");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	const byCandidate = new Map(input.members.map((member) => [member.candidateId, member]));
	const logical = [
		...input.organization.groups.map((group) => ({
			title: group.title,
			kind: "cross_provider" as const,
			reason: group.evidence,
			groupId: group.id,
			candidateIds: group.members,
		})),
		...input.organization.ungrouped.map((entry) => {
			const member = byCandidate.get(entry.candidate_id);
			if (!member) throw new Error(`Find Out organization references unknown candidate '${entry.candidate_id}'`);
			return {
				title: member.title,
				kind: "ungrouped" as const,
				reason: entry.reason,
				groupId: undefined,
				candidateIds: [entry.candidate_id],
			};
		}),
	];
	const sources: FindOutSourceManifest["sources"] = logical.map((entry) => {
		const members = entry.candidateIds.map((candidateId) => {
			const member = byCandidate.get(candidateId);
			if (!member) throw new Error(`Find Out organization references unknown candidate '${candidateId}'`);
			return member;
		});
		const sourceId = `source:${sha256(entry.groupId
			? `find-out-group\0${entry.groupId}`
			: `find-out-source\0${members[0]!.sourceId}`).slice(0, 24)}`;
		const sourcePath = `sources/${safeName(sourceId, { maxLength: 100, fallback: "source" })}`;
		const projected = members.map((member) => {
			const memberPath = `members/${safeName(member.providerId, { maxLength: 100, fallback: "source" })}/${safeName(member.candidateId, { maxLength: 100, fallback: "source" })}`;
			snapshotSourceDirectory(member.sourceDirectory, join(root, sourcePath, memberPath));
			return {
				candidate_id: member.candidateId,
				source_id: member.sourceId,
				provider_id: member.providerId,
				title: member.title,
				canonical_locator: member.url,
				path: memberPath,
				summary: member.summary,
				...(member.changeKind ? { change_kind: member.changeKind } : {}),
			};
		});
		const newMemberPaths = projected.filter((member) => member.change_kind === "new").map((member) => member.path);
		const changedMemberPaths = projected.filter((member) => member.change_kind === "changed").map((member) => member.path);
		const hasHistoricalMember = projected.some((member) => member.change_kind === "unchanged");
		const updateContext = changedMemberPaths.length > 0 || (hasHistoricalMember && newMemberPaths.length > 0)
			? { new_member_paths: newMemberPaths, changed_member_paths: changedMemberPaths }
			: undefined;
		const revision = sha256(stableJson(projected.map((member) => ({
			source_id: member.source_id,
			path: member.path,
			files: inspectSourceDirectory(join(root, sourcePath, member.path)).map((file) => ({
				path: file.relativePath,
				sha256: file.sha256,
			})),
		}))));
		return {
			source_id: sourceId,
			title: entry.title,
			path: sourcePath,
			organization_kind: entry.kind,
			organization_reason: entry.reason,
			...(entry.groupId ? { group_id: entry.groupId } : {}),
			...(updateContext ? { update_context: updateContext } : {}),
			members: projected,
			revision_sha256: revision,
		};
	});
	if (new Set(sources.flatMap((source) => source.members.map((member) => member.candidate_id))).size !== input.members.length) {
		throw new Error("Find Out organization must cover every acquired Source exactly once");
	}
	writeFileSync(join(root, "manifest.json"), `${JSON.stringify({
		schema_version: FIND_OUT_SOURCE_MANIFEST_SCHEMA_VERSION,
		sequence: input.sequence,
		sources,
	} satisfies FindOutSourceManifest, null, 2)}\n`);
	const relativePath = `artifacts/find-out-sources/sequence-${input.sequence}`;
	const artifact = existsSync(join(input.artifactStore.root, relativePath))
		? input.artifactStore.describeDirectory(relativePath)
		: input.artifactStore.publishDirectory(root, relativePath, root);
	return { artifact, sources: loadFindOutSources(artifact) };
}

export function loadFindOutSources(artifact: PublishedArtifactDirectoryRef): LogicalSource[] {
	const manifest = JSON.parse(readFileSync(join(artifact.absolutePath, "manifest.json"), "utf-8")) as FindOutSourceManifest;
	if (
		manifest.schema_version !== 3
		|| !Number.isInteger(manifest.sequence)
		|| manifest.sequence < 1
		|| !Array.isArray(manifest.sources)
	) {
		throw new Error("Find Out Source manifest is invalid");
	}
	return manifest.sources.map((source, sourceIndex) => {
		if (
			!source
			|| typeof source.source_id !== "string" || !source.source_id.trim()
			|| typeof source.title !== "string" || !source.title.trim()
			|| typeof source.path !== "string" || !source.path.trim()
			|| !/^[a-f0-9]{64}$/u.test(source.revision_sha256)
			|| (source.organization_kind !== "cross_provider" && source.organization_kind !== "ungrouped")
			|| !Array.isArray(source.members)
			|| source.members.length === 0
		) {
			throw new Error(`Find Out Source manifest sources[${sourceIndex}] is invalid`);
		}
		assertSafeRelativePath(source.path, `Find Out Source '${source.source_id}' path`);
		if (source.organization_kind === "cross_provider" && !source.group_id) {
			throw new Error(`Cross-provider Source '${source.source_id}' is missing group_id`);
		}
		const members = source.members.map((member, memberIndex) => {
			if (
				!member
				|| typeof member.source_id !== "string" || !member.source_id.trim()
				|| typeof member.provider_id !== "string" || !member.provider_id.trim()
				|| typeof member.title !== "string" || !member.title.trim()
				|| typeof member.canonical_locator !== "string" || !/^https?:\/\//u.test(member.canonical_locator)
				|| typeof member.path !== "string" || !member.path.trim()
				|| (member.change_kind !== undefined
					&& member.change_kind !== "new" && member.change_kind !== "changed" && member.change_kind !== "unchanged")
			) {
				throw new Error(`Find Out Source '${source.source_id}' members[${memberIndex}] is invalid`);
			}
			assertSafeRelativePath(member.path, `Find Out Source '${source.source_id}' member path`);
			return {
				sourceId: member.source_id,
				providerId: member.provider_id,
				title: member.title,
				canonicalLocator: member.canonical_locator,
				path: member.path,
			};
		});
		const primary = source.members[0]!;
		const updateContext = source.update_context;
		if (updateContext && (!Array.isArray(updateContext.new_member_paths)
			|| !Array.isArray(updateContext.changed_member_paths)
			|| [...updateContext.new_member_paths, ...updateContext.changed_member_paths]
				.some((path) => typeof path !== "string" || !source.members.some((member) => member.path === path)))) {
			throw new Error(`Find Out Source '${source.source_id}' has invalid update_context`);
		}
		return {
			id: source.source_id,
			title: source.title,
			url: primary.canonical_locator,
			providerId: source.organization_kind === "cross_provider"
				? "cross_provider"
				: primary.provider_id,
			sourceIdentity: source.source_id,
			revisionSha256: source.revision_sha256,
			directoryPath: join(artifact.absolutePath, source.path),
			organizationKind: source.organization_kind,
			...(source.group_id ? { groupId: source.group_id } : {}),
			...(updateContext ? { updateContext: {
				newMemberPaths: [...updateContext.new_member_paths],
				changedMemberPaths: [...updateContext.changed_member_paths],
			} } : {}),
			members,
		};
	});
}

