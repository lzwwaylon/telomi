import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import {
	DEFAULT_UI_LOCALE,
	localeDefinitions,
	UI_LOCALES,
	type UiLocale,
} from "@/app/locales";
import type { MessageId } from "@/app/locales/zh-CN";

export { DEFAULT_UI_LOCALE, UI_LOCALES, type UiLocale } from "@/app/locales";

const UI_LOCALE_KEY = "telomi.ui-locale";
export const resources = Object.fromEntries(
	UI_LOCALES.map((locale) => [locale, { translation: localeDefinitions[locale].messages }]),
) as Record<UiLocale, { translation: Record<MessageId, string> }>;

export function normalizeUiLocale(value: unknown): UiLocale | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	for (const locale of UI_LOCALES) {
		const definition = localeDefinitions[locale];
		if (normalized === locale.toLowerCase()) return locale;
		if (definition.aliases.some((alias) => normalized === alias || normalized.startsWith(`${alias}-`))) return locale;
	}
	return null;
}

function safeStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function resolveInitialUiLocale(): UiLocale {
	const stored = normalizeUiLocale(safeStorage()?.getItem(UI_LOCALE_KEY));
	if (stored) return stored;
	if (typeof navigator !== "undefined") {
		for (const candidate of navigator.languages ?? [navigator.language]) {
			const locale = normalizeUiLocale(candidate);
			if (locale) return locale;
		}
	}
	return DEFAULT_UI_LOCALE;
}

export function applyDocumentLocale(locale: UiLocale): void {
	if (typeof document === "undefined") return;
	document.documentElement.lang = locale;
	document.documentElement.dir = localeDefinitions[locale].direction;
}

export function currentUiLocale(): UiLocale {
	return normalizeUiLocale(i18n.resolvedLanguage ?? i18n.language) ?? DEFAULT_UI_LOCALE;
}

export async function setUiLocale(locale: UiLocale): Promise<void> {
	safeStorage()?.setItem(UI_LOCALE_KEY, locale);
	applyDocumentLocale(locale);
	await i18n.changeLanguage(locale);
}

const initialLocale = resolveInitialUiLocale();

if (!i18n.isInitialized) {
	void i18n.use(initReactI18next).init({
		initAsync: false,
		lng: initialLocale,
		fallbackLng: DEFAULT_UI_LOCALE,
		supportedLngs: UI_LOCALES,
		load: "currentOnly",
		keySeparator: false,
		resources,
		interpolation: { escapeValue: false },
		returnNull: false,
	});
}

applyDocumentLocale(initialLocale);

export default i18n;
