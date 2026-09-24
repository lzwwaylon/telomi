import type { LucideIcon } from "lucide-react";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";

/** One dictation behavior switch: icon, title, description and a checkbox that patches `/api/audio-config`. */
export function VoiceToggleSettings({
	icon: Icon,
	heading,
	description,
	toggleLabel,
	field,
	enabled,
	disabled,
	onPatch,
	testId,
}: {
	icon: LucideIcon;
	heading: MessageId;
	description: MessageId;
	toggleLabel: MessageId;
	field: "audioCuesEnabled";
	enabled: boolean;
	disabled: boolean;
	onPatch: (patch: Record<string, unknown>) => void;
	testId: string;
}) {
	return (
		<section
			className="grid gap-3 rounded-[0.55rem] border border-border bg-card px-3 py-3"
			data-testid={`${testId}-settings`}
		>
			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 max-[640px]:grid-cols-1">
				<div className="flex min-w-0 items-start gap-2.5">
					<div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-[0.45rem] bg-[var(--foreground-5)] text-muted-foreground">
						<Icon className="h-4 w-4" aria-hidden />
					</div>
					<div className="min-w-0 grid gap-1">
						<h3 className="m-0 text-[0.95rem] font-medium">{uiText(heading)}</h3>
						<p className="m-0 text-[0.8rem] leading-relaxed text-muted-foreground">{uiText(description)}</p>
					</div>
				</div>
				<label className="inline-flex items-center gap-2 text-[0.82rem] text-foreground">
					<input
						type="checkbox"
						checked={enabled}
						disabled={disabled}
						onChange={(event) => onPatch({ [field]: event.target.checked })}
						data-testid={`${testId}-enabled`}
					/>
					{uiText(toggleLabel)}
				</label>
			</div>
		</section>
	);
}
