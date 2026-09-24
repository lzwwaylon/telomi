import { apiClient } from "@/shared/lib/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { CopyIcon as Copy } from "@/shared/ui/icons";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/shared/ui/dialog";
import { subscribeSharedEventSource } from "@/shared/lib/sharedEventSource";
import { eventSourceUrl } from "@/shared/lib/api";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";

export interface OAuthProviderInfo {
	id: string;
	name: string;
	usesCallbackServer: boolean;
	supportsDeviceCode?: boolean;
}

type OAuthEventEnvelope = (
	| { type: "auth"; url: string; instructions?: string }
	| { type: "device-code"; verificationUrl: string; userCode: string; intervalMs: number }
	| { type: "progress"; message: string }
	| { type: "prompt"; promptId: string; kind?: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; allowEmpty?: boolean; options?: { id: string; label: string }[] }
	| { type: "done" }
	| { type: "error"; message: string }
	| { type: "aborted" }
) & { sequence: number };

type OAuthPhase = "starting" | "running" | "done" | "error" | "aborted";

/** Select options with copy of their own; any other option keeps the label the flow sent. */
const OPTION_LABEL: Record<string, MessageId> = {
	browser: "settings.oauthlogindialog.option.browser",
	device_code: "settings.oauthlogindialog.option.device_code",
};

export type OAuthDialogMode = "browser" | "device";

const BTN_PRIMARY =
	"inline-flex items-center justify-center gap-1.5 rounded-[0.5rem] border border-border bg-card px-3 py-1.5 text-[0.82rem] text-foreground transition-colors hover:bg-[var(--foreground-5)] disabled:opacity-50 disabled:cursor-not-allowed";

export function OAuthLoginDialog({
	open,
	providerId,
	providerName,
	mode = "browser",
	onClose,
	onSuccess,
}: {
	open: boolean;
	providerId: string;
	providerName: string;
	mode?: OAuthDialogMode;
	onClose: () => void;
	onSuccess: () => void;
}) {
	const [phase, setPhase] = useState<OAuthPhase>("starting");
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [authInfo, setAuthInfo] = useState<{ url: string } | null>(null);
	const [deviceCode, setDeviceCode] = useState<{ verificationUrl: string; userCode: string } | null>(null);
	const [progress, setProgress] = useState<string[]>([]);
	const [prompt, setPrompt] = useState<(OAuthEventEnvelope & { type: "prompt" }) | null>(null);
	const [promptDraft, setPromptDraft] = useState("");
	const [promptBusy, setPromptBusy] = useState(false);
	const [errorText, setErrorText] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [codeCopied, setCodeCopied] = useState(false);
	const startedRef = useRef(false);
	const lastSequenceRef = useRef(0);
	const onSuccessRef = useRef(onSuccess);
	useEffect(() => {
		onSuccessRef.current = onSuccess;
	}, [onSuccess]);

	useEffect(() => {
		if (!open) {
			startedRef.current = false;
			setPhase("starting");
			setSessionId(null);
			setAuthInfo(null);
			setDeviceCode(null);
			setProgress([]);
			setPrompt(null);
			setPromptDraft("");
			setPromptBusy(false);
			setErrorText(null);
			setCopied(false);
			setCodeCopied(false);
			lastSequenceRef.current = 0;
			return;
		}
		if (startedRef.current) return;
		startedRef.current = true;
		let aborted = false;
		let terminal = false;
		let unsubscribe: ((immediate?: boolean) => void) | undefined;
		(async () => {
			try {
				const startPath =
					mode === "device"
						? `/api/auth/${encodeURIComponent(providerId)}/device/start`
						: `/api/auth/${encodeURIComponent(providerId)}/oauth/start`;
				const data = await apiClient.post<{ sessionId: string }>(startPath, {});
				if (aborted) return;
				const id = String(data.sessionId);
				setSessionId(id);
				setPhase("running");
				unsubscribe = subscribeSharedEventSource(eventSourceUrl(`/api/auth/oauth/${encodeURIComponent(id)}/events`), {
					onOpen: () => {
						if (!aborted) setErrorText(null);
					},
					onMessage: (event) => {
						if (aborted) return;
						let envelope: OAuthEventEnvelope | null = null;
						try {
							envelope = JSON.parse(event.data) as OAuthEventEnvelope;
						} catch {
							return;
						}
						const sequence = Number(event.lastEventId || envelope.sequence);
						if (!Number.isSafeInteger(sequence) || sequence <= lastSequenceRef.current) return;
						lastSequenceRef.current = sequence;
						setErrorText(null);
						switch (envelope.type) {
							case "auth":
								setAuthInfo({ url: envelope.url });
								break;
							case "device-code":
								setDeviceCode({ verificationUrl: envelope.verificationUrl, userCode: envelope.userCode });
								break;
							case "progress":
								setProgress((prev) => [...prev, envelope!.type === "progress" ? envelope!.message : ""]);
								break;
							case "prompt":
								setPrompt(envelope);
								setPromptDraft("");
								break;
							case "done":
								terminal = true;
								setPhase("done");
								unsubscribe?.(true);
								setTimeout(() => onSuccessRef.current(), 800);
								break;
							case "error":
								terminal = true;
								setErrorText(envelope.message);
								setPhase("error");
								unsubscribe?.(true);
								break;
							case "aborted":
								terminal = true;
								setPhase("aborted");
								unsubscribe?.(true);
								break;
						}
					},
					onError: () => {
						if (!aborted && !terminal) {
							setErrorText("Connection interrupted. Retrying automatically…");
						}
					},
				});
			} catch (err) {
				if (!aborted) {
					setErrorText(err instanceof Error ? err.message : String(err));
					setPhase("error");
				}
			}
		})();
		return () => {
			aborted = true;
			unsubscribe?.(true);
		};
	}, [open, providerId]);

	const submitPrompt = useCallback(async (value = promptDraft) => {
		if (!sessionId || !prompt) return;
		if (!prompt.allowEmpty && !value.trim()) return;
		setPromptBusy(true);
		try {
			await apiClient.post(`/api/auth/oauth/${encodeURIComponent(sessionId)}/input`, { promptId: prompt.promptId, value });
			setPrompt(null);
			setPromptDraft("");
		} catch (err) {
			setErrorText(err instanceof Error ? err.message : String(err));
		} finally {
			setPromptBusy(false);
		}
	}, [sessionId, prompt, promptDraft]);

	const requestAbort = useCallback(async () => {
		if (sessionId && phase === "running") {
			try {
				await apiClient.post(`/api/auth/oauth/${encodeURIComponent(sessionId)}/abort`);
			} catch {
				/* ignore */
			}
		}
		onClose();
	}, [sessionId, phase, onClose]);

	const copyUrl = useCallback(async () => {
		if (!authInfo?.url) return;
		try {
			await navigator.clipboard.writeText(authInfo.url);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard may be unavailable */
		}
	}, [authInfo]);

	const copyUserCode = useCallback(async () => {
		if (!deviceCode?.userCode) return;
		try {
			await navigator.clipboard.writeText(deviceCode.userCode);
			setCodeCopied(true);
			setTimeout(() => setCodeCopied(false), 1500);
		} catch {
			/* clipboard may be unavailable */
		}
	}, [deviceCode]);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) requestAbort();
			}}
		>
			<DialogContent className="max-w-[560px]" data-testid={`oauth-dialog-${providerId}`}>
				<DialogHeader>
					<DialogTitle>
						{uiText("common.signInToProvider", { provider: providerName })}
						{mode === "device" ? uiText("settings.oauthlogindialog.deviceCode") : ""}
					</DialogTitle>
					<DialogDescription>
						{uiText("settings.oauthlogindialog.provider")} <code className="font-mono text-[0.78rem]">{providerId}</code>
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-3">
					{phase === "starting" && (
						<div className="flex items-center gap-2 text-[0.85rem] text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {uiText("settings.oauthlogindialog.startingOauthSession")}
						</div>
					)}

					{authInfo && phase !== "done" && phase !== "aborted" && (
						<div className="grid gap-2 rounded-[0.55rem] border border-border bg-card p-3">
							<div className="text-[0.82rem] text-muted-foreground">{uiText("settings.oauthlogindialog.openThisUrlInYourBrowserToAuthorize")}</div>
							<div className="flex items-center gap-2">
								<code
									className="flex-1 rounded border border-border bg-popover px-2 py-1 text-[0.78rem] font-mono text-foreground break-all"
									data-testid={`oauth-dialog-${providerId}-url`}
								>
									{authInfo.url}
								</code>
							</div>
							<div className="flex items-center gap-2">
								<a href={authInfo.url} target="_blank" rel="noopener noreferrer" className={BTN_PRIMARY}>
									<ExternalLink className="h-3.5 w-3.5" aria-hidden /> {uiText("settings.oauthlogindialog.openInBrowser")}
								</a>
								<button type="button" className={BTN_PRIMARY} onClick={copyUrl}>
									<Copy className="h-3.5 w-3.5" aria-hidden /> {copied ? uiText("common.copied") : uiText("settings.oauthlogindialog.copyUrl")}
								</button>
							</div>
							{/* The flow's own instructions promise a window that never opens here; the copy above states what actually happens. */}
							<div className="text-[0.82rem] text-foreground">{uiText("settings.oauthlogindialog.openManually")}</div>
						</div>
					)}

					{deviceCode && phase !== "done" && phase !== "aborted" && (
						<div
							className="grid gap-2 rounded-[0.55rem] border border-border bg-card p-3"
							data-testid={`oauth-dialog-${providerId}-device`}
						>
							<div className="text-[0.82rem] text-muted-foreground">
								{uiText("settings.oauthlogindialog.message1OpenTheVerificationPageAndSignInWith")}
							</div>
							<div className="flex items-center gap-2">
								<code
									className="flex-1 rounded border border-border bg-popover px-2 py-1 text-[0.78rem] font-mono text-foreground break-all"
									data-testid={`oauth-dialog-${providerId}-device-url`}
								>
									{deviceCode.verificationUrl}
								</code>
								<a
									href={deviceCode.verificationUrl}
									target="_blank"
									rel="noopener noreferrer"
									className={BTN_PRIMARY}
								>
									<ExternalLink className="h-3.5 w-3.5" aria-hidden /> {uiText("settings.oauthlogindialog.open")}
								</a>
							</div>
							<div className="text-[0.82rem] text-muted-foreground">{uiText("settings.oauthlogindialog.message2EnterThisCodeOnThePage")}</div>
							<div className="flex items-center gap-2">
								<code
									className="flex-1 rounded border border-border bg-popover px-3 py-2 text-center text-[1.1rem] tracking-[0.3em] font-mono text-foreground"
									data-testid={`oauth-dialog-${providerId}-device-code`}
								>
									{deviceCode.userCode}
								</code>
								<button type="button" className={BTN_PRIMARY} onClick={copyUserCode}>
									<Copy className="h-3.5 w-3.5" aria-hidden /> {codeCopied ? uiText("common.copied") : uiText("common.copyCode")}
								</button>
							</div>
							<div className="text-[0.78rem] text-muted-foreground">
								{uiText("settings.oauthlogindialog.weWillDetectYourApprovalAutomaticallyNoCallbackPort")}
							</div>
						</div>
					)}

					{prompt && phase === "running" && prompt.kind === "select" && (
						<div className="grid gap-2 rounded-[0.55rem] border border-border bg-card p-3" data-testid={`oauth-dialog-${providerId}-prompt-select`}>
							<div className="text-[0.85rem] text-foreground">{uiText("settings.oauthlogindialog.selectMethod")}</div>
							<div className="flex flex-wrap items-center gap-2">
								{(prompt.options ?? []).map((option) => (
									<button key={option.id} type="button" className={BTN_PRIMARY} disabled={promptBusy} onClick={() => submitPrompt(option.id)} data-testid={`oauth-dialog-${providerId}-option-${option.id}`}>
										{OPTION_LABEL[option.id] ? uiText(OPTION_LABEL[option.id]) : option.label}
									</button>
								))}
							</div>
						</div>
					)}

					{prompt && phase === "running" && prompt.kind !== "select" && (
						<div className="grid gap-2 rounded-[0.55rem] border border-border bg-card p-3">
							<div className="text-[0.85rem] text-foreground whitespace-pre-wrap">
								{prompt.kind === "manual_code" ? uiText("settings.oauthlogindialog.manualCode") : prompt.message}
							</div>
							<div className="flex items-center gap-2">
								<input
									type="text"
									value={promptDraft}
									onChange={(e) => setPromptDraft(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											submitPrompt();
										}
									}}
									placeholder={prompt.placeholder ?? ""}
									autoFocus
									className="flex-1 h-8 rounded border border-border bg-popover px-2 text-[0.85rem] font-mono text-foreground"
									data-testid={`oauth-dialog-${providerId}-prompt-input`}
								/>
								<button
									type="button"
									className={BTN_PRIMARY}
									onClick={() => submitPrompt()}
									disabled={promptBusy || (!prompt.allowEmpty && !promptDraft.trim())}
									data-testid={`oauth-dialog-${providerId}-prompt-submit`}
								>
									{promptBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
									{uiText("common.submit")}
								</button>
							</div>
						</div>
					)}

					{progress.length > 0 && (
						<div className="grid gap-1 rounded-[0.55rem] border border-border bg-card p-3 max-h-[140px] overflow-y-auto">
							{progress.map((m, idx) => (
								<div key={`${idx}-${m.slice(0, 12)}`} className="text-[0.78rem] text-muted-foreground">
									{m}
								</div>
							))}
						</div>
					)}

					{phase === "done" && (
						<div className="text-[0.85rem] text-emerald-600 dark:text-emerald-400">{uiText("settings.oauthlogindialog.loginCompleteSavingCredentials")}</div>
					)}
					{phase === "aborted" && <div className="text-[0.85rem] text-muted-foreground">{uiText("settings.oauthlogindialog.aborted")}</div>}
					{phase === "running" && errorText && (
						<div className="text-[0.85rem] text-amber-600 dark:text-amber-400">{errorText}</div>
					)}
					{errorText && phase === "error" && (
						<div className="text-[0.85rem] text-destructive whitespace-pre-wrap">{errorText}</div>
					)}
				</div>

				<DialogFooter>
					<button
						type="button"
						className={BTN_PRIMARY}
						onClick={requestAbort}
						data-testid={`oauth-dialog-${providerId}-close`}
					>
						{phase === "running" || phase === "starting" ? uiText("common.cancel") : uiText("common.close")}
					</button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
