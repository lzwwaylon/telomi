import {
	AudioWaveform,
	ChevronDown,
	CircleCheck,
	CircleDashed,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";
import { isManagedAudioConnection } from "@shared/connections.js";

export interface VoiceVadConfigValue {
	enabled: boolean;
	threshold: number;
	minSpeechDurationMs: number;
	minSilenceDurationMs: number;
	maxSpeechDurationS: number;
	speechPadMs: number;
	samplesOverlap: number;
}

export interface VoiceVadStatusValue {
	provider: string;
	version: string;
	defaultEnabled: boolean;
	modelExists: boolean;
	modelLoaded: boolean;
	expectedSha256: string;
}

const FIELDS: Array<{
	key: Exclude<keyof VoiceVadConfigValue, "enabled">;
	label: MessageId;
	note: MessageId;
	min: number;
	max: number;
	step: number;
	unit: string;
}> = [
	{
		key: "threshold",
		label: "common.speechThreshold",
		note: "common.startASpeechSegmentWhenTheProbabilityExceedsThis",
		min: 0.1,
		max: 0.95,
		step: 0.01,
		unit: "prob",
	},
	{
		key: "minSpeechDurationMs",
		label: "common.minimumSpeech",
		note: "common.filterVeryShortTapsAndIncidentalNoise",
		min: 50,
		max: 2_000,
		step: 10,
		unit: "ms",
	},
	{
		key: "minSilenceDurationMs",
		label: "common.minimumSilence",
		note: "common.silenceToWaitBeforeEndingASpeechSegment",
		min: 50,
		max: 2_000,
		step: 10,
		unit: "ms",
	},
	{
		key: "maxSpeechDurationS",
		label: "common.maximumSpeechSegment",
		note: "common.splitVeryLongContinuousSpeechAtShortPausesWhen",
		min: 5,
		max: 120,
		step: 1,
		unit: "s",
	},
	{
		key: "speechPadMs",
		label: "common.speechPadding",
		note: "common.avoidClippingConsonantStartsAndQuietSentenceEndings",
		min: 0,
		max: 1_000,
		step: 10,
		unit: "ms",
	},
	{
		key: "samplesOverlap",
		label: "common.overlapContext",
		note: "common.totalContextAddedAroundEachRetainedSegment",
		min: 0,
		max: 0.95,
		step: 0.01,
		unit: "s",
	},
];

export function VoiceVadSettings({
	provider,
	value,
	status,
	disabled,
	onChange,
}: {
	provider: string;
	value: VoiceVadConfigValue;
	status: VoiceVadStatusValue | null;
	disabled: boolean;
	onChange: (value: VoiceVadConfigValue) => void;
}) {
	const localProvider = isManagedAudioConnection(provider);
	const controlsDisabled = disabled || !localProvider;
	const modelReady = status?.modelExists === true;

	return (
		<section
			className="grid gap-0 overflow-hidden rounded-[0.55rem] border border-border bg-card"
			data-testid="voice-vad-settings"
		>
			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 px-3 py-3 max-[620px]:grid-cols-1">
				<div className="flex min-w-0 items-start gap-2.5">
					<div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-[0.4rem] bg-[var(--foreground-5)] text-muted-foreground">
						<AudioWaveform className="h-4 w-4" aria-hidden />
					</div>
					<div className="min-w-0 grid gap-1">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.voicevadsettings.localNeuralVoiceSegmentation")}</h3>
							<span className="font-mono text-[0.7rem] text-muted-foreground">
								Silero {status?.version ?? "v5.1.2"}
							</span>
						</div>
						<p className="m-0 max-w-[64ch] text-[0.8rem] leading-relaxed text-muted-foreground">
							{uiText("settings.voicevadsettings.removeLongSilencesWhilePreservingSpeechBoundariesBeforeQwen")}
						</p>
					</div>
				</div>
				<label
					className={`inline-flex items-center gap-2 pt-1 text-[0.82rem] ${
						localProvider ? "text-foreground" : "text-muted-foreground"
					}`}
				>
					<input
						type="checkbox"
						checked={value.enabled}
						disabled={controlsDisabled}
						onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
						data-testid="voice-vad-enabled"
					/>
					{uiText("settings.voicevadsettings.enableLocalVad")}
				</label>
			</div>

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-[0.76rem] text-muted-foreground">
				{!localProvider ? (
					<span className="flex items-center gap-1.5">
						<CircleDashed className="h-3.5 w-3.5" aria-hidden />
						{uiText("settings.voicevadsettings.onlyTheLocalTelomiAudioProviderRunsThisStep")}
					</span>
				) : modelReady ? (
					<span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400" data-testid="voice-vad-model-ready">
						<CircleCheck className="h-3.5 w-3.5" aria-hidden />
						{uiText("settings.voicevadsettings.modelFileReady")}{status?.modelLoaded ? uiText("settings.voicevadsettings.loadedInThisProcess") : uiText("settings.voicevadsettings.loadsOnFirstUse")}
					</span>
				) : status ? (
					<span className="flex items-center gap-1.5 text-destructive" data-testid="voice-vad-model-missing">
						<TriangleAlert className="h-3.5 w-3.5" aria-hidden />
						{uiText("settings.voicevadsettings.theModelFileIsMissingTheStartupScriptWill")}
					</span>
				) : (
					<span className="flex items-center gap-1.5">
						<CircleDashed className="h-3.5 w-3.5" aria-hidden />
						{uiText("settings.voicevadsettings.telomiAudioIsDisconnectedSoLocalModelStatusIs")}
					</span>
				)}
				<span>{uiText("settings.voicevadsettings.ifProcessingFailsContinueByTranscribingTheOriginalAudio")}</span>
			</div>

			<details className="group border-t border-border" data-testid="voice-vad-advanced">
				<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[0.8rem] font-medium text-foreground marker:content-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--input)]">
					<span>{uiText("settings.voicevadsettings.advancedSegmentationSettings")}</span>
					<ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-150 group-open:rotate-180" aria-hidden />
				</summary>
				<div className="grid grid-cols-2 gap-x-5 gap-y-4 border-t border-border px-3 py-3 max-[620px]:grid-cols-1">
					{FIELDS.map(({ key, ...field }) => (
						<VadNumberField
							key={key}
							{...field}
							value={value[key]}
							disabled={controlsDisabled}
							onCommit={(next) => onChange({ ...value, [key]: next })}
						/>
					))}
				</div>
			</details>
		</section>
	);
}

function VadNumberField({
	label,
	note,
	value,
	min,
	max,
	step,
	unit,
	disabled,
	onCommit,
}: {
	label: MessageId;
	note: MessageId;
	value: number;
	min: number;
	max: number;
	step: number;
	unit: string;
	disabled: boolean;
	onCommit: (value: number) => void;
}) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);

	const commit = () => {
		const parsed = Number(draft);
		if (!Number.isFinite(parsed)) {
			setDraft(String(value));
			return;
		}
		onCommit(Math.min(max, Math.max(min, parsed)));
	};

	return (
		<label className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-start gap-x-3 gap-y-1 max-[380px]:grid-cols-1">
			<span className="grid gap-0.5">
				<span className="text-[0.78rem] font-medium text-foreground">{uiText(label)}</span>
				<span className="text-[0.73rem] leading-snug text-muted-foreground">{uiText(note)}</span>
			</span>
			<span className="grid grid-cols-[minmax(0,1fr)_auto] items-center overflow-hidden rounded-[0.45rem] border border-border bg-popover focus-within:border-[var(--input)]">
				<input
					type="number"
					value={draft}
					min={min}
					max={max}
					step={step}
					disabled={disabled}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") {
							setDraft(String(value));
							event.currentTarget.blur();
						}
					}}
					className="min-w-0 bg-transparent px-2 py-1.5 text-right font-mono text-[0.78rem] text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50"
				/>
				<span className="border-l border-border px-1.5 font-mono text-[0.66rem] text-muted-foreground">
					{unit}
				</span>
			</span>
		</label>
	);
}
