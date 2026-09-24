export function DiffBlock({ source }: { source: string }) {
	const lines = source.split("\n");
	return (
		<pre className="m-0 overflow-auto rounded-[8px] border border-[var(--border)] bg-[color-mix(in_oklch,var(--muted)_30%,var(--background))] p-2.5 font-mono text-[0.82em] text-[var(--foreground)]">
			{lines.map((line, i) => {
				let cls = "text-[var(--foreground-70)]";
				if (line.startsWith("+") && !line.startsWith("+++")) {
					cls = "text-[var(--success)] bg-[color-mix(in_oklab,var(--success)_8%,transparent)]";
				} else if (line.startsWith("-") && !line.startsWith("---")) {
					cls = "text-[var(--destructive)] bg-[color-mix(in_oklab,var(--destructive)_8%,transparent)]";
				} else if (line.startsWith("@@")) {
					cls = "text-[var(--info)]";
				} else if (line.startsWith("+++") || line.startsWith("---")) {
					cls = "text-[var(--foreground-50)] font-semibold";
				}
				return (
					<div key={i} className={`px-1 ${cls}`}>
						{line || "\u00a0"}
					</div>
				);
			})}
		</pre>
	);
}
