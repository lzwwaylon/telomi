import { uiText } from "@/app/ui-text";

export interface VoiceCorrectionLearningNoticeProps {
	message: string;
	corrections: string[];
	undoing: boolean;
	onUndo: () => void;
	tone?: "muted" | "error";
}

export function VoiceCorrectionLearningNotice({
	message,
	corrections,
	undoing,
	onUndo,
	tone = "muted",
}: VoiceCorrectionLearningNoticeProps) {
	const isError = tone === "error";

	return (
		<div
			className={`flex gap-[0.6rem] items-center flex-wrap pt-0 px-[0.35rem] pb-[0.1rem] min-h-4 ${
				isError
					? "text-[0.75rem] text-[var(--destructive)]"
					: "text-[0.7rem] text-[var(--foreground-30)]"
			}`}
		>
			<span
				role={isError ? "alert" : "status"}
				aria-live={isError ? "assertive" : "polite"}
			>
				{message}
			</span>
			{corrections.length > 0 ? (
				<button
					type="button"
					className="rounded-[0.35rem] border border-[color-mix(in_oklch,var(--foreground)_15%,transparent)] px-1.5 py-0.5 font-medium text-[var(--foreground-50)] transition-colors hover:border-[color-mix(in_oklch,var(--foreground)_30%,transparent)] hover:text-[var(--foreground)] disabled:cursor-wait disabled:opacity-50"
					disabled={undoing}
					onClick={onUndo}
					aria-label={uiText("settings.voicecorrectionlearningnotice.undoThisAutomaticLearning")}
					data-testid="voice-correction-undo"
				>
					{undoing ? uiText("settings.voicecorrectionlearningnotice.undoing") : uiText("settings.voicecorrectionlearningnotice.undoAutomaticLearning")}
				</button>
			) : null}
		</div>
	);
}
