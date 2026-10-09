import assert from "node:assert/strict";

import { buildWindowPrompt, parseReviewRecords, parseWindowVerdicts, reviewWindowWith } from "../../server/research/pipeline/pool-review.js";

// The screen keeps by default: two verdicts, a `no` names one of two reasons, validation is per record.
const records = parseReviewRecords([
	{ id: "https://github.com/org/base", text: "repository: org/base\ndescription: A multilingual speech model with weights and a paper." },
	{ id: "https://github.com/other/list", text: "repository: other/list\ndescription: (none)" },
	{ id: "https://github.com/lab/breeze", text: "repository: lab/breeze\ndescription: Inference code for Breeze." },
]);
assert.throws(() => parseReviewRecords([]), /1 to 20 entries/u);
assert.throws(() => parseReviewRecords([{ id: "a", text: "x" }, { id: "a", text: "y" }]), /repeats 'a'/u);

const task = "Provider ID: github\nEnumerate open speech models released this year. Exclude wrappers around hosted APIs. Leads: org/base.";
const prompt = buildWindowPrompt(task, records);
assert.match(prompt.user, /^Task:\nProvider ID: github\nEnumerate open speech models/u, "the reviewer reads the task Root wrote, whole");
assert.match(prompt.user, /\[2\] id: https:\/\/github.com\/other\/list\nrepository: other\/list/u);
assert.match(prompt.systemPrompt, /keep is the default[\s\S]+off_subject: [\s\S]+excluded_by_task: [\s\S]+Do not judge the standing, popularity, size or quality/u);
assert.doesNotMatch(prompt.systemPrompt, /unclear|quote|evidence|select|rank/iu, "no third verdict, no evidence quotes, no selection");
const answer = (verdicts: unknown[]) => JSON.stringify({ verdicts });

// One bad verdict invalidates its own record; the valid verdicts of the same answer stand.
const mixed = parseWindowVerdicts(records, "```json\n" + answer([
	{ id: records[0]!.id, verdict: "keep", evidence: "ignored" },
	{ id: records[1]!.id, verdict: "no", reason: "low_quality" },
	{ id: records[2]!.id, verdict: "no", reason: "excluded_by_task" },
	{ id: "https://github.com/not/shown", verdict: "no", reason: "off_subject" },
]) + "\n```");
assert.deepEqual(mixed.verdicts, [{ id: records[0]!.id, verdict: "keep" }, { id: records[2]!.id, verdict: "no", reason: "excluded_by_task" }]);
assert.deepEqual([...mixed.invalid], [[records[1]!.id, "no needs reason off_subject or excluded_by_task"]], "a no outside the two reasons is not a verdict");
assert.deepEqual([...parseWindowVerdicts(records, answer([{ id: records[0]!.id, verdict: "unclear" }, { id: records[1]!.id, verdict: "no" }])).invalid], [
	[records[0]!.id, "unknown verdict 'unclear'; answer keep or no"],
	[records[1]!.id, "no needs reason off_subject or excluded_by_task"],
	[records[2]!.id, "it has no verdict"],
]);
assert.equal(parseWindowVerdicts(records, "not json").invalid.size, 3);

// The correction round shows only the rejected records; a record still without a valid verdict is kept.
const prompts: string[] = [];
const answers = [
	answer([{ id: records[0]!.id, verdict: "no", reason: "off_subject" }, { id: records[1]!.id, verdict: "no", reason: "unknown publisher" }, { id: records[2]!.id, verdict: "maybe" }]),
	answer([{ id: records[1]!.id, verdict: "no", reason: "unknown publisher" }, { id: records[2]!.id, verdict: "keep" }]),
];
const review = await reviewWindowWith(async (_system, content) => { prompts.push(content); return answers[prompts.length - 1]!; }, { task, records });
assert.equal(review.attempts, 2);
assert.doesNotMatch(prompts[1]!, /id: https:\/\/github.com\/org\/base/u, "an accepted record is not shown again");
assert.match(prompts[1]!, /other\/list[\s\S]+lab\/breeze[\s\S]+were rejected[\s\S]+no needs reason off_subject or excluded_by_task/u);
assert.deepEqual(review.verdicts, [
	{ id: records[0]!.id, verdict: "no", reason: "off_subject" },
	{ id: records[1]!.id, verdict: "keep" },
	{ id: records[2]!.id, verdict: "keep" },
], "a record the model twice refused for a reason outside the vocabulary is kept, as the default says");
assert.deepEqual(Object.keys(review.invalid), [records[1]!.id, records[2]!.id]);
assert.deepEqual(review.unresolved, [records[1]!.id]);
const clean = await reviewWindowWith(async () => answer([{ id: records[0]!.id, verdict: "keep" }]), { task, records: records.slice(0, 1) });
assert.deepEqual([clean.attempts, clean.unresolved.length], [1, 0]);
console.log("pool screen verdict validation passed");
