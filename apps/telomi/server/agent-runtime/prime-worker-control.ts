import { on } from "node:events";

import { isRecord } from "../lib/values.js";

interface PrimeWorkerSession {
	abort(): Promise<void>;
	disposeAsync(): Promise<void>;
}

/** Host cancellation must enter Prime before its process-level Kernel signal handler. */
export function createPrimeWorkerControl() {
	const controller = new AbortController();
	let session: PrimeWorkerSession | undefined;
	let stopping: Promise<void> | undefined;
	const abort = () => {
		if (!session) return Promise.resolve();
		return stopping ??= session.abort().catch(() => undefined);
	};
	const cancel = () => {
		controller.abort();
		void abort();
	};
	const receive = (message: unknown) => {
		if (isRecord(message) && message.type === "prime_worker_cancel") cancel();
	};
	process.on("message", receive);
	process.on("disconnect", cancel);
	if (process.connected) process.send?.({ type: "prime_worker_ready" }, () => undefined);
	return {
		signal: controller.signal,
		registerSession(value: PrimeWorkerSession) {
			session = value;
			if (controller.signal.aborted) void abort();
		},
		abort,
		async dispose() {
			try {
				await abort();
				await session?.disposeAsync();
			} finally {
				process.off("message", receive);
				process.off("disconnect", cancel);
				// Removing the listeners unrefs IPC, while preserving final failure reports before exit.
			}
		},
	};
}

/** Cancellation also releases Workers waiting for host output validation. */
export async function requestPrimeOutputValidation(submission: number, signal: AbortSignal): Promise<{ accepted: boolean; error?: string }> {
	signal.throwIfAborted();
	if (!process.send || !process.connected) throw new Error("Prime Worker requires a Runtime validation channel");
	const replies = on(process, "message", { signal, close: ["disconnect"] });
	try {
		process.send({ type: "stage_output_candidate", submission });
		for await (const [message] of replies) {
			if (!isRecord(message) || message.type !== "stage_output_validation" || message.submission !== submission) continue;
			return { accepted: message.accepted === true, ...(typeof message.error === "string" ? { error: message.error } : {}) };
		}
		throw new Error("Runtime validation channel closed");
	} finally {
		await replies.return?.();
	}
}
