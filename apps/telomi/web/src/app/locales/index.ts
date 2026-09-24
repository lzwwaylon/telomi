import { enMessages } from "@/app/locales/en";
import { zhCNMessages } from "@/app/locales/zh-CN";

export const localeDefinitions = {
	"zh-CN": {
		messages: zhCNMessages,
		nativeName: "简体中文",
		direction: "ltr",
		aliases: ["zh"],
	},
	en: {
		messages: enMessages,
		nativeName: "English",
		direction: "ltr",
		aliases: ["en"],
	},
} as const;

export type UiLocale = keyof typeof localeDefinitions;
export const UI_LOCALES = Object.keys(localeDefinitions) as UiLocale[];
export const DEFAULT_UI_LOCALE: UiLocale = "en";
export const UI_LOCALE_OPTIONS = UI_LOCALES.map((value) => ({
	value,
	label: localeDefinitions[value].nativeName,
}));
