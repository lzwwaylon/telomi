import assert from "node:assert/strict";
import {
	markAlerts,
	unreadAlerts,
	visibleAlerts,
	type InboxMarks,
} from "../../web/src/features/home/inboxMarks.js";

const quotaWarning = { id: "codex-usage-a", title: "用量 85%", description: "warn" };
const quotaExhausted = { id: "codex-usage-a", title: "额度已用完", description: "full" };
const source = { id: "source-alert-x", title: "X 需要登录", description: "login" };

let marks: InboxMarks = {};
assert.deepEqual(unreadAlerts(marks, [quotaWarning, source]), [quotaWarning, source]);

marks = markAlerts(marks, [quotaWarning, source], "seen");
assert.deepEqual(unreadAlerts(marks, [quotaWarning, source]), [], "opening the panel marks everything seen");
assert.deepEqual(visibleAlerts(marks, [quotaWarning, source]), [quotaWarning, source], "seen alerts stay listed");

assert.deepEqual(
	unreadAlerts(marks, [quotaExhausted, source]),
	[quotaExhausted],
	"same alert id with new wording is unread again",
);

marks = markAlerts(marks, [quotaExhausted, source], "dismissed");
assert.deepEqual(visibleAlerts(marks, [quotaExhausted, source]), [], "clear hides everything");
marks = markAlerts(marks, [quotaExhausted, source], "seen");
assert.deepEqual(visibleAlerts(marks, [quotaExhausted, source]), [], "seen never downgrades dismissed");

marks = markAlerts(marks, [source], "seen");
assert.deepEqual(Object.keys(marks).length, 1, "marks for vanished alerts are pruned");
assert.deepEqual(unreadAlerts(marks, [quotaExhausted, source]), [quotaExhausted], "a returning alert is unread");

console.log("inbox marks ok");
