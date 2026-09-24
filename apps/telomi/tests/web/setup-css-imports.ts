import { register } from "node:module";

// Vite bundles CSS imports (e.g. katex styles in MarkdownView); under Node they are side-effect-only no-ops.
register(`data:text/javascript,${encodeURIComponent(`
export async function load(url, context, nextLoad) {
	return new URL(url).pathname.endsWith(".css")
		? { format: "module", source: "", shortCircuit: true }
		: nextLoad(url, context);
}
`)}`);
