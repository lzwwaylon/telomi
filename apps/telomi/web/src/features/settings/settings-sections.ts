export const SETTINGS_SECTIONS = ["chat", "embedding", "tts", "stt", "sources", "appearance"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Older deep links keep working: credentials now live on each capability page, the overview is
 * gone, and the `audio` / `voice` pages folded into recognition.
 */
const ALIASES: Record<string, SettingsSection> = { overview: "chat", connections: "chat", provider: "chat", audio: "stt", voice: "stt" };

export function parseSettingsSection(value: string | null): SettingsSection {
  if (!value) return "chat";
  if ((SETTINGS_SECTIONS as readonly string[]).includes(value)) return value as SettingsSection;
  return ALIASES[value] ?? "chat";
}
