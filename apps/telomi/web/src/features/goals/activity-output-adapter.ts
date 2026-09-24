import type { ActivityOutput, ActivityOutputLine } from "@shared/events/activity-projection";
import type { ActivityItem } from "@/features/goals/data/types";

export function activityOutputItems(output: ActivityOutput): ActivityItem[] {
	return output.lines.map((line, index) => activityOutputItem(
		line,
		output.lifecycle === "running",
		index === output.lines.length - 1,
	));
}

/** One finished line on its own, such as a line re-read in full for its details overlay. */
export function activityOutputLineItem(line: ActivityOutputLine): ActivityItem {
	return activityOutputItem(line, false, false);
}

function activityOutputItem(line: ActivityOutputLine, running: boolean, isTail: boolean): ActivityItem {
	const timestamp = line.at ? Date.parse(line.at) : line.sequence;
	if (line.kind === "tool" && line.toolName) {
		const id = line.toolCallId || `trace-tool-${line.sequence}`;
		return {
			id,
			type: "tool",
			status: line.isError ? "error" : line.toolOutput === undefined && running ? "running" : "completed",
			toolName: line.toolName,
			toolUseId: id,
			toolInput: line.toolInput,
			toolResult: line.toolOutput === undefined ? undefined : {
				role: "toolResult",
				toolCallId: id,
				toolName: line.toolName,
				content: [{ type: "text", text: line.toolOutput }],
				...(line.toolDetails !== undefined ? { details: line.toolDetails } : {}),
				isError: line.isError === true,
				timestamp,
			},
			timestamp,
			error: line.isError ? line.toolOutput || "Tool failed" : undefined,
		};
	}

	const content = traceBody(line.text);
	return {
		id: `trace-${line.sequence}`,
		type: line.kind === "thinking" ? "thinking" : line.kind === "status" ? "status" : "intermediate",
		status: running && isTail ? "running" : "completed",
		content,
		timestamp,
	};
}

function traceBody(text: string): string {
	const newline = text.indexOf("\n");
	return newline < 0 ? text : text.slice(newline + 1).trim();
}
