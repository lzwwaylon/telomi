import { join, resolve } from "node:path";

import { isInsideRoot } from "../../lib/paths.js";
import { findLogicalSourceInRun, findLogicalSourceMember, type ResolvedLogicalSource } from "../../workspaces/source-view.js";
import type { DiscoveryCandidate, DiscoveryInboxItem } from "./contracts.js";

/** Resolve immutable evidence provenance once per Run/Source in one API request. */
export function createDiscoveryProjection(goalDirectory: string): (candidate: DiscoveryCandidate) => DiscoveryInboxItem {
	const runsRoot = join(goalDirectory, "wiki", "runs");
	const sources = new Map<string, ResolvedLogicalSource | null>();
	return (candidate) => {
		const sourceKey = `${candidate.run_id}\0${candidate.source_id}`;
		let resolved = sources.get(sourceKey);
		if (resolved === undefined) {
			try {
				const runRoot = resolve(runsRoot, candidate.run_id);
				resolved = isInsideRoot(runsRoot, runRoot) ? findLogicalSourceInRun(runRoot, candidate.source_id) : null;
			} catch {
				// Historical material may be unavailable without hiding the Discovery itself.
				resolved = null;
			}
			sources.set(sourceKey, resolved);
		}
		const members = new Map<string, DiscoveryInboxItem["sources"][number]>();
		for (const evidence of candidate.evidence) {
			const member = resolved ? findLogicalSourceMember(resolved.source, evidence.source_path) : null;
			const id = text(member?.source_id);
			if (!id || members.has(id)) continue;
			const locator = text(member?.canonical_locator);
			const title = text(member?.title) ?? text(resolved?.source.title) ?? locator ?? id;
			const url = webUrl(locator);
			members.set(id, { id, title, ...(url ? { url } : {}) });
		}
		return { ...candidate, sources: [...members.values()] };
	};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function webUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}
