import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMessageBubble } from "../../web/src/features/chat/UserMessageBubble.js";
import { MarkdownView } from "../../web/src/shared/markdown/MarkdownView.js";

function bubbleText(text: string): string {
	const html = renderToStaticMarkup(<UserMessageBubble text={text} />);
	assert.match(html, /whitespace-pre-wrap/u, "用户文本必须落在 pre-wrap 容器里才能显示换行");
	const body = /whitespace-pre-wrap">([\s\S]*?)<\/div>/u.exec(html);
	assert.ok(body, "用户文本容器缺失");
	return body[1].replaceAll("&#x27;", "'").replaceAll("&quot;", '"')
		.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

// 常见的消息形状:一个段落 + 空行 + 三行单换行分隔的条目。
const composed = [
	"关于这个主题,我主要关注近两年的公开进展和主流方法。",
	"",
	"数据: 更关心公开数据集。",
	"评估: 关注可复现的评测。",
	"部署: 本地和云端都可以。",
].join("\n");
assert.equal(bubbleText(composed), composed, "单换行与空行都按输入原样保留");

// 看起来像 Markdown 的输入同样原样显示:紧凑列表的续行不会被合并,
// 标记字符也不会被解析掉。
const markdownish = "- first\n  continuation\n- second\n\n**强调** 与 `代码`";
assert.equal(bubbleText(markdownish), markdownish);

// Agent 回复继续走 Markdown 渲染。
const agent = renderToStaticMarkup(
	<MarkdownView mode="chat" text={"| a | b |\n| --- | --- |\n| 1 | 2 |"} />,
);
assert.match(agent, /<table/u);

console.log("User message line breaks and Agent Markdown rendering passed");
