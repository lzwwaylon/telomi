import { PaperThemePicker } from "@/features/settings/PaperThemePicker";
import { LanguageSettings } from "@/features/settings/LanguageSettings";
import { SettingsPanel } from "./SettingsPanel";

export function AppearanceSettings() {
	return (
		<SettingsPanel id="appearance" heading="settings.appearanceTitle" description="settings.appearanceDescription">
			<LanguageSettings />
			<PaperThemePicker />
		</SettingsPanel>
	);
}
