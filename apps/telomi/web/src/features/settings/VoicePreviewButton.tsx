import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PlayIcon as Play } from "@/shared/ui/icons";
import { uiText } from "@/app/ui-text";
import { apiUrl } from "@/shared/lib/api";
import { audioConfigApi } from "@/features/voice/api";
import type { BoardSelection } from "./AssignmentBoard";
import { BTN_PRIMARY } from "./settings-styles";

/** One preview speaks at a time: starting another stops the one playing. */
let playing: HTMLAudioElement | undefined;

/**
 * Speak the preview text with one settings row's selection, applied or not, and say inline why it
 * could not. A changed selection or text clears the old answer.
 */
export function VoicePreviewButton({ selection, text, disabled, testId }: {
  selection: BoardSelection;
  text: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { connection, model, voice = "", rate = 1 } = selection;
  useEffect(() => { setError(null); }, [connection, model, voice, rate, text]);
  const play = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await audioConfigApi.voicePreview({ connection, model, voice, rate, text });
      playing?.pause();
      playing = new Audio(apiUrl(url));
      await playing.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs" data-testid={testId}>
      <button type="button" className={`${BTN_PRIMARY} whitespace-nowrap`} disabled={disabled || busy} onClick={() => void play()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
        {uiText("settings.tts.preview")}
      </button>
      {error && <span role="status" className="text-destructive break-all">{uiText("settings.page.previewFailed")}{error}</span>}
    </span>
  );
}
