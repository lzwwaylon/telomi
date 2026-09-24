import type { VoiceInputStatus } from "@/features/voice/useVoiceInputSession";

export type VoiceInputControlAction = "start" | "stop" | "cancel";

export interface VoiceInputControl {
	action: VoiceInputControlAction;
	ariaBusy: boolean;
	ariaLabel: string;
	disabled: boolean;
	title: string;
}

export function isVoiceInputCancellable(status: VoiceInputStatus): boolean {
	return status === "starting" || status === "recording" || status === "finalizing";
}

export function shouldPreserveCancelledVoiceRecording(
	status: VoiceInputStatus,
): boolean {
	return status === "recording";
}

export function resolveVoiceInputControl(
	status: VoiceInputStatus,
	translate?: (key: string, options?: Record<string, unknown>) => string,
): VoiceInputControl {
	const text = (key: string, fallback: string, options?: Record<string, unknown>) => translate?.(key, options) ?? fallback;
	switch (status) {
		case "starting":
			return {
				action: "cancel",
				ariaBusy: true,
				ariaLabel: text("chat.voiceCancelStarting", "取消启动语音输入"),
				disabled: false,
				title: text("chat.voiceCancelMicrophone", "取消麦克风启动"),
			};
		case "recording":
			return {
				action: "stop",
				ariaBusy: false,
				ariaLabel: text("chat.voiceStop", "停止录音"),
				disabled: false,
				title: text("chat.voiceStopDescription", "结束录音并转为文字"),
			};
		case "finalizing":
			return {
				action: "cancel",
				ariaBusy: true,
				ariaLabel: text("chat.voiceCancelFinalizing", "取消语音文本确认"),
				disabled: false,
				title: text("chat.voiceCancelFinalText", "取消最终文本确认"),
			};
		case "idle":
		case "error":
			return {
				action: "start",
				ariaBusy: false,
				ariaLabel: text("chat.voiceStart", "开始语音输入"),
				disabled: false,
				title: text("chat.voiceStartDescription", "语音输入(手动结束后转为文字)"),
			};
	}
}
