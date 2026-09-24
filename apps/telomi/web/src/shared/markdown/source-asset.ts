const SOURCE_ASSET_URI = /^source-asset:(source:[a-z0-9_-]+)\/([A-Za-z0-9._/-]+)$/iu;

export function isSourceAssetUri(value: string): boolean {
	return SOURCE_ASSET_URI.test(value);
}

export function sourceAssetHttpUrl(value: string, goalId?: string | null, revision?: string | null): string | null {
	const match = SOURCE_ASSET_URI.exec(value);
	if (!match || !goalId || match[2]!.split("/").some((part) => !part || part === "." || part === "..")) return null;
	const params = new URLSearchParams({ source: match[1]!, path: match[2]! });
	if (revision) params.set("revision", revision);
	return `/api/goals/${encodeURIComponent(goalId)}/wiki/source-asset?${params}`;
}
