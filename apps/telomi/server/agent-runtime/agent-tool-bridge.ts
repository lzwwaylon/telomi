import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { toErrorMessage } from "../lib/values.js";

export interface AgentToolBridge {
	baseUrl: string;
	token: string;
	calls(): Record<string, number>;
	close(): Promise<void>;
}

export interface AgentToolBridgeCall {
	operation: string;
	args: unknown;
	value: unknown;
}

/**
 * 一个只监听回环地址、带 Bearer token 的单端点桥。Prime Worker 在沙箱里没有网络，
 * 也拿不到进程内的 AgentTool；它通过这个桥调用 Runtime 持有的只读能力，
 * 每次调用追加到 JSONL 日志，成为该 Agent 的知识消费证据。外部状态无法从 Case 的
 * 其他部分重建的 Agent（例如读长期用户记忆的 Research Schedule Reviewer）用
 * `recordAnswers` 把答案一起记下来，Candidate Replay 因此可以冻结它看到的世界。
 */
export async function startAgentToolBridge(
	path: string,
	logPath: string,
	execute: (body: Record<string, unknown>) => Promise<AgentToolBridgeCall>,
	options: { recordAnswers?: boolean } = {},
): Promise<AgentToolBridge> {
	const token = randomBytes(32).toString("base64url");
	const counts: Record<string, number> = {};
	const server = createServer(async (request, response) => {
		try {
			if (request.method !== "POST" || request.url !== path) return send(response, 404, { error: "not_found" });
			if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "unauthorized" });
			const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
			const result = await execute(body);
			counts[result.operation] = (counts[result.operation] ?? 0) + 1;
			appendFileSync(logPath, `${JSON.stringify({
				timestamp: new Date().toISOString(),
				operation: result.operation,
				args: result.args,
				...(options.recordAnswers ? { result: result.value } : {}),
			})}\n`);
			send(response, 200, result.value);
		} catch (error) {
			send(response, 422, { error: toErrorMessage(error) });
		}
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Agent Tool bridge did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		token,
		calls: () => ({ ...counts }),
		close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
	};
}

/** Reads back what one execution asked the bridge and what it answered. */
export function readAgentToolBridgeCalls(logPath: string): AgentToolBridgeCall[] {
	let content: string;
	try {
		content = readFileSync(logPath, "utf-8");
	} catch {
		return [];
	}
	return content.split("\n").filter(Boolean).flatMap((line) => {
		try {
			const value = JSON.parse(line) as { operation?: unknown; args?: unknown; result?: unknown };
			return typeof value.operation === "string"
				? [{ operation: value.operation, args: value.args, value: value.result }]
				: [];
		} catch {
			// Ignore an incomplete terminal bridge log line.
			return [];
		}
	});
}

export function bridgeString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	return value.trim();
}

export function bridgePositiveInteger(value: unknown, label: string, maximum: number): number {
	if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
		throw new Error(`${label} must be an integer from 1 to ${maximum}`);
	}
	return Number(value);
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const value of request) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		length += chunk.length;
		if (length > 1_000_000) throw new Error("Agent Tool bridge request exceeds 1 MB");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

function send(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}
