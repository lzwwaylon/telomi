import assert from "node:assert/strict";
import test from "node:test";
import { placeGraphLabels } from "../../web/src/features/wiki/wiki-graph-labels.ts";

test("graph labels prioritize interaction, avoid overlaps and remain inside the viewport", () => {
	const bounds = { left: 0, top: 0, right: 200, bottom: 100 };
	const node = { x: 100, y: 50, radius: 5, width: 100, height: 12, priority: 1, importance: 0 };
	const labels = [
		{ ...node, id: "ordinary" },
		{ ...node, id: "selected", priority: 4 },
		{ ...node, id: "hovered", priority: 5 },
		{ ...node, id: "offscreen", x: -10, priority: 5 },
	];
	const placed = placeGraphLabels(labels, bounds, 4);
	assert.deepEqual(placed.map((label) => label.id), ["hovered", "selected"]);
	assert.ok(placed[1].y + placed[1].height + 4 <= placed[0].y);
	const edge = placeGraphLabels([{ ...node, id: "edge", x: 195, y: 95 }], bounds, 4)[0];
	assert.equal(edge.x + edge.width, bounds.right);
	assert.ok(edge.y + edge.height < 95);
	const expanded = placeGraphLabels(labels.slice(0, 3).map((label, index) => ({ ...label, x: 30 + index * 70, width: 40 })), bounds, 4);
	assert.equal(expanded.length, 3, "more labels fit once nodes separate with zoom");
	const toolbar = { left: 0, top: 0, right: 200, bottom: 65 };
	assert.equal(placeGraphLabels(labels, bounds, 4, [toolbar]).length, 0, "labels do not paint beneath graph controls");
});
