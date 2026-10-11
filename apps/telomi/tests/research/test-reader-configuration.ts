import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQuestionReaderConfiguration } from "../../server/research/pipeline/reader-configuration.js";

const root = mkdtempSync(join(tmpdir(), "question-reader-config-"));
try {
	const env = { TELOMI_PRIME_AGENT_CHILD_MODEL: "configured/child" };
	assert.deepEqual(readQuestionReaderConfiguration(undefined, "Explain the mechanism.", env),
		{ childModel: "configured/child", language: "en" });
	assert.deepEqual(readQuestionReaderConfiguration(root, "解释原文中的机制。", env),
		{ childModel: "configured/child", language: "zh-CN" });
	assert.throws(() => readQuestionReaderConfiguration(undefined, undefined, env), /frozen question/u);
	assert.throws(() => readQuestionReaderConfiguration(undefined, "Question", { TELOMI_PRIME_AGENT_CHILD_MODEL: "configured/invalid model" }),
		/Question Reader configuration/u, "fallback settings use the same validation as frozen files");
	const corpus = join(root, "corpus"); mkdirSync(corpus);
	writeFileSync(join(corpus, "reader-context.json"), JSON.stringify({ original_question: "请解释原始材料中的机制。" }));
	assert.deepEqual(readQuestionReaderConfiguration(root, "Explain the delegated task.", env, corpus),
		{ childModel: "configured/child", language: "zh-CN" }, "original user language wins over the delegated task");
	assert.equal(readQuestionReaderConfiguration(undefined, undefined, env, corpus).language, "zh-CN");
	writeFileSync(join(corpus, "reader-context.json"), JSON.stringify({ original_question: " " }));
	assert.equal(readQuestionReaderConfiguration(undefined, "Explain the task.", env, corpus).language, "en");
	writeFileSync(join(corpus, "reader-context.json"), "not JSON");
	assert.throws(() => readQuestionReaderConfiguration(undefined, "Explain the task.", env, corpus), SyntaxError,
		"corrupt original context must not silently select a different language");
	const frozen = { childModel: "frozen/child", language: "zh-CN" };
	writeFileSync(join(root, "reader-config.json"), JSON.stringify(frozen));
	assert.deepEqual(readQuestionReaderConfiguration(root, undefined, {}), frozen,
		"frozen configuration needs neither settings nor question parsing");
	for (const invalid of [{ ...frozen, childModel: "model-only" }, { ...frozen, childModel: " " },
		{ ...frozen, language: "auto" }, [], null]) {
		writeFileSync(join(root, "reader-config.json"), JSON.stringify(invalid));
		assert.throws(() => readQuestionReaderConfiguration(root, "A question", env), /Question Reader configuration/u);
	}
	rmSync(join(root, "reader-config.json"));
	mkdirSync(join(root, "reader-config.json"));
	assert.throws(() => readQuestionReaderConfiguration(root, "A question", env), /EISDIR/u,
		"unreadable frozen configuration cannot fall back to current settings");
	console.log("Question Reader configuration: frozen precedence, language inference, invalid configuration and failed reads passed");
} finally { rmSync(root, { recursive: true, force: true }); }
