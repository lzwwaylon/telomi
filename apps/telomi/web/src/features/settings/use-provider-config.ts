import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/shared/lib/api-client";
import { type ProviderConfig } from "./provider-config";

/** The provider configuration one settings page edits; each page loads its own copy. */
export function useProviderConfig() {
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiClient.get<ProviderConfig>("/api/provider-config")
      .then((data) => { if (active) setConfig(data); })
      .catch((err) => { if (active) setLoadError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const reload = useCallback(() => {
    apiClient.get<ProviderConfig>("/api/provider-config")
      .then((data) => {
        if (data) {
          setConfig(data);
          window.dispatchEvent(new Event("mom:models-invalidate"));
        }
      })
      .catch((err) => console.warn("[Settings] provider-config fetch failed:", err));
  }, []);

  const patch = useCallback(async (body: Record<string, unknown>) => {
    setSaving(true);
    setSaveError(null);
    try {
      const data = await apiClient.patch<ProviderConfig>("/api/provider-config", body);
      setConfig(data);
      if (Object.prototype.hasOwnProperty.call(body, "enabledModels")) {
        window.dispatchEvent(new Event("mom:models-invalidate"));
      }
      return data;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  return { config, setConfig, loading, loadError, saving, saveError, patch, reload };
}
