import { useCallback, useEffect, useRef, useState } from "react";

const WIDTH_KEY = "mom:chat:rightDock:width";
const COLLAPSED_KEY = "mom:chat:rightDock:collapsed";

export const CHAT_DOCK_DEFAULT_WIDTH = 480;
export const CHAT_DOCK_MIN_WIDTH = 320;
export const CHAT_DOCK_MAX_WIDTH = 960;

// Below this viewport width the dock (480px default) leaves the chat column
// so narrow that ChatComposer's send button visually overlaps the dock, and
// document.elementFromPoint at the send button's center returns a dock row
// instead of the button — click events get eaten by the dock. Until we fix
// the grid layout properly (option C in task #32), default to collapsed for
// new visitors on narrow screens so the bug never triggers on first use.
// Wide-viewport users still see the dock expanded by default.
const CHAT_DOCK_AUTO_COLLAPSE_VIEWPORT_PX = 1100;

function readWidth(): number {
	try {
		const raw = window.localStorage.getItem(WIDTH_KEY);
		if (!raw) return CHAT_DOCK_DEFAULT_WIDTH;
		const n = Number(raw);
		if (!Number.isFinite(n)) return CHAT_DOCK_DEFAULT_WIDTH;
		return clampWidth(n);
	} catch {
		return CHAT_DOCK_DEFAULT_WIDTH;
	}
}

function readCollapsed(): boolean {
	try {
		const raw = window.localStorage.getItem(COLLAPSED_KEY);
		// Explicit user choice wins regardless of viewport — once they've
		// toggled, respect it on every viewport size.
		if (raw === "1") return true;
		if (raw === "0") return false;
		// No prior choice → narrow viewport defaults to collapsed (see comment
		// on CHAT_DOCK_AUTO_COLLAPSE_VIEWPORT_PX above).
		return (
			typeof window.innerWidth === "number" &&
			window.innerWidth < CHAT_DOCK_AUTO_COLLAPSE_VIEWPORT_PX
		);
	} catch {
		return false;
	}
}

function clampWidth(value: number): number {
	const cap =
		typeof window !== "undefined"
			? Math.min(CHAT_DOCK_MAX_WIDTH, Math.max(CHAT_DOCK_MIN_WIDTH, Math.floor(window.innerWidth * 0.7)))
			: CHAT_DOCK_MAX_WIDTH;
	return Math.max(CHAT_DOCK_MIN_WIDTH, Math.min(cap, Math.round(value)));
}

export interface ChatRightDockLayout {
	width: number;
	collapsed: boolean;
	toggleCollapsed: () => void;
	setCollapsed: (next: boolean) => void;
	resizeBy: (deltaPx: number) => void;
}

export function useChatRightDockLayout(): ChatRightDockLayout {
	const [width, setWidth] = useState<number>(() =>
		typeof window === "undefined" ? CHAT_DOCK_DEFAULT_WIDTH : readWidth(),
	);
	const [collapsed, setCollapsedState] = useState<boolean>(() =>
		typeof window === "undefined" ? false : readCollapsed(),
	);
	const widthRef = useRef(width);
	widthRef.current = width;

	useEffect(() => {
		try {
			window.localStorage.setItem(WIDTH_KEY, String(width));
		} catch {
			/* ignore quota errors */
		}
	}, [width]);

	useEffect(() => {
		try {
			window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
		} catch {
			/* ignore quota errors */
		}
	}, [collapsed]);

	const setCollapsed = useCallback((next: boolean) => {
		setCollapsedState(next);
	}, []);

	const toggleCollapsed = useCallback(() => {
		setCollapsedState((v) => !v);
	}, []);

	const resizeBy = useCallback((deltaPx: number) => {
		setWidth(clampWidth(widthRef.current + deltaPx));
	}, []);

	return { width, collapsed, toggleCollapsed, setCollapsed, resizeBy };
}
