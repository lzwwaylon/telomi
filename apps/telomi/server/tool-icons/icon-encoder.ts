import { existsSync, readFileSync } from "fs";
import { extname } from "path";

const EXT_TO_MIME: Record<string, string> = {
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".gif": "image/gif",
};

const MAX_FILE_SIZE = 50 * 1024;

export function encodeIconToDataUrl(iconPath: string | undefined): string | undefined {
	if (!iconPath) return undefined;
	if (iconPath.startsWith("data:")) return iconPath;
	if (!existsSync(iconPath)) return undefined;

	const ext = extname(iconPath).toLowerCase();
	const mimeType = EXT_TO_MIME[ext];
	if (!mimeType) return undefined;

	try {
		const buffer = readFileSync(iconPath);
		if (buffer.length > MAX_FILE_SIZE) return undefined;
		const base64 = buffer.toString("base64");
		return `data:${mimeType};base64,${base64}`;
	} catch {
		return undefined;
	}
}
