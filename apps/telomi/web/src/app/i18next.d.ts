import "i18next";
import type { zhCNMessages } from "@/app/locales/zh-CN";

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "translation";
		resources: {
			translation: typeof zhCNMessages;
		};
	}
}
