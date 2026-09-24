import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { createVoiceRouter } from "../../server/voice/api.js";
import {
	extractVoiceCorrections,
	VoiceCorrectionLearningStore,
} from "../../server/voice/correction-learning.js";
import { VoiceGlossaryStore } from "../../server/voice/glossary.js";

test("correction learning retains OpenWhispr word substitution behavior", () => {
	assert.deepEqual(
		extractVoiceCorrections(
			"Hello Shunade today",
			"Hello Sinead today",
			[],
		),
		["Sinead"],
	);
	assert.deepEqual(
		extractVoiceCorrections(
			"Open Whisper is useful",
			"OpenWhispr is useful",
			[],
		),
		["OpenWhispr"],
	);
	assert.deepEqual(
		extractVoiceCorrections(
			"The quik brown fox",
			"The quick brown fox",
			[],
		),
		["quick"],
	);
});

test("correction learning finds the edited region inside surrounding composer text", () => {
	assert.deepEqual(
		extractVoiceCorrections(
			"Hello Shunade today",
			"Context before Hello Sinead today context after more words",
			[],
		),
		["Sinead"],
	);
	assert.deepEqual(
		extractVoiceCorrections(
			"Prefix text. Hello Shunade today.",
			"Prefix text. Hello Sinead today.",
			[],
		),
		["Sinead"],
	);
});

test("correction learning filters rewrites, unrelated words, short words and known terms", () => {
	assert.deepEqual(
		extractVoiceCorrections(
			"one two three four",
			"one alpha beta gamma",
			[],
		),
		[],
	);
	assert.deepEqual(
		extractVoiceCorrections("I like cats", "I prefer databases", []),
		[],
	);
	assert.deepEqual(
		extractVoiceCorrections("a bc def", "a xy deg", []),
		[],
	);
	assert.deepEqual(
		extractVoiceCorrections(
			"Hello Shunade today",
			"Hello Sinead today",
			["Sinead"],
		),
		[],
	);
	assert.deepEqual(
		extractVoiceCorrections("unchanged", "unchanged", []),
		[],
	);
});

test("correction learning only learns Latin-script words", () => {
	assert.deepEqual(
		extractVoiceCorrections("我们今天讨论舒内德的方案", "我们今天讨论西尼德的方案", []),
		[],
	);
	assert.deepEqual(
		extractVoiceCorrections("请把 Shunade 的资料发我", "请把 Sinead 的资料发我", []),
		["Sinead"],
	);
	assert.deepEqual(
		extractVoiceCorrections("Ship it Shunade", "Ship it Sinéad", []),
		["Sinéad"],
	);
	// Chinese ASR output rarely spaces around Latin words.
	assert.deepEqual(
		extractVoiceCorrections("我想测试一下TDS的效果。", "我想测试一下tts的效果。", []),
		["tts"],
	);
	assert.deepEqual(
		extractVoiceCorrections("我想测试一下TDS的效果", "我想测试一下语音的效果", []),
		[],
	);
});

test("correction learning bounds pathological observation sizes", () => {
	const oversized = "word ".repeat(4_001);
	assert.deepEqual(
		extractVoiceCorrections(oversized, `${oversized}changed`, []),
		[],
	);
});

test("correction learning setting defaults on and persists explicit opt-out", () => {
	const workspace = mkdtempSync(join(tmpdir(), "telomi-correction-setting-"));
	try {
		const store = new VoiceCorrectionLearningStore(workspace);
		assert.deepEqual(store.getSettings(), { enabled: true, updatedAt: null });
		const disabled = store.setEnabled(false);
		assert.equal(disabled.enabled, false);
		assert.ok(disabled.updatedAt);
		assert.equal(
			new VoiceCorrectionLearningStore(workspace).getSettings().enabled,
			false,
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("learned corrections become provenance-tagged glossary terms without duplicates", () => {
	const workspace = mkdtempSync(join(tmpdir(), "telomi-learned-glossary-"));
	try {
		const glossary = new VoiceGlossaryStore(workspace);
		glossary.replace([
			{
				id: "term_telomi",
				canonical: "Telomi",
				enabled: true,
			},
		]);
		const first = glossary.learnCanonicalTerms(["Sinead", "Telomi", "Sinead"]);
		assert.deepEqual(first.learned, ["Sinead"]);
		assert.deepEqual(first.snapshot.entries, [
			{
				id: "term_telomi",
				canonical: "Telomi",
				enabled: true,
			},
			{
				id: first.snapshot.entries[1]?.id,
				canonical: "Sinead",
				enabled: true,
				source: "learned",
			},
		]);
		assert.deepEqual(glossary.learnCanonicalTerms(["sinead"]).learned, []);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("undo removes only matching learned terms and preserves manual or imported entries", () => {
	const workspace = mkdtempSync(join(tmpdir(), "telomi-undo-learned-glossary-"));
	try {
		const glossary = new VoiceGlossaryStore(workspace);
		glossary.replace([
			{
				id: "term_manual",
				canonical: "Telomi",
				enabled: true,
				source: "manual",
			},
			{
				id: "term_imported",
				canonical: "OpenWhispr",
				enabled: true,
				source: "imported",
			},
			{
				id: "term_learned",
				canonical: "Sinead",
				enabled: true,
				source: "learned",
			},
		]);

		const result = glossary.undoLearnedCanonicalTerms([
			"telomi",
			"OPENWHISPR",
			"sinead",
			"missing",
		]);

		assert.deepEqual(result.removed, ["Sinead"]);
		assert.deepEqual(
			result.snapshot.entries.map((entry) => [entry.canonical, entry.source]),
			[
				["Telomi", "manual"],
				["OpenWhispr", "imported"],
			],
		);
		assert.equal(
			glossary.undoLearnedCanonicalTerms(["Sinead"]).snapshot.revision,
			result.snapshot.revision,
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("correction-learning undo API removes learned terms through the production router", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "telomi-undo-learning-api-"));
	const glossary = new VoiceGlossaryStore(workspace);
	glossary.learnCanonicalTerms(["Sinead"]);
	const app = express();
	app.use(express.json());
	app.use(createVoiceRouter({} as never, workspace, {} as never));
	const server = app.listen(0, "127.0.0.1");
	try {
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/voice/correction-learning/undo`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ corrections: ["sinead"] }),
			},
		);
		assert.equal(response.status, 200);
		const body = (await response.json()) as {
			removed: string[];
			glossaryRevision: string;
		};
		assert.deepEqual(body.removed, ["Sinead"]);
		assert.equal(body.glossaryRevision, glossary.getSnapshot().revision);
		assert.deepEqual(glossary.getSnapshot().entries, []);
	} finally {
		server.close();
		await once(server, "close");
		rmSync(workspace, { recursive: true, force: true });
	}
});
