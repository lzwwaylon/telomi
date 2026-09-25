import assert from "node:assert/strict";
import { getPreviewText } from "../../web/src/features/chat/TurnCard.js";
import type { ActivityItem } from "../../web/src/features/goals/data/types.js";

const read: ActivityItem = { id: "a", type: "tool", status: "completed", toolName: "read", intent: "read · SKILL.md", timestamp: 1 };
const failed: ActivityItem = { id: "b", type: "tool", status: "error", toolName: "generate_podcast", timestamp: 2 };

// A step labelled by an earlier activity's intent must not hide a later failure in the collapsed header.
assert.equal(getPreviewText([read, failed], undefined, false, true, true), "read · SKILL.md · 1 处错误");
assert.equal(getPreviewText([read], undefined, false, true, true), "read · SKILL.md");
assert.equal(getPreviewText([failed], undefined, false, true, true), "已完成步骤 · 1 处错误");
console.log("turn card preview test passed");
