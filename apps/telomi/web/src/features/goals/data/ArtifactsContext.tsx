import { createContext, useContext } from "react";

export interface ArtifactsContextValue {
	openArtifact: (filename: string) => void;
	openArtifactPage: (filename: string) => void;
}

export const ArtifactsContext = createContext<ArtifactsContextValue | null>(null);

export function useArtifactsContext(): ArtifactsContextValue | null {
	return useContext(ArtifactsContext);
}
