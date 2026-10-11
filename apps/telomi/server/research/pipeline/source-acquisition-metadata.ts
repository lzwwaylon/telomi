import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../lib/values.js";

// Unknown metadata stays in the control record; only evidence fields become citable Source material.
const EVIDENCE_FIELDS = new Set([
	"created_at", "updated_at", "published_at", "released_at", "submitted_at", "last_modified", "pushed_at",
	"retrieved_at", "fetched_at", "crawled_at", "first_seen_at",
	"repo_id", "paper_id", "model_id", "dataset_id", "arxiv_version_id", "resource_type",
	"revision", "sha", "commit_sha", "version", "tag_name", "doi", "license", "language",
	"author", "authors", "tags", "topics", "categories", "primary_category", "pipeline_tag", "library_name",
	"document_url", "pdf_url", "discovery_queries",
]);

/** Freeze the retained acquisition context before Source indexing and revision hashing. */
export function writeSourceAcquisitionMetadata(directory: string, candidate: {
	provider_id: string; url: string; query: string; metadata: Record<string, unknown>;
}): void {
	const metadata = Object.fromEntries(Object.entries(candidate.metadata)
		.filter(([key, value]) => EVIDENCE_FIELDS.has(key) && isEvidenceValue(value)
			&& (!key.endsWith("_url") || isEvidenceUrl(value))));
	const lanes = candidate.metadata.discovery_lanes;
	if (Array.isArray(lanes) && lanes.every(lane => isRecord(lane)
		&& Object.keys(lane).length === 3
		&& typeof lane.pipeline_tag === "string" && isEvidenceValue(lane.pipeline_tag)
		&& typeof lane.lane === "string" && isEvidenceValue(lane.lane)
		&& typeof lane.rank === "number" && Number.isSafeInteger(lane.rank) && lane.rank > 0)) {
		metadata.discovery_lanes = lanes;
	}
	const date = candidate.metadata.candidate_date_evidence;
	if (isRecord(date) && Object.keys(date).length === 4 && date.kind === "associated_paper_month"
		&& typeof date.month === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(date.month)
		&& typeof date.arxiv_tag === "string" && /^arxiv:\d{4}\.\d{4,5}$/iu.test(date.arxiv_tag)
		&& date.model_release_verified === false) {
		metadata.candidate_date_evidence = date;
	}
	writeFileSync(join(directory, "acquisition-metadata.json"), `${JSON.stringify({
		schema_version: 1,
		provenance: "provider_child_candidate_ledger",
		provider_id: candidate.provider_id,
		canonical_locator: candidate.url,
		interpretation: "Selected metadata and acquisition context retained from the Provider child's selection record, not an independent Provider assertion. Field names and values retain their original meaning; creation, update and retrieval timestamps do not by themselves establish a first public release date.",
		acquisition_context: { query: candidate.query },
		metadata,
	}, null, 2)}\n`, { flag: "wx" });
}

function isEvidenceValue(value: unknown): boolean {
	if (typeof value === "string") return !value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(value);
	if (typeof value === "number") return Number.isFinite(value);
	return Array.isArray(value) && value.every(item => typeof item === "string" && isEvidenceValue(item));
}

function isEvidenceUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
			&& ![...url.searchParams.keys()].some(key => /token|secret|password|signature|(?:^|[_-])key(?:$|[_-])/iu.test(key));
	} catch {
		return false;
	}
}
