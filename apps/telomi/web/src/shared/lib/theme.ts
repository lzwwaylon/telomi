import type { MessageId } from "@/app/locales/zh-CN";

export interface FontConfig {
	ui: string | null;
	mono: string | null;
}

export type PaperTheme = "light" | "dark";
export type PaperThemePreference = PaperTheme | "system";

export interface PaperThemeOption {
	value: PaperThemePreference;
	labelKey: MessageId;
	hintKey: MessageId;
	swatch: string;
}

const PAPER_THEME_KEY = "telomi.theme";
const FONT_KEY = "mom:font";
const DEFAULT_MODEL_KEY = "mom:default-model";
export const PAPER_THEME_CHANGE_EVENT = "mom:paper-theme-change";
export const PAPER_THEME_PREF_CHANGE_EVENT = "mom:paper-theme-pref-change";
const DEFAULT_FONT: FontConfig = { ui: null, mono: null };
const VALID_PAPER_THEMES: ReadonlySet<PaperTheme> = new Set(["light", "dark"]);
const VALID_PAPER_THEME_PREFS: ReadonlySet<PaperThemePreference> = new Set(["system", "light", "dark"]);
export const PAPER_THEME_OPTIONS: readonly PaperThemeOption[] = [
	{
		value: "system",
		labelKey: "settings.themeSystem",
		hintKey: "settings.themeSystemHint",
		swatch: "var(--paper-theme-system-swatch)",
	},
	{
		value: "light",
		labelKey: "settings.themeLight",
		hintKey: "settings.themeLightHint",
		swatch: "var(--paper-theme-light-swatch)",
	},
	{
		value: "dark",
		labelKey: "settings.themeDark",
		hintKey: "settings.themeDarkHint",
		swatch: "var(--paper-theme-dark-swatch)",
	},
];
function paperThemeIsDark(theme: PaperTheme): boolean {
	return theme !== "light";
}

function safeLocalStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function dispatchWindowEvent<T>(type: string, detail: T): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent<T>(type, { detail }));
}

function syncPaperThemeAttrs(theme: PaperTheme): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.classList.remove("dark");
	root.dataset.paperTheme = theme;
	root.dataset.paperDark = paperThemeIsDark(theme) ? "true" : "false";
	document.body.dataset.theme = theme;
}

function writeFontVars(font: FontConfig): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (font.ui) root.style.setProperty("--font-sans-user", font.ui);
	else root.style.removeProperty("--font-sans-user");
	if (font.mono) root.style.setProperty("--font-mono-user", font.mono);
	else root.style.removeProperty("--font-mono-user");
}

function getSystemPaperTheme(): PaperTheme {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getStoredPaperThemePreference(fallback: PaperThemePreference = "system"): PaperThemePreference {
	const store = safeLocalStorage();
	if (!store) return fallback;
	const raw = store.getItem(PAPER_THEME_KEY);
	return VALID_PAPER_THEME_PREFS.has(raw as PaperThemePreference) ? (raw as PaperThemePreference) : fallback;
}

export function getStoredPaperTheme(): PaperTheme {
	const pref = getStoredPaperThemePreference("system");
	return pref === "system" ? getSystemPaperTheme() : pref;
}

export function setPaperThemePreference(pref: PaperThemePreference): void {
	if (!VALID_PAPER_THEME_PREFS.has(pref)) return;
	const store = safeLocalStorage();
	if (store) store.setItem(PAPER_THEME_KEY, pref);
	const effective = pref === "system" ? getSystemPaperTheme() : pref;
	syncPaperThemeAttrs(effective);
	dispatchWindowEvent(PAPER_THEME_PREF_CHANGE_EVENT, pref);
	dispatchWindowEvent(PAPER_THEME_CHANGE_EVENT, effective);
}

let systemThemeMedia: MediaQueryList | null = null;
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

function detachSystemThemeListener(): void {
	if (!systemThemeMedia || !systemThemeListener) return;
	if (typeof systemThemeMedia.removeEventListener === "function") {
		systemThemeMedia.removeEventListener("change", systemThemeListener);
	} else if (typeof (systemThemeMedia as unknown as { removeListener?: (cb: (e: MediaQueryListEvent) => void) => void }).removeListener === "function") {
		(systemThemeMedia as unknown as { removeListener: (cb: (e: MediaQueryListEvent) => void) => void }).removeListener(systemThemeListener);
	}
	systemThemeListener = null;
}

function attachSystemThemeListener(): void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
	detachSystemThemeListener();
	systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
	systemThemeListener = () => {
		if (getStoredPaperThemePreference() !== "system") return;
		const effective = getSystemPaperTheme();
		syncPaperThemeAttrs(effective);
		dispatchWindowEvent(PAPER_THEME_CHANGE_EVENT, effective);
	};
	if (typeof systemThemeMedia.addEventListener === "function") {
		systemThemeMedia.addEventListener("change", systemThemeListener);
	} else if (typeof (systemThemeMedia as unknown as { addListener?: (cb: (e: MediaQueryListEvent) => void) => void }).addListener === "function") {
		(systemThemeMedia as unknown as { addListener: (cb: (e: MediaQueryListEvent) => void) => void }).addListener(systemThemeListener);
	}
}

export function applyStoredPaperTheme(): void {
	syncPaperThemeAttrs(getStoredPaperTheme());
	writeFontVars(getStoredFont());
	attachSystemThemeListener();
}

export function isCurrentPaperThemeDark(): boolean {
	if (typeof document !== "undefined") {
		const theme = document.body.dataset.theme as PaperTheme | undefined;
		if (theme && VALID_PAPER_THEMES.has(theme)) return paperThemeIsDark(theme);
	}
	return paperThemeIsDark(getStoredPaperTheme());
}

export function getStoredFont(): FontConfig {
	const store = safeLocalStorage();
	if (!store) return DEFAULT_FONT;
	try {
		const raw = store.getItem(FONT_KEY);
		if (!raw) return DEFAULT_FONT;
		const parsed = JSON.parse(raw) as FontConfig;
		return {
			ui: typeof parsed.ui === "string" && parsed.ui.trim() ? parsed.ui : null,
			mono: typeof parsed.mono === "string" && parsed.mono.trim() ? parsed.mono : null,
		};
	} catch {
		return DEFAULT_FONT;
	}
}

export function initTheme(): () => void {
	applyStoredPaperTheme();
	return () => {};
}

export function setStoredDefaultModel(modelId: string | null): void {
	const store = safeLocalStorage();
	if (store) {
		if (modelId) store.setItem(DEFAULT_MODEL_KEY, modelId);
		else store.removeItem(DEFAULT_MODEL_KEY);
	}
	dispatchWindowEvent("mom:default-model-change", modelId);
}
