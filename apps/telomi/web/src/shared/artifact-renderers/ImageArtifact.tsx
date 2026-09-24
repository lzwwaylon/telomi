export function ImageArtifact({ url, filename }: { url: string; filename: string }) {
	return (
		<div className="flex justify-center overflow-auto rounded-[8px] border border-[var(--border)] bg-[color-mix(in_oklch,var(--muted)_30%,var(--background))] p-2.5 max-h-[700px]">
			<img src={url} alt={filename} className="max-w-full h-auto rounded-[4px]" />
		</div>
	);
}
