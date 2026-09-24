import { createContext, useContext } from "react";
import type { ActivityItem } from "@/features/goals/data/types";
import type { DiffChange } from "@/app/overlays/DiffOverlay";

export interface OverlayContextValue {
	openActivity: (activity: ActivityItem) => void;
	openMarkdown: (title: string, value: unknown) => void;
	openJson: (title: string, value: unknown, subtitle?: string) => void;
	openDiff: (filePath: string, changes: DiffChange[]) => void;
	close: () => void;
}

export const OverlayContext = createContext<OverlayContextValue | null>(null);

export function useOverlay(): OverlayContextValue | null {
	return useContext(OverlayContext);
}
