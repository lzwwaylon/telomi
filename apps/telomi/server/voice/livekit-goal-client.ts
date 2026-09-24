import type {
	LiveKitGoalReplyEvent,
	LiveKitGoalReplyRequest,
} from "../../shared/voice-livekit.js";
import type { LiveKitVoiceConfig } from "./livekit-config.js";

export class LiveKitGoalClient {
	constructor(
		private readonly config: Pick<
			LiveKitVoiceConfig,
			"telomiUrl" | "bridgeSecret"
		>,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async captureVoiceContext(goalId: string): Promise<string> {
		const response = await this.fetchImpl(`${this.config.telomiUrl}/api/goals/${encodeURIComponent(goalId)}/voice/context-snapshots`, { method: "POST" });
		if (!response.ok) throw new Error(`Voice context capture failed: HTTP ${response.status}`);
		const body = await response.json() as { contextSnapshotId?: string };
		if (!body.contextSnapshotId) throw new Error("Voice context capture returned no identity");
		return body.contextSnapshotId;
	}

	async transcribeVoiceInput(
		goalId: string,
		wav: Uint8Array,
		signal?: AbortSignal,
		contextSnapshotId?: string,
	): Promise<string> {
		const query = new URLSearchParams();
		if (contextSnapshotId) query.set("contextSnapshotId", contextSnapshotId);
		const response = await this.fetchImpl(
			`${this.config.telomiUrl}/api/goals/${encodeURIComponent(goalId)}/voice/transcribe${query.size ? `?${query}` : ""}`,
			{
				method: "POST",
				signal,
				headers: { "Content-Type": "audio/wav" },
				body: Uint8Array.from(wav).buffer,
			},
		);
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(
				`Telomi voice input returned HTTP ${response.status}: ${detail.slice(0, 400)}`,
			);
		}
		const body = (await response.json()) as { text?: unknown };
		if (typeof body.text !== "string") {
			throw new Error("Telomi voice input returned an invalid transcript");
		}
		return body.text.trim();
	}

	async *streamReply(
		goalId: string,
		transcript: string,
		signal?: AbortSignal,
	): AsyncIterable<string> {
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		try {
			const body: LiveKitGoalReplyRequest = { transcript };
			const response = await this.fetchImpl(
				`${this.config.telomiUrl}/api/internal/livekit/goals/${encodeURIComponent(goalId)}/reply`,
				{
					method: "POST",
					signal: controller.signal,
					headers: {
						Authorization: `Bearer ${this.config.bridgeSecret}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
			if (!response.ok || !response.body) {
				const detail = await response.text().catch(() => "");
				throw new Error(
					`Pi Goal Agent bridge returned HTTP ${response.status}: ${detail.slice(0, 400)}`,
				);
			}

			for await (const event of readNdjson<LiveKitGoalReplyEvent>(
				response.body,
			)) {
				if (event.type === "text.delta" && event.delta) {
					yield event.delta;
				}
			}
		} finally {
			signal?.removeEventListener("abort", abort);
			controller.abort();
		}
	}
}

async function* readNdjson<T>(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<T> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const line = pending.slice(0, newline).trim();
				pending = pending.slice(newline + 1);
				if (line) yield JSON.parse(line) as T;
				newline = pending.indexOf("\n");
			}
		}
		pending += decoder.decode();
		if (pending.trim()) yield JSON.parse(pending) as T;
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
