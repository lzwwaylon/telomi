import { apiClient } from "@/shared/lib/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Monitor, MousePointer2, Wifi, WifiOff } from "lucide-react";
import { BrowserIcon, CloseIcon as X } from "@/shared/ui/icons";

import { webSocketUrl } from "@/shared/lib/api";
import { decodeFrame, sendKey, sendMouse, sendWheel } from "@/shared/lib/browser-input";
import { cn } from "@/shared/lib/utils";
import type { GoalSummary } from "@shared/types";
import { uiText } from "@/app/ui-text";

type BrowserControl = "agent" | "delegating" | "user";
type BrowserSessionState = "queued" | "starting" | "live";

interface BrowserSession {
	goalId: string;
	sessionId: string;
	runId: string;
	startedAt: string;
	live: boolean;
	state: BrowserSessionState;
	url?: string;
	title?: string;
	control: BrowserControl;
}

interface BrowserFrame {
	seq: number;
	data: string;
	mimeType: string;
	source: "snapshot" | "stream";
}

interface BrowserAction {
	id: string;
	action: string;
	state: "running" | "succeeded" | "failed";
	durationMs?: number;
}

/** Live Browser Sessions. With `goalId` only that Goal's sessions show; without it (home) every Goal's. */
export function BrowserHub({ goals, goalId = null }: { goals: GoalSummary[]; goalId?: string | null }) {
	const [sessions, setSessions] = useState<BrowserSession[]>([]);
	const [open, setOpen] = useState(false);
	const liveCount = sessions.filter((session) => session.state === "live").length;
	const queuedCount = sessions.filter((session) => session.state === "queued").length;
	const wrapRef = useRef<HTMLDivElement>(null);
	const refresh = useCallback(async () => {
		const body = await apiClient.get<{ sessions?: Array<Omit<BrowserSession, "goalId"> & { goalId?: string }> }>(
			goalId ? `/api/goals/${encodeURIComponent(goalId)}/browser-sessions` : "/api/browser-sessions",
		);
		// Stable card order: the registry lists sessions per goal, which reshuffles cards as tasks end.
		setSessions((body.sessions ?? [])
			.map((session) => ({ ...session, goalId: session.goalId ?? goalId ?? "" }))
			.sort((left, right) => left.startedAt.localeCompare(right.startedAt)));
	}, [goalId]);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				if (active) await refresh();
			} catch {
				/* The global connection banner already reports backend loss. */
			}
		};
		void load();
		const timer = window.setInterval(() => void load(), 1_000);
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, [refresh]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return;
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div className="browser-hub" ref={wrapRef}>
			<button
				type="button"
				className={cn("browser-hub-trigger", open && "is-open", sessions.length > 0 && "is-running")}
				onClick={() => setOpen((current) => !current)}
				aria-label={sessions.length
					? uiText("goals.browsermonitor.agentBrowserLiveRunningQueuedWaiting", { live: liveCount, queued: queuedCount })
					: "Agent Browser"}
				aria-expanded={open}
				data-testid="topbar-browser"
			>
				<BrowserIcon className="h-4 w-4" aria-hidden />
				{sessions.length > 0 && <span data-testid="browser-count-badge">{liveCount > 0 ? (liveCount > 9 ? "9+" : liveCount) : "…"}</span>}
			</button>
			{open && (
				<section className="browser-hub-panel" role="dialog" aria-labelledby="browser-hub-title" data-testid="browser-hub-panel">
					<header>
						<div>
							<span>Agent Browser</span>
							<h2 id="browser-hub-title">{uiText("goals.browsermonitor.liveBrowserSessions")}</h2>
						</div>
						<div className="browser-hub-panel-meta">
							<small>{uiText("common.countRunning", { count: liveCount })}{queuedCount > 0 ? ` · ${uiText("goals.browsermonitor.countWaiting", { count: queuedCount })}` : ""}</small>
							<button type="button" onClick={() => setOpen(false)} aria-label={uiText("goals.browsermonitor.closeLiveBrowserSessions")}><X size={15} /></button>
						</div>
					</header>
					{sessions.length === 0 ? (
						<div className="browser-hub-empty"><BrowserIcon size={22} aria-hidden />{uiText("goals.browsermonitor.noAgentBrowserSessionsAreRunning")}</div>
					) : (
						<div className="browser-hub-grid">
							{sessions.map((session, index) => (
								<article className="browser-session-card" key={session.sessionId} data-testid="browser-monitor">
									<header>
										<div><b>{goals.find((goal) => goal.id === session.goalId)?.title ?? "Goal"}</b><small>Browser {index + 1}</small></div>
										<span className="browser-session-live" data-state={session.state}><i />{sessionStateLabel(session.state)}</span>
									</header>
									<BrowserViewport goalId={session.goalId} session={session} onRefresh={refresh} />
								</article>
							))}
						</div>
					)}
				</section>
			)}
		</div>
	);
}

function BrowserViewport({
	goalId,
	session,
	onRefresh,
}: {
	goalId: string;
	session: BrowserSession;
	onRefresh: () => Promise<void>;
}) {
	const socketRef = useRef<WebSocket | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const latestStreamFrameRef = useRef(0);
	// CSS viewport of the Agent page. Frames are device pixels (2x on HiDPI); input is CSS pixels.
	const viewportRef = useRef({ width: 1280, height: 720 });
	const [connected, setConnected] = useState(false);
	const [browserConnected, setBrowserConnected] = useState(false);
	const [screencasting, setScreencasting] = useState(false);
	const [streamError, setStreamError] = useState<string | null>(null);
	const [pageUrl, setPageUrl] = useState<string | null>(null);
	const [hasFrame, setHasFrame] = useState(false);
	const [actions, setActions] = useState<BrowserAction[]>([]);
	const [changingControl, setChangingControl] = useState(false);
	const [controlError, setControlError] = useState<string | null>(null);
	const send = useCallback((message: Record<string, unknown>) => {
		if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message));
	}, []);
	const drawFrame = useCallback(async (frame: BrowserFrame, socket: WebSocket) => {
		const isCurrent = () => socketRef.current === socket && socket.readyState === WebSocket.OPEN;
		if (!isCurrent()) return;
		if (frame.source === "snapshot" && latestStreamFrameRef.current > 0) return;
		try {
			const bitmap = await decodeFrame(frame.data, frame.mimeType);
			const canvas = canvasRef.current;
			if (!isCurrent() || !canvas || (frame.source === "snapshot" && latestStreamFrameRef.current > 0)
				|| (frame.source === "stream" && frame.seq < latestStreamFrameRef.current)) {
				bitmap.close();
				return;
			}
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext("2d");
			if (context) {
				context.imageSmoothingEnabled = true;
				context.imageSmoothingQuality = "high";
				context.drawImage(bitmap, 0, 0);
				// A received but undecodable frame must not suppress the seed screenshot.
				if (frame.source === "stream") {
					latestStreamFrameRef.current = frame.seq;
					setStreamError(null);
				}
				setHasFrame(true);
			}
			bitmap.close();
		} catch {
			if (isCurrent() && (frame.source === "stream" || latestStreamFrameRef.current === 0)) {
				setStreamError(uiText("goals.browsermonitor.frameDecodeFailed"));
			}
		} finally {
			// ACK the connection that supplied the frame, never a replacement connection.
			if (frame.source === "stream" && isCurrent()) socket.send(JSON.stringify({ type: "ack", seq: frame.seq }));
		}
	}, []);

	useEffect(() => {
		if (session.state !== "live") return;
		let disposed = false;
		let retry: number | undefined;
		const connect = () => {
			if (disposed) return;
			latestStreamFrameRef.current = 0;
			setHasFrame(false);
			setBrowserConnected(false);
			setScreencasting(false);
			const socket = new WebSocket(webSocketUrl(
				`/api/goals/${encodeURIComponent(goalId)}/browser-sessions/${encodeURIComponent(session.sessionId)}/stream`,
			));
			socketRef.current = socket;
			socket.onopen = () => {
				if (disposed || socketRef.current !== socket) return;
				setConnected(true);
				setStreamError(null);
				socket.send(JSON.stringify({ type: "config", pacing: "ack", maxFps: 30 }));
			};
			socket.onmessage = (event) => {
				if (disposed || socketRef.current !== socket) return;
				let message: Record<string, unknown>;
				try { message = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
				// Follow agent-browser Dashboard's separate transport/browser/screencast states:
				// https://github.com/vercel-labs/agent-browser/blob/v0.34.0/packages/dashboard/src/store/stream.ts
				if (message.type === "status") {
					setBrowserConnected(message.connected === true);
					setScreencasting(message.screencasting === true);
					if (typeof message.viewportWidth === "number" && typeof message.viewportHeight === "number") {
						viewportRef.current = { width: message.viewportWidth, height: message.viewportHeight };
					}
					if (message.connected !== true) setHasFrame(false);
				} else if (message.type === "url" && typeof message.url === "string") {
					setPageUrl(message.url);
				} else if (message.type === "control" && (message.control === "agent" || message.control === "user")) {
					setChangingControl(false);
					void onRefresh();
					if (message.control === "user") requestAnimationFrame(() => canvasRef.current?.focus());
				} else if (message.type === "control_error" && typeof message.message === "string") {
					setChangingControl(false);
					setControlError(message.message);
				} else if (message.type === "frame" && typeof message.data === "string" && typeof message.seq === "number") {
					void drawFrame({
						data: message.data,
						seq: message.seq,
						mimeType: typeof message.mimeType === "string" ? message.mimeType : "image/jpeg",
						source: message.source === "snapshot" ? "snapshot" : "stream",
					}, socket);
				} else if (message.type === "command" && typeof message.id === "string" && typeof message.action === "string") {
					const action: BrowserAction = {
						id: message.id as string,
						action: message.action as string,
						state: "running",
					};
					setActions((current) => [...current.filter((currentAction) => currentAction.id !== message.id), action].slice(-5));
				} else if (message.type === "result" && typeof message.id === "string" && typeof message.action === "string") {
					const action: BrowserAction = {
						id: message.id as string,
						action: message.action as string,
						state: message.success === true ? "succeeded" : "failed",
						durationMs: typeof message.durationMs === "number" ? message.durationMs : undefined,
					};
					setActions((current) => [...current.filter((currentAction) => currentAction.id !== message.id), action].slice(-5));
				}
			};
			socket.onclose = () => {
				if (disposed || socketRef.current !== socket) return;
				setConnected(false);
				setBrowserConnected(false);
				setScreencasting(false);
				setHasFrame(false);
				setStreamError(uiText("goals.browsermonitor.streamDisconnected"));
				setChangingControl(false);
				if (!disposed) retry = window.setTimeout(connect, 1_000);
			};
			socket.onerror = () => socket.close();
		};
		connect();
		return () => {
			disposed = true;
			if (retry !== undefined) window.clearTimeout(retry);
			socketRef.current?.close();
			socketRef.current = null;
			latestStreamFrameRef.current = 0;
			setConnected(false);
			setBrowserConnected(false);
			setScreencasting(false);
			setStreamError(null);
			setPageUrl(null);
			setHasFrame(false);
			setActions([]);
		};
	}, [drawFrame, goalId, onRefresh, session.sessionId, session.state]);

	const setControl = (control: "agent" | "user") => {
		setChangingControl(true);
		setControlError(null);
		send({ type: "control", control });
	};

	const userControls = session.control === "user" && connected && browserConnected && screencasting && hasFrame && !streamError;
	const viewStatus = streamError ?? (session.state === "queued"
		? uiText("goals.browsermonitor.waitingForBrowserResources")
		: session.state === "starting" ? uiText("goals.browsermonitor.browserWorkerIsStarting")
		: !connected ? uiText("goals.browsermonitor.streamConnecting")
		: !browserConnected ? uiText("goals.browsermonitor.browserDisconnected")
		: !screencasting ? uiText("goals.browsermonitor.screencastStarting")
		: !hasFrame ? uiText("goals.browsermonitor.waitingForLiveView") : null);
	return (
		<>
			<div className="browser-monitor-location" title={pageUrl ?? session.url}>
				{connected ? <Wifi size={12} /> : <WifiOff size={12} />}
				<span>{pageUrl || session.title || session.url || viewStatus}</span>
			</div>
			<div className={cn("browser-monitor-viewport", userControls && "is-controlled") }>
				<canvas
					ref={canvasRef}
					className={cn(!hasFrame && "is-waiting")}
					aria-label={uiText("goals.browsermonitor.browserPageCurrentlyControlledByTheAgent")}
					role="img"
					tabIndex={userControls && hasFrame ? 0 : -1}
					onPointerDown={userControls ? (event) => sendMouse(event, "mousePressed", send, viewportRef.current) : undefined}
					onPointerUp={userControls ? (event) => sendMouse(event, "mouseReleased", send, viewportRef.current) : undefined}
					onPointerMove={userControls ? (event) => {
						if (event.buttons) sendMouse(event, "mouseMoved", send, viewportRef.current);
					} : undefined}
					onWheel={userControls ? (event) => sendWheel(event, send, viewportRef.current) : undefined}
					onContextMenu={userControls ? (event) => event.preventDefault() : undefined}
					onKeyDown={userControls ? (event) => sendKey(event, "keyDown", send) : undefined}
					onKeyUp={userControls ? (event) => sendKey(event, "keyUp", send) : undefined}
				/>
				{!hasFrame && (
					<div className="browser-monitor-waiting" role="status"><Loader2 size={18} className="spin" />{viewStatus}</div>
				)}
				{userControls && <div className="browser-monitor-control-badge"><MousePointer2 size={11} />{uiText("goals.browsermonitor.youAreControllingTheBrowser")}</div>}
			</div>
			<div className="browser-monitor-toolbar">
				<span role={hasFrame && viewStatus ? "status" : undefined}>{viewStatus ?? (session.control === "delegating" ? uiText("goals.browsermonitor.waitingForTheAgentToFinishItsCurrentAction") : userControls ? uiText("goals.browsermonitor.theAgentHasPausedBrowserTool") : uiText("goals.browsermonitor.theAgentIsControllingTheBrowser"))}</span>
				<button
					type="button"
					disabled={!session.live || !connected || changingControl || session.control === "delegating"}
					onClick={() => setControl(session.control === "user" ? "agent" : "user")}
				>
					{changingControl ? <Loader2 size={12} className="spin" /> : userControls ? <Check size={12} /> : <MousePointer2 size={12} />}
					{session.control === "user" ? uiText("goals.browsermonitor.returnControlToAgent") : uiText("goals.browsermonitor.takeControl")}
				</button>
			</div>
			{controlError && <p className="browser-monitor-error" role="alert">{controlError}</p>}
			{actions.length > 0 && (
				<div className="browser-monitor-actions" aria-label={uiText("goals.browsermonitor.browserAgentActions")}>
					{actions.map((action) => (
						<div key={action.id} data-state={action.state}>
							{action.state === "running" ? <Loader2 size={11} className="spin" /> : action.state === "succeeded" ? <Check size={11} /> : <Monitor size={11} />}
							<span>{humanizeAction(action.action)}</span>
							{action.durationMs !== undefined && <small>{action.durationMs} ms</small>}
						</div>
					))}
				</div>
			)}
		</>
	);
}

function humanizeAction(action: string): string {
	return action.replaceAll("_", " ").replaceAll("-", " ");
}

function sessionStateLabel(state: BrowserSessionState): string {
	return state === "live" ? uiText("schedule.active") : state === "queued" ? uiText("goals.browsermonitor.waitingForResources") : uiText("common.starting");
}
