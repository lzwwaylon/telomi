export interface LiveKitVoiceConfig {
	serverUrl: string;
	publicUrl: string;
	apiKey: string;
	apiSecret: string;
	bridgeSecret: string;
	telomiUrl: string;
}

export const LIVEKIT_VOICE_AGENT_NAME = "telomi-voice";

export function resolveLiveKitVoiceConfig(
	env: NodeJS.ProcessEnv = process.env,
): LiveKitVoiceConfig {
	const production = env.NODE_ENV === "production";
	const apiKey = env.LIVEKIT_API_KEY?.trim() || (production ? "" : "devkey");
	const apiSecret =
		env.LIVEKIT_API_SECRET?.trim() || (production ? "" : "secret");
	const serverUrl =
		env.LIVEKIT_URL?.trim() || (production ? "" : "ws://127.0.0.1:7880");
	const publicUrl = env.LIVEKIT_PUBLIC_URL?.trim() || serverUrl;

	if (!serverUrl || !publicUrl || !apiKey || !apiSecret) {
		throw new Error(
			"LIVEKIT_URL, LIVEKIT_PUBLIC_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required in production",
		);
	}

	const port = env.TELOMI_PORT?.trim() || env.PORT?.trim() || "8787";
	return {
		serverUrl,
		publicUrl,
		apiKey,
		apiSecret,
		bridgeSecret:
			env.TELOMI_LIVEKIT_BRIDGE_SECRET?.trim() || apiSecret,
		telomiUrl:
			env.TELOMI_URL?.trim().replace(/\/+$/u, "") ||
			`http://127.0.0.1:${port}`,
	};
}
