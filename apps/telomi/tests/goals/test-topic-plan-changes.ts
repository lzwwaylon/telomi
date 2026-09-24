import assert from "node:assert/strict";
import { getTopicPlanChanges } from "../../shared/topic-plan-changes.js";

const first = { id: "a", title: "模型", intent: "比较模型", questions: [], include: [], exclude: [] };
const second = { ...first, id: "b", title: "部署" };
const renamed = { ...first, title: "开源模型", exclude: ["协议"] };
const added = { ...first, id: "c", title: "压缩" };
assert.deepEqual(getTopicPlanChanges([], [first, second]), {
	added: [first, second], updated: [], removed: [], reordered: false,
});
assert.deepEqual(getTopicPlanChanges([first, second], [renamed, added]), {
	added: [added], updated: [renamed], removed: [second], reordered: false,
});
assert.deepEqual(getTopicPlanChanges([first, second], [second, first]), {
	added: [], updated: [], removed: [], reordered: true,
});
assert.deepEqual(getTopicPlanChanges([first], [{ ...first }]), {
	added: [], updated: [], removed: [], reordered: false,
});
console.log("Topic Plan change summaries preserve identity and distinguish edits, additions, removals and ordering");
