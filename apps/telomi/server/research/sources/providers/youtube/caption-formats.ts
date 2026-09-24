export interface YouTubeTranscriptSegment {
	startMs: number;
	endMs: number;
	text: string;
	chapterId?: string;
}

export function parseWebVtt(value: string): YouTubeTranscriptSegment[] {
	const normalized = value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
	const blocks = normalized.split(/\n{2,}/u);
	const segments: YouTubeTranscriptSegment[] = [];
	for (const block of blocks) {
		const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
		if (lines.length === 0 || lines[0] === "WEBVTT" || lines[0]!.startsWith("NOTE")) continue;
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		if (timingIndex < 0) continue;
		const timing = /^(\S+)\s+-->\s+(\S+)/u.exec(lines[timingIndex]!);
		if (!timing) continue;
		const startMs = parseVttTimestamp(timing[1]!);
		const endMs = parseVttTimestamp(timing[2]!.split(/\s+/u)[0]!);
		if (startMs === undefined || endMs === undefined || endMs < startMs) continue;
		const text = decodeCaptionText(lines.slice(timingIndex + 1).join(" "));
		if (!text) continue;
		const previous = segments.at(-1);
		if (previous && previous.text === text && previous.endMs <= startMs + 250) {
			previous.endMs = Math.max(previous.endMs, endMs);
			continue;
		}
		segments.push({ startMs, endMs, text });
	}
	return segments;
}

export function transcriptText(segments: YouTubeTranscriptSegment[]): string {
	const words: string[] = [];
	for (const segment of segments) {
		const incoming = segment.text.split(/\s+/u).filter(Boolean);
		let overlap = Math.min(words.length, incoming.length);
		while (
			overlap > 0
			&& !incoming.slice(0, overlap).every((word, index) =>
				captionWordKey(word) === captionWordKey(words[words.length - overlap + index]!))
		) {
			overlap -= 1;
		}
		words.push(...incoming.slice(overlap));
	}
	return words.join(" ").trim();
}

function captionWordKey(value: string): string {
	return value.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || value;
}

function parseVttTimestamp(value: string): number | undefined {
	const clean = value.replace(",", ".");
	const parts = clean.split(":");
	if (parts.length < 2 || parts.length > 3) return undefined;
	const seconds = Number(parts.at(-1));
	const minutes = Number(parts.at(-2));
	const hours = parts.length === 3 ? Number(parts[0]) : 0;
	if (![seconds, minutes, hours].every(Number.isFinite)) return undefined;
	return Math.round((hours * 3600 + minutes * 60 + seconds) * 1_000);
}

function decodeCaptionText(value: string): string {
	return value
		.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/gu, "")
		.replace(/<[^>]+>/gu, "")
		.replace(/&amp;/gu, "&")
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">")
		.replace(/&quot;/gu, "\"")
		.replace(/&#39;|&apos;/gu, "'")
		.replace(/\s+/gu, " ")
		.trim();
}
