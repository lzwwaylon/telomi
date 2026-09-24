import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	publishPodcastBundle,
	splitPodcastTtsBlocks,
} from "../../server/media/podcast/runtime.js";
import { resolvePodcastGenerationBrief } from "../../server/media/podcast/preferences.js";
import { readPrimePodcastOutput } from "../../server/media/podcast/writer.js";
import { LEDGER_ARRAY_FIELDS, materializePodcastOutput, SEGMENT_CONTRACT, validatePodcastWorkspace } from "../../server/media/podcast/writer-contract.js";
import { renderAgentPrompt } from "../../server/agent-runtime/prompt-registry.js";
import { createGeneratePodcastTool } from "../../server/main-agent/tools/generate-podcast.js";

const podcastWorkerSource = readFileSync(join(import.meta.dirname, "../../server/media/podcast/writer-worker.ts"), "utf-8");
assert.match(podcastWorkerSource, /session\.waitForRlmQuiescence/u);
assert.doesNotMatch(podcastWorkerSource, /session\.hasRunningRlmChildren|session\.waitForIdle/u);
assert.match(podcastWorkerSource, /SessionManager\.create\(cwd, rootSessionDir\)/u);
assert.doesNotMatch(podcastWorkerSource, /SessionManager\.inMemory/u);
assert.match(podcastWorkerSource, /projectPrimeChildLifecycleEvent/u);
assert.match(readFileSync(join(import.meta.dirname,
	"../../agents/main/podcast-writer/prompts/user.segment-repair.md.njk"), "utf-8"), /validation_error/u);

const ttsBlocks = splitPodcastTtsBlocks("适合播报的一句话。".repeat(500));
assert.ok(ttsBlocks.length > 1);
assert.ok(ttsBlocks.every((block) => block.length <= 900));

let dispatchedPodcast: unknown;
const generatePodcast = createGeneratePodcastTool("goal_podcast", (request) => {
	dispatchedPodcast = request;
	return { jobId: "job-podcast", cardId: "report" };
});
const podcastToolResult = await generatePodcast.execute(
	"generate-podcast",
	{ artifact_name: "report.md", instruction: "Keep this episode concise." },
	new AbortController().signal,
	() => undefined,
);
assert.deepEqual(dispatchedPodcast, {
	goalId: "goal_podcast",
	artifactName: "report.md",
	generationInstruction: "Keep this episode concise.",
});
assert.equal((podcastToolResult.details as { jobId?: string }).jobId, "job-podcast");

let failPreferenceResolution = false;
let reflectBody: Record<string, unknown> | undefined;
const hindsight = createServer((request, response) => {
	const chunks: Buffer[] = [];
	request.on("data", (chunk: Buffer) => chunks.push(chunk));
	request.on("end", () => {
		reflectBody = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
		response.writeHead(failPreferenceResolution ? 500 : 200, { "content-type": "application/json" });
		response.end(JSON.stringify(failPreferenceResolution ? { error: "unavailable" } : {
			text: "Prefer explanatory Mandarin podcasts with moderate density.",
			based_on: { memories: [{ id: "memory-1", document_id: "pi-task-1" }] },
		}));
	});
});
await new Promise<void>((resolve) => hindsight.listen(0, "127.0.0.1", resolve));
const hindsightAddress = hindsight.address();
assert(hindsightAddress && typeof hindsightAddress === "object");
try {
	const memory = {
		baseUrl: `http://127.0.0.1:${hindsightAddress.port}/v1/default`,
		bankId: "podcast-preference-test",
	};
	const brief = await resolvePodcastGenerationBrief({
		goalId: "goal_podcast",
		generationInstruction: "Keep this episode concise.",
		memory,
	});
	assert.equal(brief.resolution, "resolved");
	assert.equal(brief.durablePreference, "Prefer explanatory Mandarin podcasts with moderate density.");
	assert.equal(brief.generationInstruction, "Keep this episode concise.");
	assert.deepEqual(brief.evidenceRefs, [{ memoryId: "memory-1", documentId: "pi-task-1" }]);
	assert.deepEqual(reflectBody?.tags, ["goal:goal_podcast", "scope:global"]);
	assert.equal(reflectBody?.tags_match, "any_strict");
	failPreferenceResolution = true;
	const fallback = await resolvePodcastGenerationBrief({
		goalId: "goal_podcast",
		generationInstruction: "Use a slower pace.",
		memory,
	});
	assert.equal(fallback.resolution, "unavailable");
	assert.equal(fallback.durablePreference, null);
	assert.equal(fallback.generationInstruction, "Use a slower pace.");
} finally {
	await new Promise<void>((resolve, reject) => hindsight.close((error) => error ? reject(error) : resolve()));
}

const publicationRoot = mkdtempSync(join(tmpdir(), "pi-podcast-publication-"));
try {
	const stagingDirectory = join(publicationRoot, "staging");
	const podcastDirectory = join(publicationRoot, "podcast");
	mkdirSync(stagingDirectory, { recursive: true });
	mkdirSync(podcastDirectory, { recursive: true });
	for (const name of ["script.json", "transcript.md", "transcript.json", "manifest.json", "episode.mp3"]) {
		writeFileSync(join(stagingDirectory, name), `new ${name}`);
		writeFileSync(join(podcastDirectory, name), `old ${name}`);
	}
	await publishPodcastBundle(stagingDirectory, podcastDirectory, "success");
	assert.equal(readFileSync(join(podcastDirectory, "episode.mp3"), "utf-8"), "new episode.mp3");

	for (const name of ["script.json", "transcript.md", "transcript.json", "manifest.json", "episode.mp3"]) {
		writeFileSync(join(stagingDirectory, name), `next ${name}`);
	}
	const blockedBackup = join(podcastDirectory, ".manifest.json.failure.previous");
	mkdirSync(blockedBackup, { recursive: true });
	writeFileSync(join(blockedBackup, "keep"), "force backup failure");
	await assert.rejects(() => publishPodcastBundle(stagingDirectory, podcastDirectory, "failure"));
	assert.equal(readFileSync(join(podcastDirectory, "episode.mp3"), "utf-8"), "new episode.mp3");
} finally {
	rmSync(publicationRoot, { recursive: true, force: true });
}

const primeOutputRoot = mkdtempSync(join(tmpdir(), "pi-prime-podcast-output-"));
try {
	const agentRoot = join(primeOutputRoot, "agent");
	const outputRoot = join(agentRoot, "writer-output");
	const runtimeRoot = join(primeOutputRoot, "runtime");
	mkdirSync(join(outputRoot, "sections"), { recursive: true });
	mkdirSync(runtimeRoot, { recursive: true });
	for (let index = 1; index <= 3; index += 1) {
		writeFileSync(join(outputRoot, "sections", `segment-00${index}.txt`), `第${index}段。`);
	}
	writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify({
		version: 1,
		title: "正式播客",
		sections: [1, 2, 3].map((index) => ({
			sectionId: `segment-00${index}`,
			title: `第${index}段`,
			path: `sections/segment-00${index}.txt`,
		})),
	})}\n`);
	writeFileSync(join(outputRoot, ".complete"), "");
	writeFileSync(join(runtimeRoot, "result.json"), "{}\n");
	const primeOutput = readPrimePodcastOutput(agentRoot, runtimeRoot, "root/model", "child/model");
	assert.equal(primeOutput.title, "正式播客");
	assert.equal(primeOutput.sections.length, 3);
	assert.equal(primeOutput.sections[2]?.text, "第3段。");
} finally {
	rmSync(primeOutputRoot, { recursive: true, force: true });
}

const contractRoot = mkdtempSync(join(tmpdir(), "pi-prime-podcast-contract-"));
try {
	const segments = [1, 2, 3].map((index) => ({
		segment_id: `segment-${String(index).padStart(3, "0")}`,
		title: `Segment ${index}`,
	}));
	mkdirSync(join(contractRoot, "work", "segments"), { recursive: true });
	writeFileSync(join(contractRoot, "work", "episode-plan.json"), `${JSON.stringify({ title: "Episode", segments })}\n`);
	const completeLedger = (segment_id: string) => JSON.stringify({
		segment_id,
		...Object.fromEntries(LEDGER_ARRAY_FIELDS.map((field) => [field, []])),
	});
	for (const { segment_id } of segments) {
		const root = join(contractRoot, "work", "segments", segment_id);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "assignment.json"), `${JSON.stringify({ contract: SEGMENT_CONTRACT })}\n`);
		writeFileSync(join(root, "draft.txt"), "Grounded spoken prose.\n");
		writeFileSync(join(root, "ledger.json"), `${completeLedger(segment_id)}\n`);
	}
	const segmentOne = join(contractRoot, "work", "segments", "segment-001");
	// The contract file itself renders without variables and names every ledger field the Runtime checks.
	const contractText = renderAgentPrompt("main", "podcast-writer", "reference", {}, "segment-contract").content;
	for (const field of LEDGER_ARRAY_FIELDS) assert.match(contractText, new RegExp(`"${field}"`, "u"));
	assert.match(readFileSync(join(import.meta.dirname, "../../agents/main/podcast-writer/prompts/user.plan.md.njk"), "utf-8"), /segment-contract\.md/u);
	assert.match(readFileSync(join(import.meta.dirname, "../../agents/main/podcast-writer/prompts/user.segment-repair.md.njk"), "utf-8"), /segment-contract\.md/u);
	// An assignment that does not bind the child to the Runtime contract is rejected before any ledger check.
	writeFileSync(join(segmentOne, "assignment.json"), "{}\n");
	assert.throws(() => validatePodcastWorkspace(contractRoot, "segments"),
		/\[podcast-writer:segments\] file 'work\/segments\/segment-001\/assignment\.json', field 'contract': must equal 'inputs\/segment-contract\.md'/u);
	writeFileSync(join(segmentOne, "assignment.json"), `${JSON.stringify({ contract: SEGMENT_CONTRACT })}\n`);
	// Root owns the joins between segments and the episode's single closing. A child handed a
	// transition writes it, and the last segment's `transition_out` has no next segment to hand on
	// to, so it carries the ending and the episode concludes more than once (the 2026-09-19 podcast
	// closed three times). An assignment carrying either field is rejected.
	for (const field of ["transition_in", "transition_out"]) {
		writeFileSync(join(segmentOne, "assignment.json"), `${JSON.stringify({ contract: SEGMENT_CONTRACT, [field]: "hands on to the next segment" })}\n`);
		assert.throws(() => validatePodcastWorkspace(contractRoot, "segments"),
			new RegExp(`\\[podcast-writer:segments\\] file 'work/segments/segment-001/assignment\\.json', field '${field}': belongs to Root's merge`, "u"));
	}
	writeFileSync(join(segmentOne, "assignment.json"), `${JSON.stringify({ contract: SEGMENT_CONTRACT })}\n`);
	// The contract tells the child the same thing, so a rejection is something it can act on.
	assert.match(contractText, /transition into or out of the segment/u);
	assert.match(contractText, /not yours to write/u);
	// A ledger written in an invented shape (the 2026-09-14 failure) is rejected at its first missing field.
	writeFileSync(join(segmentOne, "ledger.json"), '{"segment_id":"segment-001","claims":[],"coverage":[]}\n');
	assert.throws(() => validatePodcastWorkspace(contractRoot, "segments"),
		/\[podcast-writer:segments\] file 'work\/segments\/segment-001\/ledger\.json', field 'source_anchors_used': must be an array/u);
	writeFileSync(join(segmentOne, "ledger.json"),
		`${completeLedger("segment-001").replace('"unresolved":[]', '"unresolved":"bad"')}\n`);
	assert.throws(() => validatePodcastWorkspace(contractRoot, "segments"),
		/\[podcast-writer:segments\] file 'work\/segments\/segment-001\/ledger\.json', field 'unresolved': must be an array/u);
	writeFileSync(join(segmentOne, "ledger.json"), `${completeLedger("segment-001")}\n`);
	assert.equal(validatePodcastWorkspace(contractRoot, "segments").segments.length, 3);
	writeFileSync(join(contractRoot, "work", "source-audit-initial.json"), '{"passed":true}\n');
	writeFileSync(join(contractRoot, "work", "listener-review.json"), '{"verdict":"PASS","blockers":"none"}\n');
	writeFileSync(join(contractRoot, "work", "grounded-script.txt"), "Grounded spoken prose.\n");
	assert.throws(() => validatePodcastWorkspace(contractRoot, "initial-review"),
		/\[podcast-writer:initial-review\] file 'work\/listener-review\.json', field 'blockers': must be an array/u);
	writeFileSync(join(contractRoot, "work", "source-audit-final.json"), `${JSON.stringify({
		passed: true,
		unsupported_claims: [],
		numeric_mismatches: [],
		missing_qualifications: [],
		missing_concept_closures: "bad",
		visual_relationship_errors: [],
	})}\n`);
	assert.throws(() => validatePodcastWorkspace(contractRoot, "final-audit"),
		/\[podcast-writer:final-audit\] file 'work\/source-audit-final\.json', field 'missing_concept_closures': must be an array/u);
	assert.throws(() => materializePodcastOutput(contractRoot),
		/\[podcast-writer:final-output\] file 'work\/podcast-script\.txt', field '\$': required file is missing or empty/u);
} finally {
	rmSync(contractRoot, { recursive: true, force: true });
}

console.log("single narrator podcast checks passed");
