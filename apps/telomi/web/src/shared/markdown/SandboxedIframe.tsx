import { useMemo } from "react";

export function SandboxedIframe({
	html,
	title,
	height = 480,
}: {
	html: string;
	title: string;
	height?: number;
}) {
	const srcDoc = useMemo(() => html, [html]);
	return (
		<iframe
			title={title}
			srcDoc={srcDoc}
			sandbox="allow-scripts"
			className="w-full rounded-[8px] border border-[var(--border)] bg-white"
			style={{ height }}
		/>
	);
}
