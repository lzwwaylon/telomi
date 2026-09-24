import { useState } from "react";
import { Brain } from "lucide-react";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { uiText } from "@/app/ui-text";

interface ThinkingPickerProps {
	current?: ThinkingLevel;
	onChange: (level: ThinkingLevel) => Promise<void>;
	disabled?: boolean;
}

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const LABELS: Record<ThinkingLevel, string> = {
	off: "off",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "high",
	xhigh: "x-high",
	max: "max",
};

export function ThinkingPicker({ current, onChange, disabled }: ThinkingPickerProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
		const next = e.target.value as ThinkingLevel;
		if (!next || next === current) return;
		setBusy(true);
		setError(null);
		try {
			await onChange(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const value: ThinkingLevel = current ?? "off";

	return (
		<span
			className="relative inline-flex flex-none items-center"
			title={error ? uiText("chat.thinkingpicker.thinkingEffortErrorError", { error }) : uiText("chat.thinkingpicker.thinkingEffort")}
		>
			<Brain
				className="absolute left-[0.5rem] top-1/2 -translate-y-1/2 h-[0.95rem] w-[0.95rem] @max-[420px]:left-1/2 @max-[420px]:-translate-x-1/2 max-[520px]:left-1/2 max-[520px]:-translate-x-1/2 text-[var(--foreground-50)] pointer-events-none"
				aria-hidden
			/>
			<select
				className="appearance-none h-7 bg-transparent text-[var(--foreground-50)] border border-transparent rounded-[6px] pr-[1.1rem] pl-[1.6rem] font-[inherit] text-[13px] leading-[1.1] cursor-pointer max-w-[140px] @max-[420px]:h-9 @max-[420px]:w-9 @max-[420px]:p-0 @max-[420px]:text-transparent max-[520px]:!h-[44px] max-[520px]:!w-[44px] max-[520px]:!p-0 max-[520px]:text-transparent transition-colors duration-[120ms] ease-[ease] [&:hover:not(:disabled)]:text-[var(--foreground)] @max-[420px]:[&:hover:not(:disabled)]:text-transparent max-[520px]:[&:hover:not(:disabled)]:text-transparent [&:hover:not(:disabled)]:bg-[var(--foreground-5)] focus-visible:outline-2 focus-visible:outline-[var(--input)] focus-visible:outline-offset-1 disabled:opacity-50 disabled:cursor-default"
				value={value}
				onChange={handleChange}
				disabled={disabled || busy}
					aria-label={uiText("chat.thinkingpicker.thinkingEffort")}
				aria-busy={busy}
			>
				{LEVELS.map((lvl) => (
					<option key={lvl} value={lvl}>
						{LABELS[lvl]}
					</option>
				))}
			</select>
			<span
				className="absolute right-[0.35rem] top-1/2 -translate-y-1/2 text-[0.55rem] text-[var(--foreground-30)] pointer-events-none @max-[420px]:hidden max-[520px]:hidden"
				aria-hidden
			>
				▾
			</span>
		</span>
	);
}
