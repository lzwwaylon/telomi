import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ActivityItem } from "@/features/goals/data/types";
import { OverlayContext, type OverlayContextValue } from "@/app/overlays/OverlayContext";
import { TerminalOverlay, type TerminalToolKind } from "@/app/overlays/TerminalOverlay";
import { CodeOverlay } from "@/app/overlays/CodeOverlay";
import { DiffOverlay, type DiffChange } from "@/app/overlays/DiffOverlay";
import { JsonOverlay } from "@/app/overlays/JsonOverlay";
import { GenericOverlay } from "@/app/overlays/GenericOverlay";
import { MarkdownOverlay } from "@/app/overlays/MarkdownOverlay";
import { looksLikeMarkdown } from "@/app/overlays/tool-output";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

interface TerminalState {
	type: "terminal";
	kind: TerminalToolKind;
	command: string;
	output: string;
	exitCode?: number;
	description?: string;
	error?: string;
}

interface CodeState {
	type: "code";
	mode: "read" | "write";
	filePath: string;
	content: string;
	error?: string;
}

interface DiffState {
	type: "diff";
	filePath: string;
	changes: DiffChange[];
	error?: string;
}

interface JsonState {
	type: "json";
	title: string;
	subtitle?: string;
	value: unknown;
	error?: string;
}

interface GenericState {
	type: "generic";
	toolName: string;
	input: Record<string, unknown> | undefined;
	output: string | undefined;
	outputDetails?: unknown;
	images?: ResultImage[];
	error?: string;
	renderOutputAsMarkdown?: boolean;
	markdownInputField?: { key: string; content: string };
}

interface MarkdownState {
	type: "markdown";
	title: string;
	subtitle?: string;
	content: string;
	error?: string;
}

type OverlayState =
	| TerminalState
	| CodeState
	| DiffState
	| JsonState
	| GenericState
	| MarkdownState
	| null;

function getString(input: Record<string, unknown> | undefined, key: string): string | undefined {
	const v = input?.[key];
	return typeof v === "string" ? v : undefined;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function resultText(result: ToolResult | undefined): string {
	if (!result) return "";
	return result.content
		.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

interface ResultImage {
	data: string;
	mimeType: string;
}

function resultImages(result: ToolResult | undefined): ResultImage[] {
	if (!result) return [];
	const out: ResultImage[] = [];
	for (const c of result.content) {
		if (c.type === "image" && typeof (c as { data?: unknown }).data === "string") {
			const img = c as { data: string; mimeType?: string };
			out.push({ data: img.data, mimeType: img.mimeType ?? "image/png" });
		}
	}
	return out;
}

function resultError(result: ToolResult | undefined): string | undefined {
	if (!result || !result.isError) return undefined;
	const text = resultText(result).trim();
	return text || "Tool error";
}

// telomi's bash tool throws "Command exited with code N" on non-zero exit
// (server/main-agent/tools/bash.ts). Recover that N for the overlay subtitle so the
// user sees 137 (OOM) / 130 (Ctrl+C) etc. instead of a flat "exit 1".
const BASH_EXIT_RE = /Command exited with code (-?\d+)\s*$/;
function bashExitCode(result: ToolResult | undefined, hasError: boolean): number | undefined {
	if (!result) return undefined;
	if (!hasError) return 0;
	const m = resultText(result).match(BASH_EXIT_RE);
	if (m) {
		const n = Number.parseInt(m[1], 10);
		if (Number.isFinite(n)) return n;
	}
	return 1;
}

function activityToOverlay(
	activity: ActivityItem,
	result: ToolResult | undefined,
): OverlayState {
	if (activity.type === "intermediate" || activity.type === "thinking") {
		const content = activity.content ?? "";
		if (!content) return null;
		return {
			type: "markdown",
			title: activity.type === "thinking" ? "Thinking" : "Assistant",
			content,
			error: activity.error,
		};
	}
	if (activity.type !== "tool" || !activity.toolName) return null;
	const name = activity.toolName.toLowerCase();
	const input = activity.toolInput as Record<string, unknown> | undefined;
	const error = resultError(result) ?? activity.error;
	const output = resultText(result);

	if (name === "bash") {
		const command = getString(input, "command") ?? "";
		const description = getString(input, "description");
		return {
			type: "terminal",
			kind: "bash",
			command,
			output,
			exitCode: bashExitCode(result, Boolean(error)),
			description,
			error,
		};
	}

	if (name === "grep") {
		const pattern = getString(input, "pattern") ?? "";
		const path = getString(input, "path") ?? getString(input, "glob") ?? "";
		const command = path ? `${pattern}  in  ${path}` : pattern;
		return {
			type: "terminal",
			kind: "grep",
			command,
			output,
			description: getString(input, "output_mode"),
			error,
		};
	}

	if (name === "glob") {
		const pattern = getString(input, "pattern") ?? "";
		const path = getString(input, "path") ?? "";
		const command = path ? `${pattern}  under  ${path}` : pattern;
		return {
			type: "terminal",
			kind: "glob",
			command,
			output,
			error,
		};
	}

	if (name === "read") {
		const filePath = getString(input, "file_path") ?? getString(input, "path") ?? "";
		return {
			type: "code",
			mode: "read",
			filePath,
			content: output,
			error,
		};
	}

	if (name === "write") {
		const filePath = getString(input, "file_path") ?? getString(input, "path") ?? "";
		const content = getString(input, "content") ?? output;
		return {
			type: "code",
			mode: "write",
			filePath,
			content,
			error,
		};
	}

	if (name === "edit") {
		const filePath = getString(input, "file_path") ?? getString(input, "path") ?? "";
		const original = getString(input, "old_string") ?? "";
		const modified = getString(input, "new_string") ?? "";
		return {
			type: "diff",
			filePath,
			changes: [
				{ id: activity.id, filePath, original, modified },
			],
			error,
		};
	}

	if (name === "multi_edit" || name === "multiedit") {
		const filePath = getString(input, "file_path") ?? getString(input, "path") ?? "";
		const editsRaw = input?.edits;
		const edits = Array.isArray(editsRaw) ? (editsRaw as Array<Record<string, unknown>>) : [];
		const changes: DiffChange[] = edits.map((edit, i) => ({
			id: `${activity.id}:${i}`,
			filePath,
			original: typeof edit.old_string === "string" ? edit.old_string : "",
			modified: typeof edit.new_string === "string" ? edit.new_string : "",
		}));
		return {
			type: "diff",
			filePath,
			changes,
			error,
		};
	}

	if (name === "todowrite" || name === "todos") {
		const todosRaw = input?.todos;
		if (Array.isArray(todosRaw) && todosRaw.length > 0) {
			const lines = todosRaw.map((todo) => {
				const obj = (todo ?? {}) as Record<string, unknown>;
				const status = typeof obj.status === "string" ? obj.status : "pending";
				const content = typeof obj.content === "string" ? obj.content : "";
				const activeForm = typeof obj.activeForm === "string" ? obj.activeForm : undefined;
				const box =
					status === "completed"
						? "[x]"
						: status === "in_progress"
							? "[~]"
							: status === "interrupted"
								? "[!]"
								: "[ ]";
				const text = status === "in_progress" && activeForm ? activeForm : content;
				return `- ${box} ${text}`;
			});
			return {
				type: "markdown",
				title: "TodoWrite",
				subtitle: `${todosRaw.length} item${todosRaw.length === 1 ? "" : "s"}`,
				content: lines.join("\n"),
				error,
			};
		}
		return {
			type: "json",
			title: "TodoWrite",
			subtitle: undefined,
			value: input,
			error,
		};
	}

		const docToolNames = new Set([
			"extract_document",
			"extract-document",
		]);
	const renderAsMarkdown =
		docToolNames.has(name) || looksLikeMarkdown(output);
	const markdownInputField = pickMarkdownInputField(name, input);

	return {
		type: "generic",
		toolName: activity.toolName,
		input,
		output,
		outputDetails: result?.details,
		images: resultImages(result),
		error,
		renderOutputAsMarkdown: renderAsMarkdown,
		markdownInputField,
	};
}

// Tools whose input carries a single big string field that is itself markdown.
// We render that one field as markdown; the remaining fields stay JSON.
const MARKDOWN_INPUT_FIELDS: Record<string, readonly string[]> = {
	memory: ["value", "content"],
};

function pickMarkdownInputField(
	toolName: string,
	input: Record<string, unknown> | undefined,
): { key: string; content: string } | undefined {
	if (!input) return undefined;
	const keys = MARKDOWN_INPUT_FIELDS[toolName.toLowerCase()];
	if (!keys) return undefined;
	for (const key of keys) {
		const v = input[key];
		if (typeof v === "string" && v.length > 80) return { key, content: v };
	}
	return undefined;
}


export function OverlayProvider({
	children,
	toolResultMap,
}: {
	children: ReactNode;
	toolResultMap: Map<string, ToolResult>;
}) {
	const [state, setState] = useState<OverlayState>(null);

	const close = useCallback(() => setState(null), []);

	const openActivity = useCallback(
		(activity: ActivityItem) => {
			const result = activity.toolUseId ? toolResultMap.get(activity.toolUseId) : undefined;
			const next = activityToOverlay(activity, result);
			if (next) setState(next);
		},
		[toolResultMap],
	);

	const openMarkdown = useCallback((title: string, value: unknown) => {
		const content = typeof value === "string" ? value : safeStringify(value);
		setState({ type: "markdown", title, content });
	}, []);

	const openJson = useCallback((title: string, value: unknown, subtitle?: string) => {
		setState({ type: "json", title, subtitle, value });
	}, []);

	const openDiff = useCallback((filePath: string, changes: DiffChange[]) => {
		setState({ type: "diff", filePath, changes });
	}, []);

	const value = useMemo<OverlayContextValue>(
		() => ({ openActivity, openMarkdown, openJson, openDiff, close }),
		[openActivity, openMarkdown, openJson, openDiff, close],
	);

	return (
		<OverlayContext.Provider value={value}>
			{children}
			{state?.type === "terminal" && (
				<TerminalOverlay
					open
					onClose={close}
					kind={state.kind}
					command={state.command}
					output={state.output}
					exitCode={state.exitCode}
					description={state.description}
					error={state.error}
				/>
			)}
			{state?.type === "code" && (
				<CodeOverlay
					open
					onClose={close}
					mode={state.mode}
					filePath={state.filePath}
					content={state.content}
					error={state.error}
				/>
			)}
			{state?.type === "diff" && (
				<DiffOverlay
					open
					onClose={close}
					filePath={state.filePath}
					changes={state.changes}
					error={state.error}
				/>
			)}
			{state?.type === "json" && (
				<JsonOverlay
					open
					onClose={close}
					title={state.title}
					subtitle={state.subtitle}
					value={state.value}
					error={state.error}
				/>
			)}
			{state?.type === "generic" && (
				<GenericOverlay
					open
					onClose={close}
					toolName={state.toolName}
					input={state.input}
					output={state.output}
					outputDetails={state.outputDetails}
					images={state.images}
					error={state.error}
					renderOutputAsMarkdown={state.renderOutputAsMarkdown}
					markdownInputField={state.markdownInputField}
				/>
			)}
			{state?.type === "markdown" && (
				<MarkdownOverlay
					open
					onClose={close}
					title={state.title}
					subtitle={state.subtitle}
					content={state.content}
					error={state.error}
				/>
			)}
		</OverlayContext.Provider>
	);
}
