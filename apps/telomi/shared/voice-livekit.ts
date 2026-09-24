export interface LiveKitVoiceConnection {
	serverUrl: string;
	participantToken: string;
	roomName: string;
}

export interface LiveKitGoalReplyRequest {
	transcript: string;
}

export type LiveKitGoalReplyEvent =
	| { type: "text.delta"; delta: string }
	| { type: "text.completed" };
