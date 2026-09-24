export interface VoiceKeyboardEventLike {
	key: string;
	defaultPrevented: boolean;
	repeat: boolean;
	isComposing: boolean;
}

export function isVoiceCancelKeyboardEvent(event: VoiceKeyboardEventLike): boolean {
	return (
		event.key === "Escape" &&
		!event.defaultPrevented &&
		!event.repeat &&
		!event.isComposing
	);
}
