import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../server/lib/hash.js";
import {
	RuntimeCornellNoteAgentProcessor,
	validateCornellNote,
} from "../../server/research/cornell-note-agent.js";
import type {
	AgentStageRequest,
	AgentStageRunner,
	ValidatedStageArtifact,
} from "../../server/agent-runtime/agent-stage-runtime.js";
import { AgentStageExecutionError } from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { materializeAgentSourceView } from "../../server/research/pipeline/agent-source-view.js";
import { validateCornellNotesSnapshot } from "../../server/cornell/contracts.js";
import type { GoalTopicPlan } from "../../server/goals/topic-plan/index.js";

const root = mkdtempSync(join(tmpdir(), "cornell-note-contract-"));
try {
	const path = join(root, "paper.md");
	writeFileSync(path, "alpha\nbeta\ngamma\n");
	const note = validateCornellNote({
		sections: [{
			section_title: "Architecture",
			summary: "The Source describes the architecture.",
			cue_notes: [{
				cue: "Decoder + latency",
				note: "The decoder uses beta.",
				evidence: [{ source_path: "source-group/paper.md", start_line: 2, end_line: 2 }],
			}],
		}],
	}, "source-group:test", [{ relativePath: "paper.md", absolutePath: path, sha256: sha256("alpha\nbeta\ngamma\n"), byteLength: 17 }]);
	assert.equal(note.sections[0]!.cue_notes[0]!.evidence[0]!.content_sha256, sha256("beta\n"));
	assert.equal(note.sections[0]!.cue_notes[0]!.evidence[0]!.source_path, "paper.md");
	const caseNormalized = validateCornellNote({ sections: [{
		section_title: "Canonical path",
		summary: "The Source path keeps its declared casing.",
		cue_notes: [{ cue: "Path casing", note: "The citation resolves canonically.", evidence: [
			{ source_path: "source-group/Paper.MD", start_line: 2, end_line: 2 },
		] }],
	}] }, "source-group:test", [{ relativePath: "paper.md", absolutePath: path, sha256: sha256("alpha\nbeta\ngamma\n"), byteLength: 17 }]);
	assert.equal(caseNormalized.sections[0]!.cue_notes[0]!.evidence[0]!.source_path, "paper.md");
	const topicPlan: GoalTopicPlan = {
		schema_version: 1,
		goal_id: "goal-cornell",
		revision: "topic-plan-v1",
		status: "active",
		topics: [
			{ id: "multilingual", title: "Multilingual", intent: "Multilingual speech", questions: [], include: [], exclude: [] },
			{ id: "historical", title: "Historical", intent: "Historical Topic", questions: [], include: [], exclude: [] },
		],
	};
	const topicNote = validateCornellNote({ sections: [{
		section_title: "Language coverage",
		summary: "The Source covers multilingual speech.",
		cue_notes: [{
			cue: "Multilingual + coverage",
			note: "The system covers Chinese and English.",
			topic_refs: ["T1"],
			evidence: [{ source_path: "paper.md", start_line: 2, end_line: 2 }],
		}],
	}] }, "source-group:test", [{ relativePath: "paper.md", absolutePath: path, sha256: sha256("alpha\nbeta\ngamma\n"), byteLength: 17 }], topicPlan);
	assert.deepEqual(topicNote.sections[0]!.cue_notes[0]!.topic_refs, ["multilingual"]);
	assert.throws(() => validateCornellNote({ sections: [{
		section_title: "Duplicate",
		summary: "Duplicate Topic references are invalid.",
		cue_notes: [{ cue: "Duplicate", note: "Invalid.", topic_refs: ["T1", "T1"], evidence: [{ source_path: "paper.md", start_line: 2, end_line: 2 }] }],
	}] }, "source-group:test", [{ relativePath: "paper.md", absolutePath: path, sha256: sha256("alpha\nbeta\ngamma\n"), byteLength: 17 }], topicPlan),
	/sections\[0\]\.cue_notes\[0\]\.topic_refs contains duplicate reference 'T1'/u);
	assert.throws(() => validateCornellNote({ sections: [{
		section_title: "Unknown",
		summary: "Invalid unknown Topic.",
		cue_notes: [{ cue: "Unknown", note: "Invalid.", topic_refs: ["T9"], evidence: [{ source_path: "paper.md", start_line: 2, end_line: 2 }] }],
	}] }, "source-group:test", [{ relativePath: "paper.md", absolutePath: path, sha256: sha256("alpha\nbeta\ngamma\n"), byteLength: 17 }], topicPlan),
	/sections\[0\]\.cue_notes\[0\]\.topic_refs\[0\].*T9.*allowed references.*T1.*Multilingual/u);
	assert.throws(() => validateCornellNote({ sections: "invalid" }, "source-group:test", []),
		/Cornell Note\.sections must be an array/u);
	assert.throws(() => validateCornellNote({ sections: [{
		section_title: "Evidence fields",
		summary: "Evidence fields are invalid.",
		cue_notes: [{ cue: "Evidence", note: "Invalid.", topic_refs: [], evidence: [{ source_path: "paper.md", start_line: 2, extra: true }] }],
	}] }, "source-group:test", [{ relativePath: "paper.md", absolutePath: path, sha256: sha256("alpha\nbeta\ngamma\n"), byteLength: 17 }], topicPlan),
	/sections\[0\]\.cue_notes\[0\]\.evidence\[0\].*missing: end_line.*unexpected: extra/u);
	const discoveryNote = validateCornellNote({ sections: [{
		section_title: "Emerging",
		summary: "A new direction is not covered.",
		cue_notes: [{
			cue: "Inference adaptation",
			note: "The Source introduces a new inference adaptation direction.",
			topic_refs: [],
			discovery: { finding: "Inference adaptation can materially extend the Goal." },
			evidence: [{ source_path: "paper.md", start_line: 3, end_line: 3 }],
		}],
	}] }, "source-group:test", [{ relativePath: "paper.md", absolutePath: path, sha256: sha256("alpha\nbeta\ngamma\n"), byteLength: 17 }], topicPlan, true);
	assert.equal(discoveryNote.sections[0]!.cue_notes[0]!.discovery?.finding, "Inference adaptation can materially extend the Goal.");
	assert.throws(() => validateCornellNote({ sections: [{
		section_title: "Missing Discovery",
		summary: "Discovery is required by the enabled contract.",
		cue_notes: [{ cue: "Missing", note: "Invalid.", topic_refs: [], evidence: [{ source_path: "paper.md", start_line: 2, end_line: 2 }] }],
	}] }, "source-group:test", [{ relativePath: "paper.md", absolutePath: path, sha256: sha256("alpha\nbeta\ngamma\n"), byteLength: 17 }], topicPlan, true), /must contain exactly/u);
	assert.throws(() => validateCornellNote({ sections: [{
		section_title: "Unexpected Discovery",
		summary: "Discovery is disabled.",
		cue_notes: [{ cue: "Unexpected", note: "Invalid.", topic_refs: [], discovery: { finding: "Unexpected" }, evidence: [{ source_path: "paper.md", start_line: 2, end_line: 2 }] }],
	}] }, "source-group:test", [{ relativePath: "paper.md", absolutePath: path, sha256: sha256("alpha\nbeta\ngamma\n"), byteLength: 17 }], topicPlan, false), /must contain exactly/u);
	assert.throws(() => validateCornellNote({
		relevance_level: "high",
		rationale: "legacy",
		matched_questions: [],
		cornell_notes: [],
		unresolved_questions: [],
	}, "source-group:test", []), /exactly sections/u);

	const snapshot = validateCornellNotesSnapshot({
		schema_version: 1,
		snapshot_id: "snapshot:test",
		run_id: "run:test",
		pipeline: { id: "research-cornell-note", version: "4", sha256: sha256("pipeline") },
		source_bundle_refs: ["artifacts/source-bundles/test"],
		notes: [{
			note,
			title: "Cross-provider Source",
			canonical_locator: "https://example.com/source",
			provider_id: "cross-provider",
			provenance_ref: "provider:cross-provider:test",
			source_revision_sha256: sha256("revision"),
			members: [],
		}],
	});
	assert.equal(snapshot.notes.length, 1);
	assert.ok(!("screening" in snapshot));
	assert.ok(!("evidence" in snapshot));

	const convertedSource = join(root, "converted-source");
	const convertedView = join(root, "converted-view");
	mkdirSync(join(convertedSource, "assets"), { recursive: true });
	writeFileSync(join(convertedSource, "paper.pdf"), "%PDF-1.7\nraw paper body\n");
	writeFileSync(join(convertedSource, "paper.md"), "# Converted paper\n\n![Architecture](assets/figure.png)\n");
	const figure = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
	writeFileSync(join(convertedSource, "assets", "figure.png"), figure);
	writeFileSync(join(convertedSource, "unreferenced.bin"), Buffer.from([0x00, 0x01, 0x02]));
	writeFileSync(join(convertedSource, "record.json"), "{\"runtime\":true}\n");
	writeFileSync(join(convertedSource, "parser-manifest.json"), `${JSON.stringify({
		assets: [{
			node_id: "node:figure:1",
			markdown_path: "assets/figure.png",
			relative_path: "ignored/provider/path/figure.png",
			sha256: sha256(figure),
			byte_length: figure.byteLength,
			media_type: "image/png",
		}],
	})}\n`);
	const view = materializeAgentSourceView(convertedSource, convertedView, {
		id: "source:converted-paper",
		title: "Converted paper",
		url: "https://example.com/paper",
		providerId: "arxiv",
		organizationKind: "ungrouped",
		members: [{
			sourceId: "member:converted-paper",
			providerId: "arxiv",
			title: "Converted paper member",
			canonicalLocator: "https://example.com/paper",
			path: ".",
		}],
	});
	assert.deepEqual(view.contentFiles.map((file) => file.relativePath), ["paper.md"]);
	assert.deepEqual(view.assetFiles.map((file) => file.relativePath), ["assets/figure.png"]);
	assert.deepEqual(JSON.parse(readFileSync(join(convertedView, "source-manifest.json"), "utf-8")), {
		schema_version: 1,
		source: {
			source_id: "source:converted-paper",
			title: "Converted paper",
			canonical_locator: "https://example.com/paper",
			provider_id: "arxiv",
			organization_kind: "ungrouped",
			members: [{
				source_id: "member:converted-paper",
				provider_id: "arxiv",
				title: "Converted paper member",
				canonical_locator: "https://example.com/paper",
				path: ".",
			}],
		},
		content_files: [{ path: "paper.md", byte_length: Buffer.byteLength("# Converted paper\n\n![Architecture](assets/figure.png)\n"), line_count: 4, sha256: sha256("# Converted paper\n\n![Architecture](assets/figure.png)\n") }],
		display_assets: [{ path: "assets/figure.png", byte_length: figure.byteLength, sha256: sha256(figure) }],
	});
	assert.equal(existsSync(join(convertedView, "paper.pdf")), false);
	assert.equal(existsSync(join(convertedView, "unreferenced.bin")), false);
	assert.equal(existsSync(join(convertedView, "parser-manifest.json")), false);
	assert.equal(existsSync(join(convertedView, "record.json")), false);
	assert.equal(existsSync(join(convertedSource, "paper.pdf")), true, "the immutable Source keeps its PDF");
	const stageRunner: AgentStageRunner = {
		async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
			assert.equal(request.evaluation, undefined, "default Cornell processing must not request Case Capture");
			const sourceMount = request.readonlyMounts.find((mount) => mount.guestPath === "/source");
			assert.ok(sourceMount);
			assert.deepEqual(filesBelow(sourceMount.hostPath), ["assets/figure.png", "paper.md", "source-manifest.json"]);
			const entryPath = join(request.workDirectory, "cornell-note.json");
			writeFileSync(entryPath, `${JSON.stringify({
				sections: [{
					section_title: "Converted paper",
					summary: "The converted Markdown is readable.",
					cue_notes: [{
						cue: "Conversion + Markdown",
						note: "The paper is supplied as Markdown.",
						evidence: [{ source_path: "paper.md", start_line: 1, end_line: 1 }],
					}],
				}],
			})}\n`);
			const value = request.output.validate({
				entryPath,
				outputRoot: request.workDirectory,
				workDirectory: request.workDirectory,
			});
			return {
				value,
				artifact: request.artifactStore.publishFile(entryPath, request.output.publishRelativePath),
				submissionCount: 1,
				validationErrors: [],
				session: { id: "cornell-source-view", mode: "fresh" },
				turns: 1,
				toolCalls: 1,
				toolCounts: { ipython: 1 },
				usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
				sessionPath: join(request.controlDirectory, "cornell-source-view.jsonl"),
			};
		},
	};
	const runRoot = join(root, "run");
	const processor = new RuntimeCornellNoteAgentProcessor({
		outputLanguage: "en",
		documentConcurrency: 1,
		cornellNoteModel: "openai-codex/test", cornellNoteThinkingLevel: "medium",
	}, stageRunner);
	const produced = await processor.process({
		runId: "run:cornell-source-view",
		sequence: 1,
		question: "What does the converted paper contain?",
		goal: { title: "Understand converted papers", description: "" },
		discoveryEnabled: false,
		sources: [{
			id: "source:converted-paper",
			title: "Converted paper",
			url: "https://example.com/paper",
			providerId: "arxiv",
			sourceIdentity: "source:converted-paper",
			revisionSha256: sha256("converted-paper"),
			directoryPath: convertedSource,
			organizationKind: "ungrouped",
			members: [],
		}],
		signal: new AbortController().signal,
		workspaceDir: runRoot,
		controlDir: join(root, "control"),
		artifactStore: new RunArtifactStore(runRoot),
	});
	assert.equal(produced.notes[0]?.note.sections[0]?.cue_notes[0]?.evidence[0]?.source_path, "paper.md");
	assert.equal(produced.notes[0]?.artifactRef,
		`artifacts/cornell-notes/sequence-1/source-converted-paper-${sha256("converted-paper").slice(0, 12)}.json`);
	const attemptedSources: string[] = [];
	const isolatingRunner: AgentStageRunner = {
		async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
			const sourceMount = request.readonlyMounts.find((mount) => mount.guestPath === "/source")!;
			const sourceId = JSON.parse(readFileSync(join(sourceMount.hostPath, "source-manifest.json"), "utf-8")).source.source_id;
			attemptedSources.push(sourceId);
			if (sourceId === "source:broken") {
				throw new AgentStageExecutionError("invalid Cornell section", "validation");
			}
			return stageRunner.runStage(request);
		},
	};
	const isolated = await new RuntimeCornellNoteAgentProcessor({
		outputLanguage: "en",
		documentConcurrency: 2,
		cornellNoteModel: "openai-codex/test", cornellNoteThinkingLevel: "medium",
	}, isolatingRunner).process({
		runId: "run:cornell-isolation",
		sequence: 2,
		question: "Continue after one Source fails.",
		goal: { title: "Continue Cornell processing", description: "" },
		discoveryEnabled: false,
		signal: new AbortController().signal,
		workspaceDir: join(root, "isolation-run"),
		controlDir: join(root, "isolation-control"),
		sources: ["source:one", "source:broken", "source:two"].map((id) => ({
			id,
			title: id,
			url: `https://example.com/${id.slice(7)}`,
			providerId: "arxiv",
			sourceIdentity: id,
			revisionSha256: sha256(id),
			directoryPath: convertedSource,
			organizationKind: "ungrouped" as const,
			members: [],
		})),
	});
	assert.deepEqual(attemptedSources.sort(), ["source:broken", "source:one", "source:two"]);
	assert.deepEqual(isolated.notes.map((item) => item.source.id), ["source:one", "source:two"]);
	assert.deepEqual(isolated.failures.map((item) => [item.source.id, item.message]),
		[["source:broken", "invalid Cornell section"]]);
	await assert.rejects(new RuntimeCornellNoteAgentProcessor({
		outputLanguage: "en",
		documentConcurrency: 1,
		cornellNoteModel: "openai-codex/test", cornellNoteThinkingLevel: "medium",
	}, {
		async runStage(): Promise<never> {
			throw new Error("artifact store unavailable");
		},
	}).process({
		runId: "run:cornell-runtime-failure",
		sequence: 3,
		question: "Do not hide Runtime failures.",
		goal: { title: "Validate Runtime failures", description: "" },
		discoveryEnabled: false,
		signal: new AbortController().signal,
		workspaceDir: join(root, "runtime-failure-run"),
		controlDir: join(root, "runtime-failure-control"),
		sources: [{
			id: "source:runtime-failure",
			title: "Runtime failure",
			url: "https://example.com/runtime-failure",
			providerId: "arxiv",
			sourceIdentity: "source:runtime-failure",
			revisionSha256: sha256("runtime-failure"),
			directoryPath: convertedSource,
			organizationKind: "ungrouped",
			members: [],
		}],
	}), /artifact store unavailable/u);

	const binaryOnlySource = join(root, "binary-only-source");
	mkdirSync(binaryOnlySource);
	writeFileSync(join(binaryOnlySource, "paper.pdf"), "%PDF-1.7\nraw paper body\n");
	assert.throws(
		() => materializeAgentSourceView(binaryOnlySource, join(root, "binary-only-view")),
		/no readable text/u,
	);
	const unsafeSource = join(root, "unsafe-source");
	mkdirSync(unsafeSource);
	writeFileSync(join(unsafeSource, "paper.md"), "# Safe text\n");
	writeFileSync(join(unsafeSource, "parser-manifest.json"), `${JSON.stringify({
		assets: [{
			markdown_path: "../outside.png",
			media_type: "image/png",
			sha256: "a".repeat(64),
			byte_length: 1,
		}],
	})}\n`);
	assert.throws(
		() => materializeAgentSourceView(unsafeSource, join(root, "unsafe-view")),
		/asset escapes its Source/u,
	);
	console.log("Cornell Note contract test passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

function filesBelow(root: string, prefix = ""): string[] {
	return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		return entry.isDirectory() ? filesBelow(root, path) : entry.isFile() ? [path] : [];
	}).sort();
}
