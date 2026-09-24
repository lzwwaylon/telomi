import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GoalHeader } from "../../web/src/features/goals/GoalHeader.js";
import { PulseBand } from "../../web/src/features/home/PulseBand.js";
import type { GoalSnapshot } from "../../shared/types.js";
import i18n from "../../web/src/app/i18n.js";

await i18n.changeLanguage("zh-CN");

const snapshot: GoalSnapshot = {
	goalId: "goal_loading",
	title: "成为语音专家",
	description: "",
	messages: [],
	isStreaming: false,
	pendingToolCalls: [],
	stopState: "idle",
};

const fromSnapshot = renderToStaticMarkup(
	<GoalHeader goalId={snapshot.goalId} goal={null} snapshot={snapshot} />,
);
assert.match(fromSnapshot, /成为语音专家/u);
assert.doesNotMatch(fromSnapshot, /未命名目标/u);

const pending = renderToStaticMarkup(
	<GoalHeader goalId={snapshot.goalId} goal={null} snapshot={null} />,
);
assert.match(pending, /正在加载目标/u);
assert.doesNotMatch(pending, /未命名目标/u);

const goalHeaderSource = readFileSync(
	new URL("../../web/src/features/goals/GoalHeader.tsx", import.meta.url),
	"utf8",
);
assert.match(
	goalHeaderSource,
	/onClick=\{onTalkOrigin\}/u,
	"deeptalk must call the existing SPA route callback",
);
assert.doesNotMatch(
	goalHeaderSource,
	/href=\{`\/chat\//u,
	"deeptalk must not reload the document",
);

const idleActivity = renderToStaticMarkup(
	<PulseBand
		route="goal"
		goals={[]}
		selectedGoal={null}
		snapshot={snapshot}
	/>,
);
assert.match(idleActivity, /暂无活动/u);

console.log("Goal header loading-state test passed");
