import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentUiLocale, setUiLocale, type UiLocale } from "@/app/i18n";
import { UI_LOCALE_OPTIONS } from "@/app/locales";

export function LanguageSettings() {
	const { t } = useTranslation();
	const locale = currentUiLocale();

	return (
		<section className="grid gap-3 rounded-[0.55rem] border border-border bg-card px-3 py-3" data-testid="ui-language-settings">
			<div className="flex items-start gap-2.5">
				<div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-[0.45rem] bg-[var(--foreground-5)] text-muted-foreground">
					<Languages className="h-4 w-4" aria-hidden />
				</div>
				<div className="min-w-0 grid gap-1">
					<h3 className="m-0 text-[0.95rem] font-medium">{t("locale.label")}</h3>
					<p className="m-0 text-[0.8rem] leading-relaxed text-muted-foreground">{t("locale.description")}</p>
				</div>
			</div>
			<select
				value={locale}
				onChange={(event) => {
					void setUiLocale(event.target.value as UiLocale).then(() => window.location.reload());
				}}
				className="appearance-none w-full rounded-[0.55rem] border border-border bg-popover px-3 py-2 text-[0.9rem] text-foreground cursor-pointer transition-colors hover:border-[var(--input)] focus-visible:border-[var(--input)] focus-visible:outline-none"
				aria-label={t("locale.label")}
				data-testid="ui-language-select"
			>
				{UI_LOCALE_OPTIONS.map((option) => (
					<option key={option.value} value={option.value}>{option.label}</option>
				))}
			</select>
		</section>
	);
}
