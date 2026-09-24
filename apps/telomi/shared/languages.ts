export const OUTPUT_LANGUAGES = ["auto", "zh-CN", "en"] as const;
export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];
export type ResolvedOutputLanguage = Exclude<OutputLanguage, "auto">;

export function isOutputLanguage(value: unknown): value is OutputLanguage {
	return typeof value === "string" && OUTPUT_LANGUAGES.includes(value as OutputLanguage);
}

/**
 * The language a mixed-script text is written in. One Han character carries about as much as
 * one Latin word, so the two are compared as units and links are ignored. Chinese technical
 * writing quotes far more English terms than English writing quotes Chinese ones, so Chinese
 * wins from a one-third share: an English sentence citing a Chinese term stays English, while a
 * Chinese sentence dense with English names stays Chinese.
 */
// ponytail: script counting only separates zh-CN from en; a third output language needs real language detection.
export function inferOutputLanguage(text: string): ResolvedOutputLanguage {
	const prose = text.replace(/https?:\/\/\S+/gu, " ");
	const han = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
	const latinWords = prose.match(/\p{Script=Latin}+/gu)?.length ?? 0;
	return han > 0 && han * 2 >= latinWords ? "zh-CN" : "en";
}

export function resolveOutputLanguage(
	preference: OutputLanguage,
	text: string,
): ResolvedOutputLanguage {
	return preference === "auto" ? inferOutputLanguage(text) : preference;
}

/**
 * The language of artifacts that outlive a single request, such as the Goal Wiki. `auto` follows the
 * Goal's own title and description rather than one Run's question, so pages from different Runs agree.
 */
// ponytail: recomputed on each use; persist it on the Goal if editing the title must not move it.
export function resolveGoalOutputLanguage(
	preference: OutputLanguage,
	goal: { title: string; description: string },
): ResolvedOutputLanguage {
	return resolveOutputLanguage(preference, `${goal.title}\n${goal.description}`);
}
