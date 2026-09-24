import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon as ArrowLeft } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { useTranslation } from "react-i18next";
import { type MessageId } from "@/app/locales/zh-CN";
import { AppearanceSettings } from "./AppearanceSettings";
import { ChatModelSettings } from "./ChatModelSettings";
import { MemoryEmbeddingSettings } from "./MemoryEmbeddingSettings";
import { SearchProviderSection } from "./SearchProviderSection";
import { SettingsPanel } from "./SettingsPanel";
import { SttSettings } from "./SttSettings";
import { TtsSettings } from "./TtsSettings";
import { parseSettingsSection, type SettingsSection } from "./settings-sections";

const NAV_GROUPS: { label: MessageId; items: { key: SettingsSection; label: MessageId }[] }[] = [
  {
    label: "settings.group.models",
    items: [
      { key: "chat", label: "settings.section.chat" },
      { key: "embedding", label: "settings.section.embedding" },
      { key: "tts", label: "settings.capability.tts" },
      { key: "stt", label: "settings.capability.stt" },
    ],
  },
  { label: "settings.group.sources", items: [{ key: "sources", label: "settings.section.sources" }] },
  {
    label: "settings.group.device",
    items: [
      { key: "appearance", label: "settings.appearanceTitle" },
    ],
  },
];

const readSectionFromUrl = (): SettingsSection =>
  typeof window === "undefined" ? "chat" : parseSettingsSection(new URLSearchParams(window.location.search).get("section"));

const writeSectionToUrl = (section: SettingsSection) => {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("section") === section) return;
  params.set("section", section);
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", url);
};

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  // `?section=` is the whole navigation state: deep links land on the right page, and reloading keeps it.
  const [section, setSection] = useState<SettingsSection>(readSectionFromUrl);

  // Switching pages in the side nav replaces the history entry, so Back leaves settings.
  const open = useCallback((next: SettingsSection) => {
    writeSectionToUrl(next);
    setSection(next);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => setSection(readSectionFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <div
      className="grid grid-rows-[auto_minmax(0,1fr)] h-screen min-h-screen max-h-screen overflow-hidden bg-background text-foreground"
      data-testid="settings-page"
    >
      <header className="flex items-center gap-3 px-[clamp(1rem,0.75rem+1vw,1.75rem)] py-3 border-b border-border bg-card">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("common.back")}
          title={t("common.back")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-[0.5rem] border border-transparent text-[var(--foreground-60)] transition-colors hover:bg-[var(--foreground-5)] hover:border-border hover:text-foreground"
          data-testid="settings-back"
        >
          <ArrowLeft className="h-[1.05rem] w-[1.05rem]" aria-hidden />
        </button>
        <h1 className="m-0 font-sans font-semibold tracking-tight text-[clamp(1.05rem,0.9rem+0.4vw,1.25rem)] leading-none">
          {t("settings.title")}
        </h1>
      </header>

      <div className="grid grid-cols-[220px_minmax(0,1fr)] min-h-0 max-[760px]:grid-cols-[1fr]">
        <nav
          className="border-r border-border bg-card p-3 overflow-y-auto max-[760px]:flex max-[760px]:gap-1 max-[760px]:overflow-x-auto max-[760px]:border-r-0 max-[760px]:border-b"
          aria-label={t("settings.navigation")}
        >
          {NAV_GROUPS.map((group, index) => (
            <div key={group.label} className={cn("grid gap-0.5", index > 0 && "mt-4 max-[760px]:mt-0")}>
              <div className="px-3 pb-1 text-[0.72rem] font-medium uppercase tracking-wide text-[var(--foreground-40)] max-[760px]:hidden">
                {t(group.label)}
              </div>
              <ul className="grid gap-0.5 list-none m-0 p-0 max-[760px]:flex">
                {group.items.map(({ key, label }) => {
                  const active = section === key;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => open(key)}
                        data-testid={`settings-nav-${key}`}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "w-full whitespace-nowrap rounded-[0.55rem] border border-transparent px-3 py-1.5 text-[0.9rem] text-left text-muted-foreground cursor-pointer transition-[color,background,border-color] duration-150",
                          "hover:text-foreground hover:bg-[var(--foreground-5)]",
                          active && "text-foreground bg-[var(--foreground-5)] border-border",
                        )}
                      >
                        {t(label)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <section className="overflow-y-auto p-[clamp(1.25rem,1rem+1.2vw,2.25rem)]">
          <div className="mx-auto w-full max-w-[1120px]">
            {section === "chat" && <ChatModelSettings />}
            {section === "embedding" && <MemoryEmbeddingSettings />}
            {section === "tts" && <TtsSettings />}
            {section === "stt" && <SttSettings />}
            {section === "sources" && (
              <SettingsPanel id="sources" heading="settings.section.sources" description="settings.section.sourcesDescription">
                <SearchProviderSection />
              </SettingsPanel>
            )}
            {section === "appearance" && <AppearanceSettings />}
          </div>
        </section>
      </div>
    </div>
  );
}
