export function resolveDevelopmentApiBase(
	env: Record<string, string | undefined>,
): string {
	const explicitBase = env.VITE_API_BASE?.trim();
	if (explicitBase) return explicitBase;
	const apiPort = env.API_PORT?.trim() || "8787";
	return `http://localhost:${apiPort}`;
}
