import type { ActivityText } from "@shared/events/activity-projection";
import { providerErrorMessage } from "@shared/provider-error";
import { uiText } from "@/app/ui-text";

/**
 * The single rendering boundary for Activity Projection text: fixed chrome resolves against the
 * current `uiLocale`, while content keeps the language it was written in. Passing the projected
 * message id to `uiText` also makes the compiler reject any id missing from the locale registry.
 */
export function activityText(value: ActivityText): string {
	if (typeof value === "string") return value;
	return value
		.map((part) => part.key === undefined ? part.text : uiText(part.key, part.params ?? {}))
		.filter(Boolean)
		.join(" · ");
}

/** A failed model call's error text as the user reads it: a Provider HTTP error never shows its raw body. */
export function readableErrorText(text: string): string {
	return activityText(providerErrorMessage(text) ?? text);
}
