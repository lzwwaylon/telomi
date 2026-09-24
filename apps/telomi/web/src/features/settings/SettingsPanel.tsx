import type { ReactNode } from "react";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";

/** One focused settings page: a title, one line of intent, then its sections. */
export function SettingsPanel({ id, heading, description, children }: {
  id: string;
  heading: MessageId;
  description?: MessageId;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-8" data-testid={`settings-section-${id}`}>
      <div className="grid gap-1">
        <h2 className="m-0 text-[1.25rem] font-semibold tracking-tight">{uiText(heading)}</h2>
        {description && <p className="m-0 text-[0.85rem] text-muted-foreground">{uiText(description)}</p>}
      </div>
      {children}
    </div>
  );
}

export function SettingsLoading({ id, error }: { id: string; error?: string | null }) {
  return error ? (
    <div className="rounded-[0.55rem] border border-destructive/40 bg-destructive/5 px-3 py-2 text-[0.9rem] text-destructive" data-testid={`settings-section-${id}`}>
      {error}
    </div>
  ) : (
    <div className="text-[0.9rem] text-muted-foreground" data-testid={`settings-section-${id}`}>{uiText("common.loading")}</div>
  );
}
