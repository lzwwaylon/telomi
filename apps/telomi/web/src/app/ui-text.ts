import i18n from "@/app/i18n";
import type { MessageId } from "@/app/locales/zh-CN";

export function uiText(
  id: MessageId,
  values: Record<string, string | number> = {},
): string {
  return i18n.t(id, values);
}
