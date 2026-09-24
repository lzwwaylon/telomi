import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
	PAPER_THEME_OPTIONS,
	PAPER_THEME_PREF_CHANGE_EVENT,
	getStoredPaperThemePreference,
	setPaperThemePreference,
	type PaperThemePreference,
} from "@/shared/lib/theme";
import { useTranslation } from "react-i18next";

export function PaperThemePicker() {
	const { t } = useTranslation();
	const [pref, setPref] = useState<PaperThemePreference>(() => getStoredPaperThemePreference());
	const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<PaperThemePreference>).detail;
			if (detail) setPref(detail);
		};
		window.addEventListener(PAPER_THEME_PREF_CHANGE_EVENT, handler);
		return () => window.removeEventListener(PAPER_THEME_PREF_CHANGE_EVENT, handler);
	}, []);

	const focusAndSelect = (index: number) => {
		const count = PAPER_THEME_OPTIONS.length;
		const wrapped = ((index % count) + count) % count;
		const opt = PAPER_THEME_OPTIONS[wrapped];
		if (!opt) return;
		setPref(opt.value);
		setPaperThemePreference(opt.value);
		const btn = buttonRefs.current[wrapped];
		if (btn) btn.focus();
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
		switch (e.key) {
			case "ArrowDown":
			case "ArrowRight":
				e.preventDefault();
				focusAndSelect(currentIndex + 1);
				break;
			case "ArrowUp":
			case "ArrowLeft":
				e.preventDefault();
				focusAndSelect(currentIndex - 1);
				break;
			case "Home":
				e.preventDefault();
				focusAndSelect(0);
				break;
			case "End":
				e.preventDefault();
				focusAndSelect(PAPER_THEME_OPTIONS.length - 1);
				break;
			default:
				break;
		}
	};

	return (
		<div className="grid grid-cols-3 gap-2 max-[640px]:grid-cols-1" role="radiogroup" aria-label={t("settings.themeSelection")}>
			{PAPER_THEME_OPTIONS.map((opt, index) => {
				const active = pref === opt.value;
				return (
					<button
						key={opt.value}
						ref={(el) => {
							buttonRefs.current[index] = el;
						}}
						type="button"
						role="radio"
						aria-checked={active}
						tabIndex={active ? 0 : -1}
						onKeyDown={(e) => handleKeyDown(e, index)}
						data-testid={`paper-theme-${opt.value}`}
						onClick={() => {
							setPref(opt.value);
							setPaperThemePreference(opt.value);
						}}
						className={
							"flex items-center gap-3 rounded-[0.55rem] border bg-popover px-3 py-2.5 text-left text-foreground cursor-pointer transition-[border-color,background,box-shadow] duration-150 " +
							"hover:border-[var(--input)] hover:bg-[var(--foreground-5)] " +
							(active
								? "border-[var(--foreground)] bg-[var(--foreground-5)] shadow-[0_0_0_1px_var(--foreground)_inset]"
								: "border-border")
						}
					>
						<span
							aria-hidden
							className="h-5 w-5 rounded-full border border-border shrink-0"
							style={{ background: opt.swatch }}
						/>
						<span className="grid gap-0.5 min-w-0">
							<span className="text-[0.9rem] font-medium leading-tight">{t(opt.labelKey)}</span>
							<span className="text-[0.72rem] text-muted-foreground leading-tight">{t(opt.hintKey)}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}
