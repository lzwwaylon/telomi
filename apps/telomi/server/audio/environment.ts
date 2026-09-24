export function audioEnv(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env[`TELOMI_AUDIO_${name}`];
}
