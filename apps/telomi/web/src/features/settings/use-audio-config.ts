import { useCallback, useEffect, useState } from "react";
import { audioConfigApi } from "@/features/voice/api";
import { type AudioConfigResponse } from "./audio-config";

/** The voice configuration the TTS, STT and voice interaction pages read and patch. */
export function useAudioConfig() {
  const [data, setData] = useState<AudioConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    return audioConfigApi.load<AudioConfigResponse>()
      .then((next) => { setData(next); setLoadError(null); return next; })
      .catch((err) => { setLoadError(err instanceof Error ? err.message : String(err)); return null; })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const patch = useCallback(async (body: Record<string, unknown>) => {
    setSaving(true);
    setSaveError(null);
    try {
      setData(await audioConfigApi.patch<AudioConfigResponse>(body));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  return { data, loading, loadError, saving, setSaving, saveError, setSaveError, patch, reload };
}
