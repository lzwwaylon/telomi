import { uiText } from "@/app/ui-text";
import { type ProviderInfo } from "./provider-config";

export function EnabledProviderGroup({
  provider,
  enabledSet,
  disabled,
  onToggle,
}: {
  provider: ProviderInfo;
  enabledSet: Set<string>;
  disabled: boolean;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  if (provider.models.length === 0) {
    return (
      <details className="rounded-[0.55rem] border border-border bg-card">
        <summary className="cursor-pointer px-3 py-2 text-[0.88rem] font-medium text-foreground">
          {provider.id}{" "}
          <span className="text-muted-foreground font-normal">
			{uiText("settings.page.unregisteredModel")}
          </span>
        </summary>
      </details>
    );
  }
  const enabledCount = provider.models.filter((m) =>
    enabledSet.has(`${provider.id}/${m.id}`),
  ).length;
  return (
    <details
      className="rounded-[0.55rem] border border-border bg-card"
      open={enabledCount > 0}
    >
      <summary className="cursor-pointer px-3 py-2 text-[0.88rem] font-medium text-foreground flex items-center justify-between gap-3">
        <span>
          {provider.id}
          {provider.dynamic && (
            <span
              className="ml-2 text-[0.7rem] font-normal text-muted-foreground border border-border rounded px-1.5 py-0.5"
              title={uiText(
                "settings.page.theProviderIsNotInThePiAiCatalog",
              )}
            >
              {uiText("settings.page.external")}
            </span>
          )}
        </span>
        <span className="text-[0.78rem] text-muted-foreground font-normal">
		  {uiText("settings.page.enabledTotalEnabled", { enabled: enabledCount, total: provider.models.length })}
        </span>
      </summary>
      <ul className="list-none m-0 p-0 border-t border-border">
        {provider.models.map((m) => {
          const id = `${provider.id}/${m.id}`;
          const checked = enabledSet.has(id);
          return (
            <li key={id} className="border-t border-border first:border-t-0">
              <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-[var(--foreground-5)]">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => onToggle(id, e.target.checked)}
                  className="h-4 w-4 cursor-pointer accent-[var(--primary)]"
                  data-testid={`provider-enabled-${id}`}
                />
                <span className="text-[0.88rem] text-foreground flex-1">
                  {m.name}
                </span>
                <span className="text-[0.75rem] font-mono text-muted-foreground">
                  {m.id}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
