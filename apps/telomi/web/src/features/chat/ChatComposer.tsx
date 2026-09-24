import { voiceApi } from "@/features/voice/api";
import { formatBytes } from "@/shared/lib/format";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
	ArrowUp,
	Mic,
	Paperclip,
	Square,
	FolderOpen,
} from "lucide-react";
import { ChatIcon as MessageCircle, CloseIcon as X } from "@/shared/ui/icons";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AttachmentPayload, GoalSnapshot, SendMessageRequest, SendMessageResult } from "@shared/types";
import type { ConnectionState } from "@/features/goals/data/types";
import { ModelPicker } from "@/features/settings/ModelPicker";
import { ProviderAccountBadge } from "@/features/settings/ProviderAccountBadge";
import { getFileTypeLabel, inferAttachmentType } from "@/features/chat/attachment-helpers";
import { ThinkingPicker } from "@/features/chat/ThinkingPicker";
import { RotatingPlaceholder } from "@/features/chat/RotatingPlaceholder";
import { useAutoGrow } from "@/shared/hooks/useAutoGrow";
import { isImeCompositionKeyboardEvent } from "@/shared/lib/composerKeyboard";
import { cn } from "@/shared/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";
import {
	insertVoiceTranscript,
	type VoiceTextSelection,
} from "@/features/voice/voiceComposerText";
import {
	useVoiceInputSession,
	type VoiceInputResult,
} from "@/features/voice/useVoiceInputSession";
import {
	useLiveKitConversation,
	type LiveKitConversationState,
} from "@/features/voice/useLiveKitConversation";
import { VoiceCorrectionLearningNotice } from "@/features/settings/VoiceCorrectionLearningNotice";
import { voiceCleanupNotice } from "@/features/voice/voiceCleanupFeedback";
import { resolveVoiceInputControl } from "@/features/voice/voiceInputControl";
import {
	createPendingVoiceUserEdit,
	resolveVoiceUserEditSubmissions,
	submitVoiceUserEditEvidence,
	type PendingVoiceUserEdit,
} from "@/features/voice/voiceUserEdit";
import { usePlaybackStatus } from "@/features/media/player/PlayerContext";
import {
	resolveComposerSendControls,
	resolveVoiceQueueNotice,
} from "@/features/voice/voiceQueueFeedback";
import { useTranslation } from "react-i18next";

const ICON_BUTTON_BASE = cn(
	"inline-flex items-center justify-center h-7 w-7 rounded-[6px] flex-none",
	"transition-[background-color,color,border-color,transform] duration-150 ease-[ease]",
	"focus-visible:outline-2 focus-visible:outline-[color-mix(in_oklch,var(--accent)_55%,transparent)] focus-visible:outline-offset-1",
);

const PASTE_TO_FILE_LINE_THRESHOLD = 100;
const PASTE_TO_FILE_CHAR_THRESHOLD = 5000;
/** A picked folder is sent as one group; these bounds keep the JSON body under the server limit. */
const MAX_FOLDER_FILES = 200;
const MAX_FOLDER_BYTES = 40 * 1024 * 1024;

interface VoiceNoticeState {
	id: number;
	message: string;
	corrections: string[];
}

export type LiveKitConversationDisplayState = LiveKitConversationState;

export function LiveKitConversationResponse({
	state,
}: {
	state: LiveKitConversationDisplayState;
}) {
	const { t } = useTranslation();
	if (state.status === "idle") return null;
	return (
		<div
			className={cn(
				"mx-3 mt-1 rounded-lg border px-3 py-2 text-[0.78rem] leading-relaxed",
				state.status === "error"
					? "border-[color-mix(in_oklch,var(--destructive)_30%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_5%,transparent)]"
					: "border-[color-mix(in_oklch,var(--accent)_25%,var(--border))] bg-[color-mix(in_oklch,var(--accent)_5%,transparent)]",
			)}
			aria-live={state.status === "error" ? "assertive" : "polite"}
			data-testid="voice-interaction-response"
			role={state.status === "error" ? "alert" : "status"}
		>
			{state.userText && (
				<div className="mb-1">
					<span className="mr-2 font-medium text-[var(--foreground)]">{t("chat.you")}</span>
					<span className="text-[var(--foreground-50)]">{state.userText}</span>
				</div>
			)}
			<div>
				<span className="mr-2 font-medium text-[var(--foreground)]">Telomi</span>
				<span className="text-[var(--foreground-50)]">
					{state.text || state.message || t("chat.generating")}
				</span>
			</div>
			{state.text && state.message && (
				<div className="mt-1 text-[var(--foreground-50)]">{state.message}</div>
			)}
		</div>
	);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
	}
	return btoa(binary);
}

function newAttachmentId(): string {
	return crypto.randomUUID?.() ?? `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function fileToAttachment(file: File, folderId?: string): Promise<AttachmentPayload> {
	const buffer = await file.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	const base64 = bytesToBase64(bytes);
	const isImage = file.type.startsWith("image/");
	const isText = !folderId && (file.type.startsWith("text/") || /\.(md|txt|json|csv|log)$/i.test(file.name));
	let extractedText: string | undefined;
	if (isText) {
		try {
			extractedText = await file.text();
		} catch {
			/* ignore; server may still handle it */
		}
	}
	return {
		id: newAttachmentId(),
		type: isImage ? "image" : "document",
		fileName: file.name,
		mimeType: file.type || "application/octet-stream",
		size: file.size,
		content: base64,
		...(extractedText !== undefined ? { extractedText } : {}),
		...(folderId ? { folderId, relativePath: file.webkitRelativePath || file.name } : {}),
	};
}

/** Chips show one entry per loose file and one per picked folder. */
interface AttachmentDisplayItem {
	key: string;
	folderId?: string;
	folderName?: string;
	fileCount: number;
	size: number;
	attachment: AttachmentPayload;
}

export function groupAttachmentsForDisplay(attachments: AttachmentPayload[]): AttachmentDisplayItem[] {
	const items: AttachmentDisplayItem[] = [];
	const folders = new Map<string, AttachmentDisplayItem>();
	for (const attachment of attachments) {
		if (!attachment.folderId) {
			items.push({ key: attachment.id, fileCount: 1, size: attachment.size, attachment });
			continue;
		}
		const existing = folders.get(attachment.folderId);
		if (existing) {
			existing.fileCount += 1;
			existing.size += attachment.size;
			continue;
		}
		const item: AttachmentDisplayItem = {
			key: `folder:${attachment.folderId}`,
			folderId: attachment.folderId,
			folderName: (attachment.relativePath || attachment.fileName).split("/")[0] || attachment.fileName,
			fileCount: 1,
			size: attachment.size,
			attachment,
		};
		folders.set(attachment.folderId, item);
		items.push(item);
	}
	return items;
}

function pastedTextToAttachment(text: string, index: number): AttachmentPayload {
	const bytes = new TextEncoder().encode(text);
	return {
		id: newAttachmentId(),
		type: "document",
		fileName: `pasted-text-${index}.txt`,
		mimeType: "text/plain",
		size: bytes.byteLength,
		content: bytesToBase64(bytes),
		extractedText: text,
	};
}

function shouldAutoAttachPaste(text: string): boolean {
	if (text.length >= PASTE_TO_FILE_CHAR_THRESHOLD) return true;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
		if (lines > PASTE_TO_FILE_LINE_THRESHOLD) return true;
	}
	return false;
}

function documentEmoji(mime: string, fileName: string): string {
	const m = (mime || "").toLowerCase();
	const ext = fileName.toLowerCase().replace(/^.*\./, "");
	if (m.startsWith("text/") || ["md", "txt", "log", "csv"].includes(ext)) return "📝";
	if (m.includes("pdf") || ext === "pdf") return "📕";
	if (m.includes("wordprocessingml") || ["doc", "docx"].includes(ext)) return "📘";
	if (m.includes("spreadsheetml") || m.includes("ms-excel") || ["xls", "xlsx"].includes(ext)) return "📗";
	if (m.includes("presentationml") || ["ppt", "pptx"].includes(ext)) return "📙";
	if (m.includes("json") || ext === "json") return "🧾";
	if (m.includes("zip") || ["zip", "tar", "gz", "7z"].includes(ext)) return "🗜";
	if (m.includes("audio") || m.startsWith("audio/")) return "🎧";
	if (m.includes("video") || m.startsWith("video/")) return "🎬";
	return "📄";
}

export interface ChatComposerProps {
	/** Goal id; resets input/attachments/error on change. Pass `null` to disable. */
	goalId: string | null;
	/** Live snapshot - for ModelPicker/ThinkingPicker current values + isStreaming abort UI. */
	snapshot: GoalSnapshot | null;
	/** Connection state - used to gate send + drag/paste. */
	connection: ConnectionState;
	/** Send a user message. */
	sendMessage: (body: SendMessageRequest) => Promise<SendMessageResult>;
	/** Abort current streaming response. */
	abort: () => Promise<void>;
	/** Switch active model. */
	setModel: (modelId: string) => Promise<void>;
	/** Switch thinking level. */
	setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
	/** Optional outer class - wrapper that owns drag/drop. */
	className?: string;
}

/**
 * The standalone composer: textarea + attachments + paste/drop handling +
 * model / thinking pickers + send/abort. Owns drag/drop on its own root so
 * it can be embedded in different chat surfaces without re-implementing
 * upload plumbing.
 *
 * Behavior carried over verbatim from DebugPanel:
 *  - paste → file threshold (5000 chars or 100 lines)
 *  - useAutoGrow on textarea
 *  - drag-active overlay
 *  - reset on goalId change
 */
export function ChatComposer({
	goalId,
	snapshot,
	connection,
	sendMessage,
	abort,
	setModel,
	setThinkingLevel,
	className,
}: ChatComposerProps) {
	const { t } = useTranslation();
	const { acquirePlaybackPause } = usePlaybackStatus();
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [lastError, setLastError] = useState<string | null>(null);
	const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
	const [encoding, setEncoding] = useState(false);
	const [dragActive, setDragActive] = useState(false);
	const [voiceNotice, setVoiceNotice] = useState<VoiceNoticeState | null>(null);
	const [undoingVoiceNoticeId, setUndoingVoiceNoticeId] = useState<number | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const folderInputRef = useRef<HTMLInputElement>(null);
	const voiceNoticeIdRef = useRef(0);
	const voiceEditObservationRef = useRef<{
		originalText: string;
		startedAt: number;
	} | null>(null);
	const pendingVoiceUserEditsRef = useRef<PendingVoiceUserEdit[]>([]);
	const voiceInsertionSelectionRef = useRef<VoiceTextSelection | null>(null);
	const dragDepthRef = useRef(0);
	const liveConversation = useLiveKitConversation(
		goalId,
		acquirePlaybackPause,
	);
	const liveInteractionEnabled = liveConversation.active;
	const liveInteraction = liveConversation.state;
	const { ref: textareaRef } = useAutoGrow<HTMLTextAreaElement>({
		minHeight: 36,
		maxHeight: 240,
		value: input,
	});
	const rememberVoiceInsertionSelection = useCallback((textarea?: HTMLTextAreaElement | null) => {
		const target = textarea ?? textareaRef.current;
		if (!target) return;
		voiceInsertionSelectionRef.current = {
			start: target.selectionStart,
			end: target.selectionEnd,
		};
	}, [textareaRef]);
	const showVoiceNotice = useCallback((
		message: string | null,
		corrections: string[] = [],
	) => {
		setUndoingVoiceNoticeId(null);
		setVoiceNotice(
			message === null
				? null
				: {
						id: ++voiceNoticeIdRef.current,
						message,
						corrections,
					},
		);
	}, []);
	const applyVoiceResult = useCallback((
		result: VoiceInputResult | null,
	) => {
		if (!result) return;
		if (result.skipped) {
			showVoiceNotice(
				result.reason === "empty_recording"
					? uiText("chat.composer.theRecordingContainedNoValidAudioFramesSoNo")
					: uiText("chat.composer.notEnoughSpeechWasDetectedSoNoTranscriptionWas"),
			);
			return;
		}
		const text = result.text.trim();
		showVoiceNotice(voiceCleanupNotice(result.cleanup, text));
		if (!text) return;
		let committedSelection: VoiceTextSelection | null = null;
		const observationStartedAt = Date.now();
		setInput((prev) => {
			const insertion = insertVoiceTranscript(
				prev,
				text,
				voiceInsertionSelectionRef.current ?? {
					start: prev.length,
					end: prev.length,
				},
			);
			committedSelection = insertion.selection;
			voiceInsertionSelectionRef.current = insertion.selection;
			voiceEditObservationRef.current = {
				originalText: insertion.text,
				startedAt: observationStartedAt,
			};
			const pending = createPendingVoiceUserEdit({
				historyId: result.historyId,
				insertion,
				transcript: text,
				startedAt: observationStartedAt,
			});
			if (pending) {
				pendingVoiceUserEditsRef.current = [
					...pendingVoiceUserEditsRef.current.filter(
						(candidate) => candidate.historyId !== pending.historyId,
					),
					pending,
				];
			}
			return insertion.text;
		});
		const ta = textareaRef.current;
		if (ta) {
			setTimeout(() => {
				const selection = committedSelection ?? voiceInsertionSelectionRef.current;
				ta.focus();
				try {
					if (selection) {
						ta.setSelectionRange(selection.start, selection.end);
					}
				} catch {
					/* ignore */
				}
			}, 0);
		}
	}, [showVoiceNotice, textareaRef]);
	const handleVoiceResult = useCallback((
		result: VoiceInputResult,
	) => {
		setLastError(null);
		applyVoiceResult(result);
	}, [applyVoiceResult]);
	const voiceInput = useVoiceInputSession(goalId, {
		onResult: handleVoiceResult,
		acquirePlaybackPause,
		onCancel: () => showVoiceNotice(null),
	});
	const voiceInputControl = resolveVoiceInputControl(
		voiceInput.state.status,
		(key, options) => uiText(key as MessageId, options as Record<string, string | number>),
	);

	useEffect(() => {
		setInput("");
		setAttachments([]);
		setLastError(null);
		void liveConversation.stop();
		showVoiceNotice(null);
		voiceEditObservationRef.current = null;
		pendingVoiceUserEditsRef.current = [];
		voiceInsertionSelectionRef.current = null;
	}, [goalId, liveConversation.stop, showVoiceNotice]);

	const addFiles = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setEncoding(true);
		setLastError(null);
		try {
			const encoded = await Promise.all(Array.from(files).map((file) => fileToAttachment(file)));
			setAttachments((prev) => [...prev, ...encoded]);
		} catch (err) {
			setLastError(err instanceof Error ? err.message : String(err));
		} finally {
			setEncoding(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	const addFolder = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		const list = Array.from(files);
		const totalBytes = list.reduce((sum, file) => sum + file.size, 0);
		if (list.length > MAX_FOLDER_FILES || totalBytes > MAX_FOLDER_BYTES) {
			setLastError(uiText("chat.composer.folderTooLarge", { files: MAX_FOLDER_FILES, size: formatBytes(MAX_FOLDER_BYTES) }));
			if (folderInputRef.current) folderInputRef.current.value = "";
			return;
		}
		setEncoding(true);
		setLastError(null);
		try {
			const folderId = newAttachmentId();
			const encoded = await Promise.all(list.map((file) => fileToAttachment(file, folderId)));
			setAttachments((prev) => [...prev, ...encoded]);
		} catch (err) {
			setLastError(err instanceof Error ? err.message : String(err));
		} finally {
			setEncoding(false);
			if (folderInputRef.current) folderInputRef.current.value = "";
		}
	};

	const removeAttachment = (id: string) => {
		setAttachments((prev) => prev.filter((a) => a.id !== id));
	};

	const removeFolder = (folderId: string) => {
		setAttachments((prev) => prev.filter((a) => a.folderId !== folderId));
	};

	const addPastedItems = async (items: DataTransferItemList | null) => {
		if (!items) return;
		const files: File[] = [];
		for (const item of Array.from(items)) {
			if (item.kind !== "file") continue;
			const f = item.getAsFile();
			if (f) files.push(f);
		}
		if (files.length === 0) return;
		const dt = new DataTransfer();
		for (const f of files) dt.items.add(f);
		await addFiles(dt.files);
	};

	const addPastedText = (text: string) => {
		const existing = attachments.filter((a) => a.fileName.startsWith("pasted-text-")).length;
		const next = pastedTextToAttachment(text, existing + 1);
		setAttachments((prev) => [...prev, next]);
	};

	const sessionUsable = !!goalId && !!snapshot;
	const canSend =
		!sending && !encoding && sessionUsable && (input.trim().length > 0 || attachments.length > 0);
	const isStopping = snapshot?.stopState === "stopping";
	const composerSendControls = resolveComposerSendControls(
		snapshot?.isStreaming === true,
		canSend,
	);

	const handleMicClick = async () => {
		if (!goalId) return;
		if (voiceInputControl.action === "stop") {
			showVoiceNotice(null);
			setLastError(null);
			await voiceInput.input({ type: "utterance.finish" });
			return;
		}
		if (voiceInputControl.action === "cancel") {
			setLastError(null);
			await voiceInput.input({ type: "utterance.cancel" });
			return;
		}
		if (voiceInputControl.action === "start") {
			showVoiceNotice(null);
			setLastError(null);
			rememberVoiceInsertionSelection();
			await voiceInput.input({ type: "utterance.start" });
		}
	};

	const onSend = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!canSend) return;
		const voiceObservation = voiceEditObservationRef.current;
		const editedText = input;
		const pendingVoiceUserEdits = pendingVoiceUserEditsRef.current;
		const voiceUserEditSubmissions = resolveVoiceUserEditSubmissions(
			pendingVoiceUserEdits,
			editedText,
			Date.now(),
		);
		setSending(true);
		setLastError(null);
		try {
			const sendResult = await sendMessage({
				content: input,
				...(attachments.length > 0 ? { attachments } : {}),
			});
			const queueNotice = resolveVoiceQueueNotice(
				sendResult,
				voiceObservation !== null || pendingVoiceUserEdits.length > 0,
			);
			if (queueNotice) showVoiceNotice(queueNotice);
			setInput("");
			setAttachments([]);
			voiceEditObservationRef.current = null;
			if (pendingVoiceUserEditsRef.current === pendingVoiceUserEdits) {
				pendingVoiceUserEditsRef.current = [];
			}
			voiceInsertionSelectionRef.current = null;
			void Promise.allSettled(
				voiceUserEditSubmissions.map((submission) =>
					submitVoiceUserEditEvidence(submission),
				),
			).then((results) => {
				results.forEach((result, index) => {
					if (result.status === "fulfilled") return;
					console.warn(
						`[voice] failed to record submitted edit for ${voiceUserEditSubmissions[index]?.historyId ?? "unknown"}: ${
							result.reason instanceof Error
								? result.reason.message
								: String(result.reason)
						}`,
					);
				});
			});
			if (
				voiceObservation &&
				Date.now() - voiceObservation.startedAt <= 30_000 &&
				voiceObservation.originalText !== editedText
			) {
				void submitVoiceCorrectionObservation(
					voiceObservation.originalText,
					editedText,
				).then((corrections) => {
					if (corrections.length > 0) {
						showVoiceNotice(
							uiText("chat.composer.learnedFromThisEditCorrections", { corrections: corrections.join("、") }),
							corrections,
						);
					}
				});
			}
		} catch (err) {
			setLastError(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
		}
	};

	const handleUndoVoiceLearning = async () => {
		const notice = voiceNotice;
		if (!notice || notice.corrections.length === 0 || undoingVoiceNoticeId !== null) {
			return;
		}
		const noticeId = notice.id;
		setUndoingVoiceNoticeId(noticeId);
		try {
			const removed = await undoVoiceCorrectionLearning(notice.corrections);
			setVoiceNotice((current) =>
				current?.id === noticeId
					? {
							...current,
							message:
								removed.length > 0
									? uiText("chat.composer.undidAutomaticLearningCorrections", { corrections: removed.join("、") })
									: uiText("chat.composer.thisAutomaticLearningEntryNoLongerExistsTheGlossary"),
							corrections: [],
						}
					: current,
			);
		} catch (error) {
			setVoiceNotice((current) =>
				current?.id === noticeId
					? {
							...current,
							message: uiText("chat.composer.failedToUndoAutomaticLearningTheGlossaryWasNot", {
								error: error instanceof Error ? error.message : String(error),
							}),
						}
					: current,
			);
		} finally {
			setUndoingVoiceNoticeId((current) =>
				current === noticeId ? null : current,
			);
		}
	};

	return (
		<div
			className={cn(
				"relative",
				dragActive && "ring-2 ring-[var(--foreground)] ring-offset-2 ring-offset-[var(--background)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]",
				className,
			)}
			onDragEnter={(e) => {
				if (connection.kind !== "open") return;
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				dragDepthRef.current += 1;
				setDragActive(true);
			}}
			onDragOver={(e) => {
				if (connection.kind !== "open") return;
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(e) => {
				if (connection.kind !== "open") return;
				e.preventDefault();
				dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
				if (dragDepthRef.current === 0) setDragActive(false);
			}}
			onDrop={(e) => {
				if (connection.kind !== "open") return;
				e.preventDefault();
				dragDepthRef.current = 0;
				setDragActive(false);
				void addFiles(e.dataTransfer.files);
			}}
		>
			{dragActive && (
				<div
					className="absolute inset-0 bg-[var(--foreground-30)] opacity-60 border-2 border-dashed border-[var(--accent)] rounded-[var(--radius-lg)] flex items-center justify-center text-[var(--accent)] text-[0.95rem] pointer-events-none z-10"
				>
						{uiText("chat.composer.dropFilesToAttach")}
				</div>
			)}

			<form
				className="bg-transparent px-[clamp(1rem,0.4rem+2vw,2rem)] pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
				onSubmit={onSend}
			>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					onChange={(e) => void addFiles(e.target.files)}
					className="sr-only"
					aria-hidden="true"
					tabIndex={-1}
				/>
				<input
					ref={folderInputRef}
					type="file"
					multiple
					{...({ webkitdirectory: "" } as Record<string, string>)}
					onChange={(e) => void addFolder(e.target.files)}
					className="sr-only"
					aria-hidden="true"
					tabIndex={-1}
				/>
				<div className="max-w-[820px] w-full mx-auto flex flex-col gap-0">
					<motion.div
						layout="position"
						transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
						className="@container flex flex-col gap-[0.4rem] bg-[var(--background)] rounded-[16px] pt-[0.4rem] pr-[0.45rem] pb-[0.35rem] pl-[0.45rem] shadow-middle transition-shadow duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]">
						<AnimatePresence initial={false}>
							{attachments.length > 0 && (
								<motion.div
									key="attachments-row"
									initial={{ opacity: 0, height: 0 }}
									animate={{ opacity: 1, height: "auto" }}
									exit={{ opacity: 0, height: 0 }}
									transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
									style={{ overflow: "hidden" }}
								>
									<div className="flex flex-wrap gap-[0.3rem] pt-[0.15rem] px-[0.2rem]">
										<AnimatePresence initial={false}>
											{groupAttachmentsForDisplay(attachments).map((item) => {
												const a = item.attachment;
												const sizeLabel = formatBytes(item.size);
												const isImage = !item.folderId && a.type === "image";
												const displayName = item.folderName ?? a.fileName;
												const meta = item.folderId
													? `${uiText("chat.composer.folderFiles", { count: item.fileCount })} · ${sizeLabel}`
													: `${getFileTypeLabel(inferAttachmentType(a.mimeType, a.fileName), a.mimeType, a.fileName)} · ${sizeLabel}`;
												return (
													<motion.div
														key={item.key}
														layout
														initial={{ opacity: 0, scale: 0.9 }}
														animate={{ opacity: 1, scale: 1 }}
														exit={{ opacity: 0, scale: 0.9 }}
														transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
														className="relative inline-flex items-center gap-2 pt-[0.3rem] pr-[0.55rem] pb-[0.3rem] pl-[0.35rem] rounded-[0.55rem] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] border border-[color-mix(in_oklch,var(--border)_70%,transparent)] min-w-0 max-w-[280px] hover:border-[var(--input)]"
														title={`${displayName}\n${meta}`}
													>
														<div
															className="flex-none w-[2.4rem] h-[2.4rem] rounded-[0.4rem] overflow-hidden flex items-center justify-center bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] border border-[color-mix(in_oklch,var(--border)_60%,transparent)]"
															aria-hidden
														>
															{isImage ? (
																<img
																	src={`data:${a.mimeType || "image/png"};base64,${a.content}`}
																	alt={a.fileName}
																	loading="lazy"
																	className="w-full h-full object-cover block"
																/>
															) : (
																<span className="text-[1.25rem] leading-none">
																	{item.folderId ? "📁" : documentEmoji(a.mimeType, a.fileName)}
																</span>
															)}
														</div>
														<div className="flex flex-col gap-[0.1rem] min-w-0 overflow-hidden">
															<span className="text-[0.78rem] font-medium text-[var(--foreground)] whitespace-nowrap overflow-hidden text-ellipsis max-w-[180px]">
																{displayName}
															</span>
															<span className="text-[0.68rem] text-[var(--foreground-30)] whitespace-nowrap overflow-hidden text-ellipsis">
																{meta}
															</span>
														</div>
														<button
															type="button"
															className="flex-none bg-transparent border-0 text-[var(--foreground-30)] cursor-pointer px-[0.1rem] ml-[0.2rem] leading-none text-base rounded-[0.25rem] transition-[color,background-color] duration-[120ms] ease-[ease] hover:text-[var(--foreground)] hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] focus-visible:outline-2 focus-visible:outline-[color-mix(in_oklch,var(--accent)_55%,transparent)] focus-visible:outline-offset-1"
															onClick={() => item.folderId ? removeFolder(item.folderId) : removeAttachment(a.id)}
															title={uiText("chat.composer.removeAttachment")}
															aria-label={uiText("chat.composer.removeFile", { file: displayName })}
														>
															×
														</button>
													</motion.div>
												);
											})}
										</AnimatePresence>
									</div>
								</motion.div>
							)}
						</AnimatePresence>
						{(voiceInput.state.status === "recording" || voiceInput.state.status === "finalizing") && (
							<div className="mx-5 flex min-h-8 items-center justify-between gap-3 text-xs text-[var(--foreground-50)]">
								<span role="status" data-testid="voice-recording-status">
									{voiceInput.state.status === "finalizing" ? t("chat.voiceFinalizing") : t("chat.voiceListening")}
								</span>
								{voiceInput.state.status === "recording" && (
									<button
										type="button"
										className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:text-[var(--foreground)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
										onClick={() => void voiceInput.input({ type: "utterance.cancel" })}
										aria-label={t("chat.cancelVoiceInput")}
										title={t("chat.cancelRecording")}
										data-testid="voice-cancel"
									>
										<X className="h-3.5 w-3.5" aria-hidden />
									</button>
								)}
							</div>
						)}
						<LiveKitConversationResponse state={liveInteraction} />
						<div className="relative">
							<textarea
								ref={textareaRef}
								data-testid="chat-composer-input"
								className="w-full min-h-[36px] pl-5 pr-4 pt-2 pb-2 bg-transparent text-[var(--foreground)] border-0 rounded-none font-[inherit] text-[0.92rem] leading-[1.25] outline-none resize-none overflow-y-auto block placeholder:text-[var(--foreground-30)]"
								rows={1}
								value={input}
								onChange={(e) => {
									setInput(e.target.value);
									if (!e.target.value.trim()) {
										showVoiceNotice(null);
										voiceInput.clearError();
									}
									rememberVoiceInsertionSelection(e.currentTarget);
								}}
								onSelect={(e) => rememberVoiceInsertionSelection(e.currentTarget)}
								onKeyDown={(e) => {
									if (isImeCompositionKeyboardEvent(e.nativeEvent)) return;
									if (e.key !== "Enter") return;
									if (e.shiftKey) return;
									e.preventDefault();
									if (canSend) void onSend(e as unknown as React.FormEvent);
								}}
								onPaste={(e) => {
									const cd = e.clipboardData;
									if (!cd) return;
									const items = cd.items;
									let hasFile = false;
									for (const item of Array.from(items ?? [])) {
										if (item.kind === "file") {
											hasFile = true;
											break;
										}
									}
									if (hasFile) {
										e.preventDefault();
										void addPastedItems(items);
										return;
									}
									const text = cd.getData("text/plain");
									if (text && shouldAutoAttachPaste(text)) {
										e.preventDefault();
										addPastedText(text);
									}
								}}
								placeholder=""
								disabled={sending || !sessionUsable}
							/>
							{!input.trim() && (
								<div className="pointer-events-none absolute inset-0 flex items-start pl-5 pr-4 pt-2 pb-2 text-[0.92rem] leading-[1.25] text-[var(--foreground-30)]">
									<RotatingPlaceholder
										active={!sending && sessionUsable}
										placeholders={
											attachments.length > 0
												? [t("chat.attachmentPrompt"), t("chat.attachmentContextPrompt")]
												: [t("chat.prompt1"), t("chat.prompt2"), t("chat.prompt3"), t("chat.prompt4")]
										}
									/>
								</div>
							)}
						</div>
						<div className="flex items-center gap-1 px-1.5 py-1.5 @max-[420px]:px-0 @max-[300px]:flex-wrap max-[520px]:px-0 border-t border-[color-mix(in_oklch,var(--border)_50%,transparent)] text-[13px]">
							<div className="flex items-center gap-1 @max-[420px]:gap-0 @max-[300px]:w-full @max-[300px]:justify-between">
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										className={cn(
											ICON_BUTTON_BASE,
											"@max-[420px]:h-9 @max-[420px]:w-9",
											"max-[520px]:!h-[44px] max-[520px]:!w-[44px]",
											"text-[var(--foreground-50)] hover:enabled:text-[var(--foreground)] hover:enabled:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] disabled:opacity-[0.45]",
										)}
										title={t("chat.addAttachment")}
										aria-label={t("chat.addAttachment")}
										data-testid="attach-menu"
										disabled={encoding || !sessionUsable}
									>
										{encoding ? <span className="text-[0.85rem] leading-none">…</span> : <Paperclip className="h-4 w-4" aria-hidden />}
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent side="top" align="start">
									<DropdownMenuItem data-testid="attach-files" disabled={encoding || !sessionUsable} onSelect={() => fileInputRef.current?.click()}>
										<Paperclip aria-hidden />
										{t("chat.attachFiles")}
									</DropdownMenuItem>
									<DropdownMenuItem data-testid="attach-folder" disabled={encoding || !sessionUsable} onSelect={() => folderInputRef.current?.click()}>
										<FolderOpen aria-hidden />
										{t("chat.attachFolder")}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
								<ModelPicker
									currentModelId={snapshot?.modelId}
									onChange={setModel}
									disabled={connection.kind !== "open" || snapshot?.isStreaming}
									connectionUnavailable={connection.kind !== "open"}
								/>
								{snapshot?.modelSwitches?.length ? ((last) => (
									<span
										className="text-[0.74rem] text-muted-foreground truncate max-w-[16rem]"
										title={snapshot.modelSwitches.map((event) => `${event.from} → ${event.to}: ${event.reason}`).join("\n")}
										data-testid="model-switch-indicator"
									>
										{t(last.kind === "model" ? "chat.modelFallback" : "chat.accountFailover", { model: last.to })}
									</span>
								))(snapshot.modelSwitches[snapshot.modelSwitches.length - 1]) : null}
								<div className="@max-[520px]:hidden">
									<ProviderAccountBadge
										currentModelId={snapshot?.modelId}
										onClick={() => {
											// Land directly on the Provider tab where account
											// management lives - without ?section=chat, the
											// page boots into "appearance" (Paper Theme).
											window.location.assign("/settings?section=chat");
										}}
									/>
								</div>
								<ThinkingPicker
									current={snapshot?.thinkingLevel}
									onChange={setThinkingLevel}
									disabled={connection.kind !== "open" || snapshot?.isStreaming}
								/>
							</div>
							<div className="ml-auto flex items-center gap-1 @max-[420px]:gap-0 @max-[300px]:ml-0 @max-[300px]:w-full @max-[300px]:justify-between">
								{liveConversation.supported && (
									<button
										type="button"
										className={cn(
											"inline-flex h-7 flex-none items-center justify-center gap-1 rounded-full px-2",
											"@max-[420px]:h-9 @max-[420px]:w-9 @max-[420px]:px-0",
											"max-[520px]:!h-[44px] max-[520px]:!w-[44px] max-[520px]:!px-0",
											"transition-[background-color,color,border-color,transform] duration-150 ease-[ease]",
											"focus-visible:outline-2 focus-visible:outline-[color-mix(in_oklch,var(--accent)_55%,transparent)] focus-visible:outline-offset-1",
											liveInteractionEnabled
												? "bg-[color-mix(in_oklch,var(--accent)_16%,transparent)] text-[var(--accent)]"
												: "text-[var(--foreground-50)] hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:text-[var(--foreground)]",
											"disabled:cursor-not-allowed disabled:opacity-50",
										)}
										title={liveInteractionEnabled
											? t("chat.closeLiveVoice")
											: t("chat.openLiveVoiceDescription")}
										aria-label={
											liveInteractionEnabled
												? t("chat.closeLiveVoice")
												: t("chat.openLiveVoice")
										}
										aria-pressed={liveInteractionEnabled}
										data-testid="voice-interaction-toggle"
										disabled={!goalId || connection.kind !== "open"}
										onClick={() =>
											void (liveInteractionEnabled
												? liveConversation.stop()
												: liveConversation.start())
										}
									>
										<MessageCircle className="h-3.5 w-3.5" aria-hidden />
										<span className="text-[0.7rem] @max-[620px]:hidden">
											{t("chat.conversation")}
										</span>
									</button>
								)}
								{voiceInput.supported && (
									<button
										type="button"
										className={cn(
											ICON_BUTTON_BASE,
											"@max-[420px]:h-9 @max-[420px]:w-9",
											"max-[520px]:!h-[44px] max-[520px]:!w-[44px]",
											"text-[var(--foreground-50)] cursor-pointer rounded-full",
											"hover:text-[var(--foreground)] hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]",
											voiceInput.state.status === "recording" &&
												"text-[var(--destructive)] bg-[color-mix(in_oklch,var(--destructive)_15%,transparent)] hover:bg-[color-mix(in_oklch,var(--destructive)_25%,transparent)]",
											voiceInput.state.status === "starting" &&
												"text-[var(--destructive)] bg-[color-mix(in_oklch,var(--destructive)_15%,transparent)] hover:bg-[color-mix(in_oklch,var(--destructive)_25%,transparent)]",
											voiceInput.state.status === "finalizing" &&
												"text-[var(--destructive)] bg-[color-mix(in_oklch,var(--destructive)_15%,transparent)] hover:bg-[color-mix(in_oklch,var(--destructive)_25%,transparent)]",
											"disabled:opacity-50 disabled:cursor-not-allowed",
										)}
										title={voiceInputControl.title}
										aria-label={voiceInputControl.ariaLabel}
										aria-pressed={voiceInput.state.status === "recording"}
										aria-busy={voiceInputControl.ariaBusy}
										data-testid="voice-input"
										disabled={
											voiceInputControl.disabled ||
											liveInteractionEnabled ||
											(voiceInputControl.action === "start" &&
												(!goalId || connection.kind !== "open"))
										}
										onClick={() => void handleMicClick()}
									>
										{voiceInput.state.status === "starting" ||
										voiceInput.state.status === "finalizing" ? (
											<X className="h-4 w-4" aria-hidden />
										) : voiceInput.state.status === "recording" ? (
											<Square className="h-3.5 w-3.5" fill="currentColor" aria-hidden />
										) : (
											<Mic className="h-4 w-4" aria-hidden />
										)}
									</button>
								)}
								{composerSendControls.showAbort && (
									<button
										type="button"
										className={cn(
											ICON_BUTTON_BASE,
											"@max-[420px]:h-9 @max-[420px]:w-9",
											"max-[520px]:!h-[44px] max-[520px]:!w-[44px]",
											"bg-transparent text-[var(--foreground)] cursor-pointer rounded-full",
											"hover:bg-[color-mix(in_oklch,var(--destructive)_20%,transparent)]",
										)}
										title={isStopping ? t("chat.stopping") : t("chat.stopResponse")}
										aria-label={isStopping ? t("chat.stopping") : t("chat.stopResponse")}
										disabled={isStopping}
										onClick={() => void abort()}
									>
										<Square className="h-3 w-3 fill-current" aria-hidden />
									</button>
								)}
								{composerSendControls.showSend && (
									<button
										type="submit"
										className={cn(
											ICON_BUTTON_BASE,
											"@max-[420px]:h-9 @max-[420px]:w-9",
											"max-[520px]:!h-[44px] max-[520px]:!w-[44px]",
											"bg-transparent text-[var(--foreground)] cursor-pointer rounded-full",
											"hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]",
											"disabled:opacity-50 disabled:cursor-not-allowed",
										)}
										title={t("chat.send")}
										aria-label={t("chat.send")}
										disabled={!canSend}
									>
										{sending ? (
											<span className="text-[0.85rem] leading-none">…</span>
										) : (
											<ArrowUp className="h-4 w-4" aria-hidden />
										)}
									</button>
								)}
							</div>
						</div>
					</motion.div>
					{lastError && (
						<div className="flex gap-[0.6rem] items-center text-[0.7rem] text-[var(--foreground-30)] flex-wrap pt-0 px-[0.35rem] pb-[0.1rem] min-h-4">
							<span className="text-[var(--destructive)]">{t("chat.sendFailed", { error: lastError })}</span>
						</div>
					)}
					{(voiceNotice || voiceInput.state.error) ? (
						<VoiceCorrectionLearningNotice
							message={
								voiceNotice?.message ||
								voiceInput.state.error ||
								""
							}
							corrections={voiceNotice?.corrections ?? []}
							undoing={undoingVoiceNoticeId === voiceNotice?.id}
							onUndo={() => void handleUndoVoiceLearning()}
							tone={!voiceNotice && voiceInput.state.error ? "error" : "muted"}
						/>
					) : null}
				</div>
			</form>
		</div>
	);
}

async function submitVoiceCorrectionObservation(
	originalText: string,
	editedText: string,
): Promise<string[]> {
	try {
		const data = await voiceApi.correctionLearning.observe(originalText, editedText);
		return Array.isArray(data.corrections)
			? data.corrections.filter(
					(value: unknown): value is string => typeof value === "string",
				)
			: [];
	} catch (error) {
		console.warn(
			`[voice] correction learning failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return [];
	}
}

async function undoVoiceCorrectionLearning(corrections: string[]): Promise<string[]> {
	const data = await voiceApi.correctionLearning.undo(corrections);
	return Array.isArray(data.removed)
		? data.removed.filter(
				(value: unknown): value is string => typeof value === "string",
			)
		: [];
}
