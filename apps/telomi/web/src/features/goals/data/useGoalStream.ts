import { useCallback, useEffect, useRef, useState } from "react";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { LiveSession } from "@/features/goals/data/LiveSession";
import type { GoalSnapshot, SendMessageRequest, SendMessageResult } from "@shared/types";
import type { ConnectionState } from "@/features/goals/data/types";

export interface UseGoalStream {
	snapshot: GoalSnapshot | null;
	connection: ConnectionState;
	sendMessage: (body: SendMessageRequest) => Promise<SendMessageResult>;
	abort: () => Promise<void>;
	setModel: (modelId: string) => Promise<void>;
	setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
}

/**
 * Subscribe to a goal's live stream. Passing `null` / empty string returns an
 * idle shell — useful when the UI hasn't picked a goal yet.
 */
export function useGoalStream(goalId: string | null): UseGoalStream {
	const [snapshot, setSnapshot] = useState<GoalSnapshot | null>(null);
	const [connection, setConnection] = useState<ConnectionState>({ kind: "idle" });
	const sessionRef = useRef<LiveSession | null>(null);

	useEffect(() => {
		if (!goalId) {
			setSnapshot(null);
			setConnection({ kind: "idle" });
			return;
		}
		const session = new LiveSession(goalId);
		sessionRef.current = session;
		const offSnap = session.onSnapshot((s) => setSnapshot(s));
		const offConn = session.onConnection((c) => setConnection(c));
		session.init().catch((err) => {
			console.error("[useGoalStream] init failed", err);
		});
		return () => {
			offSnap();
			offConn();
			session.disconnect();
			if (sessionRef.current === session) sessionRef.current = null;
		};
	}, [goalId]);

	const sendMessage = useCallback(async (body: SendMessageRequest) => {
		const session = sessionRef.current;
		if (!session) throw new Error("No active goal session");
		return session.sendMessage(body);
	}, []);

	const abort = useCallback(async () => {
		const session = sessionRef.current;
		if (!session) return;
		await session.abort();
	}, []);

	const setModel = useCallback(async (modelId: string) => {
		const session = sessionRef.current;
		if (!session) throw new Error("No active goal session");
		await session.setModel(modelId);
	}, []);

	const setThinkingLevel = useCallback(async (level: ThinkingLevel) => {
		const session = sessionRef.current;
		if (!session) throw new Error("No active goal session");
		await session.setThinkingLevel(level);
	}, []);

	return { snapshot, connection, sendMessage, abort, setModel, setThinkingLevel };
}
