import { useEffect, useState } from "react";
import { apiClient } from "@/shared/lib/api-client";
import { isBinaryArtifact } from "@/shared/artifact-preview/artifact-type";

/** The artifact text a preview surface should show, or why it has none. */
export interface ArtifactContentState {
	content: string | null;
	error: string | null;
}

/** Where an artifact's text comes from: an already known body, or a blob URL. */
export interface ArtifactContentSource {
	filename: string;
	url: string | null;
	/** Body the caller already holds, e.g. an artifact cached from the Run. */
	content?: string | null;
}

const PENDING: ArtifactContentState = { content: null, error: null };

/** Reads artifact text. Bodies are arbitrary text, never a JSON API payload. */
export async function readArtifactText(url: string): Promise<string> {
	const response = await apiClient.response(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.text();
}

/**
 * Load an artifact's text, latest source wins. Binary artifacts are never read;
 * they render from their blob URL. The returned function abandons the request so
 * a superseded artifact can never overwrite the one on screen.
 */
export function loadArtifactContent(
	source: ArtifactContentSource,
	apply: (state: ArtifactContentState) => void,
	read: (url: string) => Promise<string> = readArtifactText,
): () => void {
	if (typeof source.content === "string") {
		apply({ content: source.content, error: null });
		return () => undefined;
	}
	apply(PENDING);
	if (!source.url || isBinaryArtifact(source.filename)) return () => undefined;
	let current = true;
	void read(source.url).then(
		(content) => { if (current) apply({ content, error: null }); },
		(error: unknown) => {
			if (current) apply({ content: null, error: error instanceof Error ? error.message : String(error) });
		},
	);
	return () => { current = false; };
}

/** A loaded body together with the source it was read from. */
export interface LoadedArtifactContent extends ArtifactContentState {
	source: ArtifactContentSource;
}

/**
 * What a surface may show right now. A body belongs to the source it was read
 * from, so selecting another artifact reports nothing rather than the previous
 * file, even before the next read starts.
 */
export function currentArtifactContent(
	source: ArtifactContentSource,
	loaded: LoadedArtifactContent | null,
): ArtifactContentState {
	if (typeof source.content === "string") return { content: source.content, error: null };
	if (!loaded || loaded.source.filename !== source.filename || loaded.source.url !== source.url) return PENDING;
	return { content: loaded.content, error: loaded.error };
}

/** React binding for {@link loadArtifactContent}. */
export function useArtifactContent({ filename, url, content }: ArtifactContentSource): ArtifactContentState {
	const [loaded, setLoaded] = useState<LoadedArtifactContent | null>(null);
	useEffect(
		() => loadArtifactContent(
			{ filename, url, content },
			(state) => setLoaded({ ...state, source: { filename, url, content } }),
		),
		[filename, url, content],
	);
	return currentArtifactContent({ filename, url, content }, loaded);
}
