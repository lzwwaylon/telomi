import { Languages } from "lucide-react";
import { VOICE_LANGUAGE_OPTIONS } from "@shared/voice-languages.js";
import { useTranslation } from "react-i18next";
import { uiText } from "@/app/ui-text";

export interface VoiceLanguageSettingsProps {
	value: string;
	disabled?: boolean;
	onChange: (value: string) => void;
}

export function VoiceLanguageSettings({
	value,
	disabled = false,
	onChange,
}: VoiceLanguageSettingsProps) {
	const { t, i18n } = useTranslation();
	const displayNames = new Intl.DisplayNames(i18n.resolvedLanguage ?? "en", { type: "language" });
	return (
		<section
			className="grid gap-3 rounded-[0.55rem] border border-border bg-card px-3 py-3"
			data-testid="voice-language-settings"
		>
			<div className="flex items-start gap-2.5">
				<div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-[0.45rem] bg-[var(--foreground-5)] text-muted-foreground">
					<Languages className="h-4 w-4" aria-hidden />
				</div>
				<div className="min-w-0 grid gap-1">
					<h3 className="m-0 text-[0.95rem] font-medium">{t("settings.voiceLanguageTitle")}</h3>
					<p className="m-0 text-[0.8rem] leading-relaxed text-muted-foreground">
						{t("settings.voiceLanguageDescription")}
					</p>
				</div>
			</div>

			<label className="grid gap-1.5">
				<span className="text-[0.78rem] font-medium text-muted-foreground">
						{t("settings.voiceLanguageLabel")}
				</span>
				<select
					value={value}
					onChange={(event) => onChange(event.target.value)}
					disabled={disabled}
					className="appearance-none w-full rounded-[0.55rem] border border-border bg-popover px-3 py-2 text-[0.9rem] text-foreground cursor-pointer transition-colors hover:border-[var(--input)] focus-visible:border-[var(--input)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
					data-testid="voice-language-select"
				>
					{VOICE_LANGUAGE_OPTIONS.map((option) => (
						<option key={option.code} value={option.code}>
								{option.code === "auto"
									? uiText("common.autoDetect")
									: displayNames.of(option.code) ?? option.label}
						</option>
					))}
				</select>
			</label>

			<div className="rounded-[0.45rem] bg-[var(--foreground-5)] px-2.5 py-2 text-[0.78rem] leading-relaxed text-muted-foreground">
				{t("settings.voiceLanguageHint")}
			</div>
		</section>
	);
}
