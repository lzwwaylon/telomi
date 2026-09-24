import { createSha256 } from "../../lib/hash.js";

import type { LogicalSource } from "../research-types.js";
import type { ScheduledResearchSource } from "../scheduled-research-context.js";
import { comparePaths } from "../../lib/paths.js";

interface ScheduledResearchSourceVersion extends ScheduledResearchSource {
	contentSha256: string;
}

export function canonicalResearchLocator(value: string): string {
	try {
		const url = new URL(value);
		url.hash = "";
		url.hostname = url.hostname.toLocaleLowerCase();
		if (/(?:^|\.)arxiv\.org$/iu.test(url.hostname)) {
			const match = url.pathname.match(/^\/(?:abs|html|pdf)\/([^/?#]+?)(?:\.pdf)?$/iu);
			if (match) return `https://arxiv.org/abs/${match[1]}`;
		}
		for (const key of [...url.searchParams.keys()]) {
			if (/^(?:utm_.+|ref|source)$/iu.test(key)) url.searchParams.delete(key);
		}
		return url.href;
	} catch {
		return value.trim();
	}
}

export function scheduledSourceIdentity(url: string): string {
	return canonicalResearchLocator(url);
}

export function scheduledSourceContentSha256(
	files: readonly { path: string; sha256: string }[],
): string {
	const hash = createSha256();
	for (const file of [...files].sort((left, right) => comparePaths(left.path, right.path))) {
		hash.update(file.path);
		hash.update("\0");
		hash.update(file.sha256);
		hash.update("\n");
	}
	return hash.digest("hex");
}

export function scheduledSource(document: LogicalSource): ScheduledResearchSourceVersion {
	if (!document.sourceIdentity.trim()) {
		throw new Error(`Search source '${document.id}' has no valid scheduled source identity`);
	}
	if (!/^[a-f0-9]{64}$/u.test(document.revisionSha256)) {
		throw new Error(`Search source '${document.id}' has no valid scheduled source content fingerprint`);
	}
	return { sourceIdentity: document.sourceIdentity, contentSha256: document.revisionSha256 };
}

export function filterProcessedSources(
	documents: readonly LogicalSource[],
	processed: readonly ScheduledResearchSource[],
): LogicalSource[] {
	const known = new Set(processed.map((item) => `${item.sourceIdentity}\0${item.contentSha256}`));
	return documents.filter((document) => {
		const source = scheduledSource(document);
		const version = `${source.sourceIdentity}\0${source.contentSha256}`;
		if (known.has(version)) return false;
		known.add(version);
		return true;
	});
}
