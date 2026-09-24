import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sha256 } from "../../lib/hash.js";
import type { FindOutSourceMember, FindOutSourceOrganization } from "./find-out-sources.js";
import { isRecord } from "../../lib/values.js";
import { writeFileAtomic } from "../../lib/fs.js";

export interface PrimeSourceOrganizerItem {
	candidateId: string;
	sourceId: string;
	providerId: string;
	title: string;
	url: string;
	summary: string;
	revisionSha256: string;
	snapshotPath: string;
}

export interface PrimeSourceOrganizerIndex {
	schema_version: 2;
	sources: Record<string, {
		candidate_id: string;
		provider_id: string;
		title: string;
		url: string;
		summary: string;
		revision_sha256: string;
		snapshot_path: string;
		group_id: string | null;
	}>;
	groups: Record<string, { title: string; identity: string }>;
}

export interface PrimeSourceOrganizerDecision {
	groups: Array<{
		group_ref?: string;
		title?: string;
		identity?: string;
		members: string[];
	}>;
	ungrouped: string[];
}

export function emptyPrimeSourceOrganizerIndex(): PrimeSourceOrganizerIndex {
	return { schema_version: 2, sources: {}, groups: {} };
}

export function loadPrimeSourceOrganizerIndex(path: string): PrimeSourceOrganizerIndex {
	if (!existsSync(path)) return emptyPrimeSourceOrganizerIndex();
	return validatePrimeSourceOrganizerIndex(JSON.parse(readFileSync(path, "utf-8")) as unknown);
}

export function preparePrimeSourceOrganizerIndex(
	previous: PrimeSourceOrganizerIndex,
	items: readonly PrimeSourceOrganizerItem[],
): { index: PrimeSourceOrganizerIndex; newSourceIds: string[]; changedSourceIds: string[] } {
	const index = validatePrimeSourceOrganizerIndex(previous);
	const sources = { ...index.sources };
	const newSourceIds: string[] = [];
	const changedSourceIds: string[] = [];
	const currentIds = new Set<string>();
	for (const item of items) {
		if (currentIds.has(item.sourceId)) throw new Error(`Organizer input contains duplicate source_id '${item.sourceId}'`);
		currentIds.add(item.sourceId);
		const existing = sources[item.sourceId];
		if (!existing) newSourceIds.push(item.sourceId);
		else if (existing.revision_sha256 !== item.revisionSha256) changedSourceIds.push(item.sourceId);
		sources[item.sourceId] = {
			candidate_id: item.candidateId,
			provider_id: item.providerId,
			title: item.title,
			url: item.url,
			summary: item.summary,
			revision_sha256: item.revisionSha256,
			snapshot_path: item.snapshotPath,
			group_id: existing?.group_id ?? null,
		};
	}
	return {
		index: { schema_version: 2, sources, groups: { ...index.groups } },
		newSourceIds,
		changedSourceIds,
	};
}

export function projectPrimeSourceOrganizerInput(
	index: PrimeSourceOrganizerIndex,
	newSourceIds: readonly string[],
): unknown {
	const validated = validatePrimeSourceOrganizerIndex(index);
	const sourceRefs = sourceReferenceMap(validated);
	const groupRefs = groupReferenceMap(validated);
	const fresh = new Set(newSourceIds);
	return {
		new_sources: [...sourceRefs]
			.filter(([sourceId]) => fresh.has(sourceId))
			.map(([sourceId, sourceRef]) => ({
			source_ref: sourceRef,
			provider: validated.sources[sourceId]!.provider_id,
			title: validated.sources[sourceId]!.title,
			url: validated.sources[sourceId]!.url,
			summary: validated.sources[sourceId]!.summary,
		})),
		ungrouped_sources: [...sourceRefs]
			.filter(([sourceId]) => !fresh.has(sourceId) && validated.sources[sourceId]!.group_id === null)
			.map(([sourceId, sourceRef]) => ({
				source_ref: sourceRef,
				provider: validated.sources[sourceId]!.provider_id,
				title: validated.sources[sourceId]!.title,
				url: validated.sources[sourceId]!.url,
				summary: validated.sources[sourceId]!.summary,
			})),
		cached_groups: [...groupRefs].map(([groupId, groupRef]) => ({
			group_ref: groupRef,
			title: validated.groups[groupId]!.title,
			identity: validated.groups[groupId]!.identity,
			members: [...sourceRefs]
				.filter(([sourceId]) => validated.sources[sourceId]!.group_id === groupId)
				.map(([sourceId]) => ({
					provider: validated.sources[sourceId]!.provider_id,
					title: validated.sources[sourceId]!.title,
					url: validated.sources[sourceId]!.url,
					summary: validated.sources[sourceId]!.summary,
				})),
		})),
	};
}

export function materializePrimeSourceOrganizerDecision(
	previous: PrimeSourceOrganizerIndex,
	value: unknown,
	newSourceIds: readonly string[],
): PrimeSourceOrganizerIndex {
	const validated = validatePrimeSourceOrganizerIndex(previous);
	if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["groups", "ungrouped"])) {
		throw new Error("Organizer decision must contain only groups and ungrouped");
	}
	if (!Array.isArray(value.groups) || !Array.isArray(value.ungrouped)) {
		throw new Error("Organizer decision groups and ungrouped must be arrays");
	}
	const sourceRefs = sourceReferenceMap(validated);
	const sourceByRef = new Map([...sourceRefs].map(([id, ref]) => [ref, id]));
	const groupRefs = groupReferenceMap(validated);
	const groupByRef = new Map([...groupRefs].map(([id, ref]) => [ref, id]));
	const fresh = new Set(newSourceIds);
	for (const sourceId of fresh) {
		if (!validated.sources[sourceId]) throw new Error(`Organizer new Source '${sourceId}' is unknown`);
	}
	const covered = new Set<string>();
	const groups: PrimeSourceOrganizerIndex["groups"] = { ...validated.groups };
	const groupForSource = new Map(Object.entries(validated.sources).map(([id, source]) => [id, source.group_id]));
	for (const [index, raw] of value.groups.entries()) {
		if (!isRecord(raw)) throw new Error(`Organizer group ${index + 1} must be an object`);
		const keys = Object.keys(raw).sort();
		if (JSON.stringify(keys) !== JSON.stringify(raw.group_ref === undefined
			? ["identity", "members", "title"]
			: ["group_ref", "members"])) {
			throw new Error(`Organizer group ${index + 1} has unexpected fields`);
		}
		if (!Array.isArray(raw.members) || raw.members.length < 1) throw new Error(`Organizer group ${index + 1} requires Source refs`);
		const memberIds = raw.members.map((member, memberIndex) => {
			const ref = requiredString(member, `Organizer group ${index + 1} member ${memberIndex + 1}`);
			const sourceId = sourceByRef.get(ref);
			if (!sourceId) throw new Error(`Organizer group ${index + 1} references unknown Source '${ref}'`);
			if (!fresh.has(sourceId) && validated.sources[sourceId]!.group_id !== null) {
				throw new Error(`Organizer group ${index + 1} cannot move a cached Group member '${ref}'`);
			}
			if (covered.has(sourceId)) throw new Error(`Organizer Source '${ref}' is assigned more than once`);
			covered.add(sourceId);
			return sourceId;
		});
		const groupId = raw.group_ref === undefined
			? runtimeGroupId(
				requiredString(raw.title, `Organizer group ${index + 1} title`),
				requiredString(raw.identity, `Organizer group ${index + 1} identity`),
			)
			: groupByRef.get(requiredString(raw.group_ref, `Organizer group ${index + 1} group_ref`));
		if (!groupId) throw new Error(`Organizer group ${index + 1} references an unknown cached Group`);
		const existingGroup = groups[groupId];
		if (raw.group_ref === undefined) {
			if (existingGroup) throw new Error(`Organizer Group '${groupId}' already exists`);
			groups[groupId] = {
				title: requiredString(raw.title, `Organizer group ${index + 1} title`),
				identity: requiredString(raw.identity, `Organizer group ${index + 1} identity`),
			};
		}
		for (const sourceId of memberIds) groupForSource.set(sourceId, groupId);
		const allMemberIds = [...groupForSource].filter(([, assigned]) => assigned === groupId).map(([id]) => id);
		// Whether members are the same canonical object is the Organizer's semantic call; Runtime only checks structure.
		if (allMemberIds.length < 2) throw new Error(`Organizer group ${index + 1} needs at least two members`);
	}
	for (const [index, raw] of value.ungrouped.entries()) {
		const ref = requiredString(raw, `Organizer ungrouped ${index + 1}`);
		const sourceId = sourceByRef.get(ref);
		if (!sourceId) throw new Error(`Organizer ungrouped references unknown Source '${ref}'`);
		if (covered.has(sourceId)) throw new Error(`Organizer Source '${ref}' is assigned more than once`);
		if (!fresh.has(sourceId)) throw new Error(`Organizer ungrouped may contain only newly observed Sources`);
		covered.add(sourceId);
	}
	if ([...fresh].some((sourceId) => !covered.has(sourceId))) {
		throw new Error("Organizer decision must assign every newly observed Source exactly once");
	}
	return validatePrimeSourceOrganizerIndex({
		schema_version: 2,
		sources: Object.fromEntries(Object.entries(validated.sources).map(([id, source]) => [
			id,
			{ ...source, group_id: groupForSource.get(id) ?? null },
		])),
		groups,
	}, validated.sources);
}

export function validatePrimeSourceOrganizerIndex(
	value: unknown,
	expectedSources?: PrimeSourceOrganizerIndex["sources"],
): PrimeSourceOrganizerIndex {
	if (!isRecord(value) || value.schema_version !== 2 || !isRecord(value.sources) || !isRecord(value.groups)) {
		throw new Error("Prime Source Organizer Index has an invalid shape");
	}
	const sources: PrimeSourceOrganizerIndex["sources"] = {};
	for (const [sourceId, raw] of Object.entries(value.sources)) {
		if (!sourceId.startsWith("source:") || !isRecord(raw)) {
			throw new Error(`Organizer source '${sourceId}' has an invalid shape`);
		}
		const groupId = raw.group_id;
		if (groupId !== null && typeof groupId !== "string") {
			throw new Error(`Organizer source '${sourceId}' group_id must be a string or null`);
		}
		const url = requiredString(raw.url, `Organizer source '${sourceId}' url`);
		if (!/^https?:\/\//iu.test(url)) throw new Error(`Organizer source '${sourceId}' url must be HTTP(S)`);
		sources[sourceId] = {
			candidate_id: requiredString(raw.candidate_id, `Organizer source '${sourceId}' candidate_id`),
			provider_id: requiredString(raw.provider_id, `Organizer source '${sourceId}' provider_id`),
			title: requiredString(raw.title, `Organizer source '${sourceId}' title`),
			url,
			summary: requiredString(raw.summary, `Organizer source '${sourceId}' summary`),
			revision_sha256: requiredSha256(raw.revision_sha256, `Organizer source '${sourceId}' revision_sha256`),
			snapshot_path: safeRelativePath(raw.snapshot_path, `Organizer source '${sourceId}' snapshot_path`),
			group_id: groupId,
		};
	}
	if (expectedSources) {
		if (!sameStringSet(Object.keys(sources), Object.keys(expectedSources))) {
			throw new Error("Organizer Index must preserve the complete Source set");
		}
		for (const [sourceId, expected] of Object.entries(expectedSources)) {
			const actual = sources[sourceId]!;
			for (const field of ["candidate_id", "provider_id", "title", "url", "summary", "revision_sha256", "snapshot_path"] as const) {
				if (actual[field] !== expected[field]) {
					throw new Error(`Organizer must not modify source '${sourceId}' field '${field}'`);
				}
			}
		}
	}
	const groups: PrimeSourceOrganizerIndex["groups"] = {};
	for (const [groupId, raw] of Object.entries(value.groups)) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(groupId) || groupId.length > 80) {
			throw new Error(`Organizer group_id '${groupId}' must be semantic kebab-case`);
		}
		if (!isRecord(raw)) throw new Error(`Organizer group '${groupId}' has an invalid shape`);
		groups[groupId] = {
			title: requiredString(raw.title, `Organizer group '${groupId}' title`),
			identity: requiredString(raw.identity, `Organizer group '${groupId}' identity`),
		};
	}
	const membersByGroup = new Map<string, Array<PrimeSourceOrganizerIndex["sources"][string]>>();
	for (const [sourceId, source] of Object.entries(sources)) {
		if (source.group_id === null) continue;
		if (!groups[source.group_id]) throw new Error(`Organizer source '${sourceId}' references unknown group '${source.group_id}'`);
		const members = membersByGroup.get(source.group_id) ?? [];
		members.push(source);
		membersByGroup.set(source.group_id, members);
	}
	for (const groupId of Object.keys(groups)) {
		const members = membersByGroup.get(groupId) ?? [];
		if (members.length < 2) throw new Error(`Organizer group '${groupId}' must contain at least two Sources`);
	}
	if (new Set(Object.values(sources).map((source) => source.candidate_id)).size !== Object.keys(sources).length) {
		throw new Error("Organizer candidate_id values must be unique");
	}
	return { schema_version: 2, sources, groups };
}

export function projectPrimeSourceOrganization(
	index: PrimeSourceOrganizerIndex,
	items: readonly PrimeSourceOrganizerItem[],
): FindOutSourceOrganization {
	const validated = validatePrimeSourceOrganizerIndex(index);
	const touchedGroups = new Set<string>();
	const ungrouped: FindOutSourceOrganization["ungrouped"] = [];
	const candidateIds = new Set<string>();
	for (const item of items) {
		if (candidateIds.has(item.candidateId)) throw new Error(`Organizer projection contains duplicate candidate '${item.candidateId}'`);
		candidateIds.add(item.candidateId);
		const source = validated.sources[item.sourceId];
		if (!source) throw new Error(`Organizer Index is missing current source '${item.sourceId}'`);
		if (source.group_id === null) {
			ungrouped.push({ candidate_id: item.candidateId, reason: "No cached cross-Provider identity match." });
			continue;
		}
		touchedGroups.add(source.group_id);
	}
	const groups: FindOutSourceOrganization["groups"] = [];
	for (const groupId of [...touchedGroups].sort()) {
		const group = validated.groups[groupId]!;
		groups.push({
			id: groupId,
			title: group.title,
			members: Object.values(validated.sources)
				.filter((source) => source.group_id === groupId)
				.map((source) => source.candidate_id)
				.sort(),
			evidence: group.identity,
		});
	}
	ungrouped.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
	return { groups, ungrouped };
}

export function projectPrimeSourceOrganizerMembers(
	index: PrimeSourceOrganizerIndex,
	items: readonly PrimeSourceOrganizerItem[],
	organizerRoot: string,
	newSourceIds: readonly string[],
	changedSourceIds: readonly string[],
): Array<FindOutSourceMember & { changeKind: "new" | "changed" | "unchanged" }> {
	const validated = validatePrimeSourceOrganizerIndex(index);
	const current = new Set(items.map((item) => item.sourceId));
	const fresh = new Set(newSourceIds);
	const changed = new Set(changedSourceIds);
	const touchedGroups = new Set(items.flatMap((item) => {
		const groupId = validated.sources[item.sourceId]?.group_id;
		return groupId ? [groupId] : [];
	}));
	return Object.entries(validated.sources)
		.filter(([sourceId, source]) => current.has(sourceId) || (source.group_id !== null && touchedGroups.has(source.group_id)))
		.map(([sourceId, source]) => ({
			candidateId: source.candidate_id,
			sourceId,
			providerId: source.provider_id,
			title: source.title,
			url: source.url,
			summary: source.summary,
			sourceDirectory: resolveSnapshotPath(organizerRoot, source.snapshot_path),
			changeKind: fresh.has(sourceId) ? "new" as const : changed.has(sourceId) ? "changed" as const : "unchanged" as const,
		}))
		.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

export function writePrimeSourceOrganizerIndex(path: string, index: PrimeSourceOrganizerIndex): void {
	const validated = validatePrimeSourceOrganizerIndex(index);
	writeFileAtomic(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function requiredSha256(value: unknown, label: string): string {
	const result = requiredString(value, label);
	if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${label} must be SHA-256`);
	return result;
}

function safeRelativePath(value: unknown, label: string): string {
	const path = requiredString(value, label).replaceAll("\\", "/");
	if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`${label} must stay under the Organizer root`);
	return path;
}

function resolveSnapshotPath(root: string, relativePath: string): string {
	const base = resolve(root);
	const path = resolve(base, relativePath);
	if (path !== base && !path.startsWith(`${base}/`)) throw new Error("Organizer Source snapshot escapes its root");
	return path;
}

function sourceReferenceMap(index: PrimeSourceOrganizerIndex): Map<string, string> {
	return new Map(Object.keys(index.sources).sort().map((id, index) => [id, `S${String(index + 1).padStart(3, "0")}`]));
}

function groupReferenceMap(index: PrimeSourceOrganizerIndex): Map<string, string> {
	return new Map(Object.keys(index.groups).sort().map((id, index) => [id, `G${String(index + 1).padStart(3, "0")}`]));
}

function runtimeGroupId(title: string, identity: string): string {
	const slug = title.toLocaleLowerCase("en-US")
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 55) || "group";
	return `${slug}-${sha256(identity).slice(0, 12)}`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value) => right.includes(value));
}
