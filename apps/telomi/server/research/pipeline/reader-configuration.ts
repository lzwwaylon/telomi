import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inferOutputLanguage, type ResolvedOutputLanguage } from "../../../shared/languages.js";
import { resolvePrimeModel } from "../../agent-runtime/model-policy.js";
import { isRecord } from "../../lib/values.js";

export interface QuestionReaderConfiguration {
	childModel: string;
	language: ResolvedOutputLanguage;
}

/** Frozen inputs win; historical Cases require a structured question and explicit model selection. */
export function readQuestionReaderConfiguration(inputRoot: string | undefined, question: string | undefined,
	env: NodeJS.ProcessEnv, corpusRoot?: string): QuestionReaderConfiguration {
	const path = inputRoot && join(inputRoot, "reader-config.json");
	let value: unknown;
	if (path && existsSync(path)) {
		value = JSON.parse(readFileSync(path, "utf8"));
	} else {
		const contextPath = corpusRoot && join(corpusRoot, "reader-context.json");
		const context: unknown = contextPath && existsSync(contextPath) ? JSON.parse(readFileSync(contextPath, "utf8")) : undefined;
		const originalQuestion = isRecord(context) && typeof context.original_question === "string" ? context.original_question.trim() : "";
		const languageQuestion = originalQuestion || question?.trim();
		if (!languageQuestion) throw new Error("Historical Question Reader requires its frozen question to select output language");
		value = { childModel: resolvePrimeModel("primeChild", env).selector, language: inferOutputLanguage(languageQuestion) };
	}
	if (!isRecord(value) || typeof value.childModel !== "string" || !/^[^\s/]+\/\S+$/u.test(value.childModel)
		|| (value.language !== "en" && value.language !== "zh-CN")) {
		throw new Error("Question Reader configuration requires a provider/model and en or zh-CN language");
	}
	return { childModel: value.childModel, language: value.language };
}
