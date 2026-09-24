import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { SourceStatus, SourcesResponse } from "@shared/sources.js";

import { webSocketUrl } from "@/shared/lib/api";
import { apiClient } from "@/shared/lib/api-client";
import { decodeFrame, sendKey, sendMouse, sendWheel, type Viewport } from "@/shared/lib/browser-input";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/shared/ui/dialog";
import { BTN_PRIMARY } from "./settings-styles";
import type { SearchCredentialProviderStatus } from "./provider-config";

export interface BrowserLoginSource {
	id: string;
	name: string;
}

type SourcesPayload = SourcesResponse<SearchCredentialProviderStatus>;
type Phase = "connecting" | "login" | "verifying" | "result" | "error";

/**
 * Log in to the browser-backed sources inside Telomi's own browser without leaving this page. The
 * Runtime streams the login page of each source still to log in, one after another, and ends the
 * stream once every login exists; the sources are then checked and the outcome is all that is left.
 */
export function BrowserLoginDialog({
	open,
	sources,
	onClose,
	onVerified,
}: {
	open: boolean;
	sources: BrowserLoginSource[];
	onClose: () => void;
	onVerified: (next: SourcesPayload) => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const socketRef = useRef<WebSocket | null>(null);
	const viewportRef = useRef<Viewport>({ width: 880, height: 640 });
	const onVerifiedRef = useRef(onVerified);
	const [phase, setPhase] = useState<Phase>("connecting");
	const [hasFrame, setHasFrame] = useState(false);
	const [current, setCurrent] = useState<string | null>(null);
	const [result, setResult] = useState<Record<string, SourceStatus | null>>({});
	const [errorText, setErrorText] = useState<string | null>(null);
	useEffect(() => { onVerifiedRef.current = onVerified; }, [onVerified]);

	useEffect(() => {
		if (!open) return;
		let disposed = false;
		let latestSeq = 0;
		setPhase("connecting");
		setHasFrame(false);
		setCurrent(null);
		setResult({});
		setErrorText(null);
		const socket = new WebSocket(webSocketUrl("/api/sources/browser/login/stream"));
		socketRef.current = socket;
		socket.onmessage = (event) => {
			if (disposed) return;
			let message: Record<string, unknown>;
			try { message = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
			if (message.type === "status") {
				if (typeof message.viewportWidth === "number" && typeof message.viewportHeight === "number") {
					viewportRef.current = { width: message.viewportWidth, height: message.viewportHeight };
				}
			} else if (message.type === "login" && typeof message.sourceId === "string") {
				setCurrent(message.sourceId);
				setPhase("login");
			} else if (message.type === "frame" && typeof message.data === "string" && typeof message.seq === "number") {
				const seq = message.seq;
				void decodeFrame(message.data, typeof message.mimeType === "string" ? message.mimeType : "image/jpeg").then((bitmap) => {
					const canvas = canvasRef.current;
					if (disposed || !canvas || seq < latestSeq) { bitmap.close(); return; }
					latestSeq = seq;
					canvas.width = bitmap.width;
					canvas.height = bitmap.height;
					canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
					bitmap.close();
					setHasFrame((had) => {
						if (!had) requestAnimationFrame(() => canvas.focus());
						return true;
					});
				}).catch(() => undefined);
			} else if (message.type === "done") {
				setPhase("verifying");
				void apiClient.post<SourcesPayload>("/api/sources/verify").then((next) => {
					if (disposed) return;
					onVerifiedRef.current(next);
					setResult(Object.fromEntries(next.sources.filter((source) => source.auth === "browser_session").map((source) => [source.id, source.status])));
					setPhase("result");
				}).catch((error: unknown) => {
					if (disposed) return;
					setErrorText(error instanceof Error ? error.message : String(error));
					setPhase("error");
				});
			}
		};
		socket.onclose = (event) => {
			if (disposed) return;
			setPhase((phase) => {
				if (phase === "verifying" || phase === "result" || phase === "error") return phase;
				setErrorText(uiText("settings.source.loginFailed", {
					reason: event.reason || uiText("goals.browsermonitor.streamDisconnected"),
				}));
				return "error";
			});
		};
		socket.onerror = () => socket.close();
		return () => {
			disposed = true;
			socketRef.current = null;
			socket.close();
		};
	}, [open]);

	const send = (message: Record<string, unknown>) => {
		if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message));
	};
	const live = phase === "login" && hasFrame;
	const currentName = sources.find((source) => source.id === current)?.name ?? current ?? "";
	const finished = phase === "result" || phase === "error";

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
			<DialogContent
				className={cn("max-w-[calc(100vw-2rem)]", finished ? "sm:max-w-[440px]" : "sm:max-w-[920px]")}
				data-testid="browser-login-dialog"
				data-phase={phase}
				onOpenAutoFocus={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>{uiText("settings.source.loginBrowser")}</DialogTitle>
					{!finished && <DialogDescription>{uiText("settings.source.loginDialogDescription")}</DialogDescription>}
				</DialogHeader>
				{finished ? (
					<div className="grid gap-2">
						{errorText && <p className="m-0 text-[0.85rem] text-destructive" role="alert">{errorText}</p>}
						{!errorText && (
							<ul className="m-0 grid list-none gap-1.5 p-0" data-testid="browser-login-result">
								{sources.map((source) => {
									const state = result[source.id]?.state ?? "unchecked";
									return (
										<li key={source.id} className="flex items-center gap-2 text-[0.9rem]" data-testid={`browser-login-result-${source.id}`} data-state={state}>
											{state === "ok"
												? <Check className="h-4 w-4 text-emerald-500" aria-hidden />
												: <span className="inline-block h-2 w-2 rounded-full bg-amber-500" aria-hidden />}
											<span>{source.name}</span>
											<span className="text-[0.8rem] text-muted-foreground">{uiText(`settings.source.state.${state}` as MessageId)}</span>
										</li>
									);
								})}
							</ul>
						)}
						<DialogFooter>
							<button type="button" className={BTN_PRIMARY} onClick={onClose} data-testid="browser-login-close">
								{uiText("common.close")}
							</button>
						</DialogFooter>
					</div>
				) : (
					<div
						className="relative grid w-full place-items-center overflow-hidden rounded-[0.55rem] bg-[#15120f]"
						style={{ aspectRatio: `${viewportRef.current.width} / ${viewportRef.current.height}` }}
					>
						<canvas
							ref={canvasRef}
							className={cn("block h-full w-full outline-none select-none", live ? "cursor-default" : "opacity-0")}
							role="img"
							aria-label={uiText("settings.source.loginProgress", { name: currentName })}
							tabIndex={live ? 0 : -1}
							onPointerDown={live ? (event) => sendMouse(event, "mousePressed", send, viewportRef.current) : undefined}
							onPointerUp={live ? (event) => sendMouse(event, "mouseReleased", send, viewportRef.current) : undefined}
							onPointerMove={live ? (event) => {
								if (event.buttons) sendMouse(event, "mouseMoved", send, viewportRef.current);
							} : undefined}
							onWheel={live ? (event) => sendWheel(event, send, viewportRef.current) : undefined}
							onContextMenu={live ? (event) => event.preventDefault() : undefined}
							onKeyDown={live ? (event) => sendKey(event, "keyDown", send) : undefined}
							onKeyUp={live ? (event) => sendKey(event, "keyUp", send) : undefined}
						/>
						{!live && (
							<div className="absolute flex items-center gap-2 rounded-md bg-background/90 px-3 py-2 text-[0.85rem] text-muted-foreground" role="status">
								<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
								{phase === "verifying" ? uiText("settings.source.loginVerifying") : uiText("settings.source.loginConnecting")}
							</div>
						)}
					</div>
				)}
				{live && (
					<p className="m-0 text-[0.8rem] text-muted-foreground" role="status">
						{uiText("settings.source.loginProgress", { name: currentName })}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
