/** Trigger a browser download of `value` serialized as pretty JSON. */
export function downloadJson(filename: string, value: unknown): void {
	const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
