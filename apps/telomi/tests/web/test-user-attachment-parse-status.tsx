import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AttachmentPayload } from "../../shared/types.js";
import { UserMessageBubble } from "../../web/src/features/chat/UserMessageBubble.js";
import { userBubblePropsEqual } from "../../web/src/features/chat/MessageList.js";

// 解析状态在轮次进行中才写回附件,这一帧的 snapshot 与上一帧附件 id 完全相同,
// 只有 parseStatus 变了。比较器必须认出这个变化,否则气泡要等刷新页面才显示状态。
function attachment(overrides: Partial<AttachmentPayload> = {}): AttachmentPayload {
	return {
		id: "a1",
		type: "document",
		fileName: "parse-test.pdf",
		mimeType: "application/pdf",
		size: 23590,
		content: "",
		...overrides,
	};
}

const first = attachment({ id: "first", fileName: "first.pdf" });
const last = attachment({ id: "last", fileName: "last.pdf" });
const middle = attachment({ id: "middle" });

const pending = [first, middle, last];
const parsed = [first, { ...middle, parseStatus: "parsed" as const }, last];
const failed = [first, { ...middle, parseStatus: "failed" as const, parseError: "解析超时" }, last];

assert.equal(
	userBubblePropsEqual({ text: "读一下校验码", attachments: pending }, { text: "读一下校验码", attachments: parsed }),
	false,
	"同一 id 的中间附件解析完成后,气泡必须重新渲染",
);
assert.equal(
	userBubblePropsEqual({ text: "读一下校验码", attachments: parsed }, { text: "读一下校验码", attachments: failed }),
	false,
	"解析失败同样要落到气泡上",
);
assert.equal(
	userBubblePropsEqual(
		{ text: "读一下校验码", attachments: pending },
		{ text: "读一下校验码", attachments: pending.map((a) => ({ ...a })) },
	),
	true,
	"流式期间附件只是新对象、内容没变,气泡照常 bail",
);

// 比较器放行之后,气泡确实把新的解析状态画出来。
const markup = renderToStaticMarkup(<UserMessageBubble text="读一下校验码" attachments={parsed} />);
assert.match(markup, /已解析/u, "解析完成的文件卡片显示已解析");
assert.doesNotMatch(
	renderToStaticMarkup(<UserMessageBubble text="读一下校验码" attachments={pending} />),
	/已解析/u,
	"还没有解析状态时文件卡片不显示状态",
);
assert.match(
	renderToStaticMarkup(<UserMessageBubble text="读一下校验码" attachments={failed} />),
	/解析失败/u,
	"解析失败的文件卡片显示解析失败",
);

console.log("User attachment parse status reaches the chat bubble within the same turn");
