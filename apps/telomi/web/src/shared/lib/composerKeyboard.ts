export interface ComposerKeyboardEventLike {
	key: string;
	keyCode: number;
	isComposing: boolean;
}

export function isImeCompositionKeyboardEvent(
	event: ComposerKeyboardEventLike,
): boolean {
	return event.isComposing || event.key === "Process" || event.keyCode === 229;
}
