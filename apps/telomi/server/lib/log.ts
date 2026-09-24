function timestamp(): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `[${hh}:${mm}:${ss}]`;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
}

export function logInfo(message: string): void {
	console.log(`${timestamp()} [system] ${message}`);
}

export function logWarning(message: string, details?: string): void {
	console.warn(`${timestamp()} [system] ⚠ ${message}`);
	if (details) {
		console.warn(indent(details));
	}
}
