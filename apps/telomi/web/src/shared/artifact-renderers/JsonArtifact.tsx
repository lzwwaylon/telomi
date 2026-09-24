import { useMemo, type CSSProperties } from "react";
import JsonView from "@uiw/react-json-view";
import { CodeBlock } from "@/shared/markdown/CodeBlock";
import { uiText } from "@/app/ui-text";

// CSS variables follow live theme changes without remounting the expanded tree.
const jsonTheme: CSSProperties & Record<`--${string}`, string> = {
	"--w-rjv-font-family": "var(--font-mono, ui-monospace, monospace)",
	"--w-rjv-background-color": "transparent",
	"--w-rjv-color": "var(--foreground)",
	"--w-rjv-key-string": "var(--foreground)",
	"--w-rjv-key-number": "var(--muted-foreground)",
	"--w-rjv-line-color": "var(--border)",
	"--w-rjv-info-color": "var(--muted-foreground)",
	"--w-rjv-curlybraces-color": "var(--foreground)",
	"--w-rjv-brackets-color": "var(--foreground)",
	"--w-rjv-quotes-color": "var(--foreground)",
	"--w-rjv-quotes-string-color": "var(--info-text)",
	"--w-rjv-ellipsis-color": "var(--muted-foreground)",
	"--w-rjv-type-string-color": "var(--info-text)",
	"--w-rjv-type-url-color": "var(--info-text)",
	"--w-rjv-type-int-color": "var(--success-text)",
	"--w-rjv-type-float-color": "var(--success-text)",
	"--w-rjv-type-boolean-color": "var(--success-text)",
	"--w-rjv-type-null-color": "var(--muted-foreground)",
	"--w-rjv-copied-success-color": "var(--success-text)",
	"--w-rjv-update-color": "var(--foreground-10)",
};

export function JsonArtifact({ content }: { content: string }) {
	const parsed = useMemo(() => {
		try {
			return { ok: true as const, value: JSON.parse(content) };
		} catch (err) {
			return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
		}
	}, [content]);

	if (!parsed.ok) {
		return (
			<div className="flex flex-col gap-2">
				<div className="rounded-[8px] border border-[color-mix(in_oklab,var(--destructive)_22%,var(--border))] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] px-2.5 py-2 text-[0.78rem] text-[color-mix(in_oklab,var(--destructive)_70%,var(--foreground))]">
					{uiText("artifacts.jsonartifact.jsonParsingFailed")} {parsed.error}
				</div>
				<CodeBlock code={content} language="json" />
			</div>
		);
	}

	return (
		<div className="overflow-auto rounded-[8px] border border-[var(--border)] bg-[var(--background)] p-2.5 text-[0.78rem] max-h-[600px]">
			<JsonView value={parsed.value as object} style={jsonTheme} collapsed={false} shortenTextAfterLength={0} displayDataTypes={false} />
		</div>
	);
}
