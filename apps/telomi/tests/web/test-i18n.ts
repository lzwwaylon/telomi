import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const stored = new Map<string, string>();
const storage = {
	getItem: (key: string) => stored.get(key) ?? null,
	setItem: (key: string, value: string) => stored.set(key, value),
};
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: { localStorage: storage },
});

const { default: i18n, normalizeUiLocale, resources, setUiLocale } = await import("../../web/src/app/i18n.js");
const { localeDefinitions, UI_LOCALES, UI_LOCALE_OPTIONS } = await import("../../web/src/app/locales/index.js");
const { uiText } = await import("../../web/src/app/ui-text.js");
const { inferOutputLanguage, resolveOutputLanguage } = await import("../../shared/languages.js");

assert.equal(normalizeUiLocale("zh-TW"), "zh-CN");
assert.equal(normalizeUiLocale("en-US"), "en");
assert.equal(normalizeUiLocale("fr"), null);
assert.deepEqual(Object.keys(resources), UI_LOCALES);
assert.deepEqual(UI_LOCALE_OPTIONS.map((option) => option.value), UI_LOCALES);
assert.equal(localeDefinitions["zh-CN"].direction, "ltr");

function keys(value: object, prefix = ""): string[] {
	return Object.entries(value).flatMap(([key, child]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		return child && typeof child === "object" ? keys(child, path) : [path];
	}).sort();
}
assert.deepEqual(keys(resources.en.translation), keys(resources["zh-CN"].translation));
const messageIds = new Set(Object.keys(resources["zh-CN"].translation));
for (const id of messageIds) {
	assert.match(id, /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+$/u);
}

await setUiLocale("zh-CN");
assert.equal(i18n.t("common.save"), "保存");
assert.equal(uiText("common.save"), "保存");
assert.equal(uiText("goals.topicinspector.goalScopeLedger"), "Goal 范围账本");
assert.equal(uiText("goals.topicinspector.discovery"), "发现");
assert.equal(stored.get("telomi.ui-locale"), "zh-CN");

await setUiLocale("en");
assert.equal(i18n.t("common.save"), "Save");
assert.equal(i18n.t("goals.outputLanguage"), "Output language");
assert.equal(uiText("common.save"), "Save");
assert.equal(uiText("goals.topicinspector.goalScopeLedger"), "Goal scope ledger");
assert.equal(uiText("goals.topicinspector.discovery"), "Discovery");
// A counted noun agrees with its count in English; Chinese keeps one form for both.
assert.equal(uiText("settings.page.countModels", { count: 1 }), "1 model");
assert.equal(uiText("settings.page.countModels", { count: 2 }), "2 models");
assert.equal(uiText("settings.page.countVoices", { count: 1 }), "1 voice");
assert.equal(uiText("settings.page.countVoices", { count: 3 }), "3 voices");

assert.equal(inferOutputLanguage("请调研这个问题"), "zh-CN");
assert.equal(inferOutputLanguage("Research this question"), "en");
// Mixed text resolves to the language the sentence is written in, not to any script it quotes.
assert.equal(inferOutputLanguage("What are the latest advances in 具身智能 for household robots?"), "en");
assert.equal(inferOutputLanguage("How does the paper define 注意力 compared with earlier work on attention?"), "en");
assert.equal(inferOutputLanguage("帮我研究一下 Transformer 的 attention mechanism 最新进展"), "zh-CN");
assert.equal(inferOutputLanguage("对比 LangChain LlamaIndex Haystack DSPy 的 RAG pipeline 设计"), "zh-CN");
assert.equal(inferOutputLanguage("Transformer 是什么"), "zh-CN");
assert.equal(inferOutputLanguage("看看 https://github.com/example-org/some-project/tree/main/packages/core/src 这个项目"), "zh-CN");
assert.equal(inferOutputLanguage(""), "en");
assert.equal(resolveOutputLanguage("auto", "What is 具身智能 and why does it matter for robotics research?"), "en");
assert.equal(resolveOutputLanguage("zh-CN", "What is 具身智能 and why does it matter for robotics research?"), "zh-CN");
assert.equal(resolveOutputLanguage("en", "请调研这个问题"), "en");
assert.equal(resolveOutputLanguage("auto", "请调研这个问题"), "zh-CN");

const webSourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../../web/src");
const sourceFiles = walk(webSourceRoot);
for (const filename of sourceFiles) {
	const source = readFileSync(filename, "utf8");
	for (const match of source.matchAll(/uiText\(\s*("(?:[^"\\]|\\.)*")/gu)) {
		const id = JSON.parse(match[1]!) as string;
		assert.ok(messageIds.has(id), `${relative(webSourceRoot, filename)}: missing message ID ${JSON.stringify(id)}`);
	}
}

const allowedUiLiterals = new Set([
	"Esc", "Telomi", "Wiki", "⌘F", "Markdown", "Agent Browser", "Browser", "ms", "Activity", "Goal", "deeptalk",
	"Topic", "acct:", "Model", "data/.pi/agent/settings.json", "audio", "OpenRouter", "https://openrouter.ai/api/v1",
	"STT", "TTS", "KB", "provider", "model", "enabledModels", "data/.pi/agent/auth.json", "OPENAI_API_KEY", "oauth",
	"data/.pi/agent/models.json", "openai-completions (chat/completions)", "openai-responses (/responses)", "https://provider.example/v1",
	"provider/model-id", "revision", "p50", "p95", "/v1/models", "/v1/audio/transcriptions", "http://127.0.0.1:9595/v1",
	"Silero", "E", "L", "–L", "Goal Wiki", "score", "Embedding", "RRF", "cos", "Cosine", "tokens", "x", "json",
]);
const visibleAttributes = new Set(["aria-label", "title", "placeholder", "label"]);
for (const filename of sourceFiles.filter((item) => item.endsWith(".tsx"))) {
	const source = readFileSync(filename, "utf8");
	const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const visit = (node: ts.Node): void => {
		let text: string | null = null;
		if (ts.isJsxText(node)) text = node.getText(file).replace(/\s+/gu, " ").trim();
		if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(file)) && node.initializer && ts.isStringLiteral(node.initializer)) text = node.initializer.text.trim();
		if (text && /[\p{L}]/u.test(text)) assert.ok(allowedUiLiterals.has(text), `${relative(webSourceRoot, filename)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: untranslated UI literal ${JSON.stringify(text)}`);
		ts.forEachChild(node, visit);
	};
	visit(file);
}

function walk(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const filename = join(directory, entry.name);
		return entry.isDirectory() ? walk(filename) : entry.isFile() && /\.tsx?$/u.test(entry.name) ? [filename] : [];
	});
}

console.log("i18n contract test passed");
