import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { derivePrimeSearchSourceId } from "../../server/providers/search-contracts.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import {
	materializeFindOutReportView,
	materializeReportKnowledgeView,
} from "../../server/research/pipeline/report-knowledge-view.js";
import { Run } from "../../server/research/pipeline/orchestrator.js";
import { writeSourceBundleIndex } from "../../server/research/pipeline/source-bundle.js";
import type { CornellNotesSnapshot } from "../../server/cornell/contracts.js";
import type { PublishedArtifactDirectoryRef } from "../../server/agent-runtime/artifact-store.js";

const root = mkdtempSync(join(tmpdir(), "telomi-report-knowledge-"));
try {
	const sourceRoot = join(root, "source-run");
	const targetRoot = join(root, "report-run");
	const wikiRoot = join(sourceRoot, "wiki");
	const bundleRef = "artifacts/source-bundles/job-1/attempt-1";
	const bundleRoot = join(sourceRoot, bundleRef);
	const sourceDirectory = join(bundleRoot, "sources/0001");
	mkdirSync(wikiRoot, { recursive: true });
	mkdirSync(sourceDirectory, { recursive: true });
	const url = "https://example.test/source";
	const sourceId = derivePrimeSearchSourceId("general_web", url);
	const evidenceId = `evidence:${sourceId.slice(7)}`;
	const document = "# Repository README\n\nGrounded statement.\n";
	writeFileSync(join(sourceDirectory, "README.md"), document);
	writeFileSync(join(bundleRoot, "result.json"), '{"sources":[{"path":"sources/0001"}]}\n');
	writeSourceBundleIndex(bundleRoot, "general_web", [{
		path: "sources/0001", candidate_id: "candidate_0123456789abcdef0123", url, title: "Source title",
	}]);
	writeFileSync(join(wikiRoot, "index.md"), `# Wiki\n\n\`${evidenceId}\`; \`${sourceId}\`; raw \`${bundleRef}/sources/0001\`\n`);

	const sourceStore = new RunArtifactStore(sourceRoot);
	const source = sourceStore.describeFile(`${bundleRef}/sources/0001/README.md`);
	const note = { schema_version: 1 as const, source_id: sourceId, sections: [{
		section_title: "Claim", summary: "Grounded statement.", cue_notes: [{
			cue: "Claim + grounding", note: "Grounded statement.", evidence: [{
				source_path: "README.md", start_line: 1, end_line: 3, content_sha256: source.sha256,
			}],
		}],
	}] };
	const evidence: CornellNotesSnapshot = {
		schema_version: 1, snapshot_id: "snapshot:one", run_id: "run:test",
		pipeline: { id: "pipeline", version: "1", sha256: "a".repeat(64) },
		source_bundle_refs: [bundleRef],
		notes: [{ note, title: "Source title", canonical_locator: url, provider_id: "general_web",
			provenance_ref: sourceId, source_revision_sha256: source.sha256, members: [] }],
	};
	const cornellNotesArtifact = sourceStore.publishText(`${JSON.stringify(evidence, null, 2)}\n`,
		"artifacts/cornell-notes/snapshot.json");
	const findOut = materializeFindOutReportView({
		targetStore: new RunArtifactStore(join(root, "findout-compact")), evidence, cornellNotesArtifact,
		targetRelativePath: "snapshot",
	});
	assert.equal(existsSync(join(findOut.absolutePath, "notes/0001-1.md")), false);
	assert.equal(JSON.parse(readFileSync(join(findOut.absolutePath, "index.json"), "utf-8"))
		.notes[0].path, undefined);
	const view = materializeReportKnowledgeView({
		targetStore: new RunArtifactStore(targetRoot), sourceStore,
		wiki: sourceStore.describeDirectory("wiki"), evidence, cornellNotesArtifact,
		targetRelativePath: "artifacts/report-flow/knowledge-snapshot",
	});

	const projectedWiki = readFileSync(join(view.absolutePath, "wiki/index.md"), "utf-8");
	assert.match(projectedWiki, new RegExp(`\\[${evidenceId}\\]\\(\\.\\./evidence/${evidenceId.slice(9)}/note\\.md\\)`));
	assert.match(projectedWiki, new RegExp(`\\[${sourceId}\\]\\(\\.\\./sources/${sourceId.slice(7)}/README\\.md\\)`));
	assert.match(projectedWiki, new RegExp(`\\[raw source\\]\\(\\.\\./sources/${sourceId.slice(7)}/README\\.md\\)`));
	const projectedNote = readFileSync(join(view.absolutePath, `evidence/${evidenceId.slice(9)}/note.md`), "utf-8");
	assert.match(projectedNote, new RegExp(`\\.\\./\\.\\./sources/${sourceId.slice(7)}/README\\.md#L1-L3`));
	assert.equal(readFileSync(join(view.absolutePath, `sources/${sourceId.slice(7)}/README.md`), "utf-8"), document);
	assert.equal(existsSync(join(view.absolutePath, `sources/${sourceId.slice(7)}/document.md`)), false);
	const manifest = JSON.parse(readFileSync(join(view.absolutePath, "manifest.json"), "utf-8")) as {
		wiki_refs: { dangling: unknown[] }; cornell_notes_refs: { dangling: unknown[] };
	};
	assert.deepEqual(manifest.wiki_refs.dangling, []);
	assert.deepEqual(manifest.cornell_notes_refs.dangling, []);
	const nextSourceRoot = join(root, "next-source-run");
	const nextStore = new RunArtifactStore(nextSourceRoot);
	const nextEvidence: CornellNotesSnapshot = {
		...evidence,
		snapshot_id: "snapshot:two",
		run_id: "run:next",
		source_bundle_refs: [],
		notes: [],
	};
	const nextEvidenceArtifact = nextStore.publishText(`${JSON.stringify(nextEvidence, null, 2)}\n`,
		"artifacts/cornell-notes/snapshot.json");
	const nextView = materializeReportKnowledgeView({
		targetStore: new RunArtifactStore(join(root, "next-report-run")), sourceStore: nextStore,
		wiki: sourceStore.describeDirectory("wiki"), evidence: nextEvidence, cornellNotesArtifact: nextEvidenceArtifact,
		baseView: view, targetRelativePath: "artifacts/report-flow/knowledge-snapshot",
	});
	assert.equal(readFileSync(join(nextView.absolutePath, `sources/${sourceId.slice(7)}/README.md`), "utf-8"), document);
	assert.ok(readFileSync(join(nextView.absolutePath, "wiki/index.md"), "utf-8")
		.includes(`[${evidenceId}](../evidence/${evidenceId.slice(9)}/note.md)`));
	const nextManifest = JSON.parse(readFileSync(join(nextView.absolutePath, "manifest.json"), "utf-8")) as {
		input: { base_sha256?: string }; counts: { evidence_notes: number; sources: number };
	};
	assert.equal(nextManifest.input.base_sha256, view.sha256);
	assert.deepEqual(nextManifest.counts, { wiki_files: 1, evidence_notes: 1, sources: 1 });
	const selectionRoot = join(root, "selection");
	const goalRoot = join(selectionRoot, "goal");
	const controlRunsRoot = join(selectionRoot, "control", "runs");
	for (const [runId, status] of [["2026-01-01T00-00-00.000Z", "published"],
		["2026-01-02T00-00-00.000Z", "failed"]] as const) {
		const runRoot = join(goalRoot, "wiki", "runs", runId);
		const snapshot = join(runRoot, "artifacts", "report-flow", "knowledge-snapshot");
		mkdirSync(snapshot, { recursive: true });
		writeFileSync(join(snapshot, "manifest.json"), `{"run":"${runId}"}\n`);
		if (status === "published") {
			mkdirSync(join(runRoot, "report"), { recursive: true });
			writeFileSync(join(runRoot, "report", "final.md"), "# Previous report\n");
		}
		mkdirSync(join(controlRunsRoot, runId), { recursive: true });
		writeFileSync(join(controlRunsRoot, runId, "run-state.json"), `${JSON.stringify({ status })}\n`);
	}
	const selector = new Run({} as never) as unknown as {
		previousReportKnowledgeSnapshot(request: {
			goalWorkspaceDirectory: string; controlDirectory: string; runId: string;
		}): PublishedArtifactDirectoryRef | undefined;
	};
	const selected = selector.previousReportKnowledgeSnapshot({
		goalWorkspaceDirectory: goalRoot,
		controlDirectory: join(controlRunsRoot, "2026-01-03T00-00-00.000Z"),
		runId: "2026-01-03T00-00-00.000Z",
	});
	assert.match(selected?.absolutePath ?? "", /2026-01-01T00-00-00\.000Z/u);
	assert.throws(() => materializeReportKnowledgeView({
		targetStore: new RunArtifactStore(join(root, "escape-target")), sourceStore,
		wiki: sourceStore.describeDirectory("wiki"), evidence: { ...evidence, source_bundle_refs: ["../escape"] },
		cornellNotesArtifact, targetRelativePath: "knowledge",
	}), /escape|relative|inside|Artifact/iu);
	console.log("report knowledge view tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
