import { useCallback, useEffect, useRef, useState } from "react";

const WIDTH_KEY = "telomi:topicInspector:width";
const DEFAULT_WIDTH = 500;
const MIN_WIDTH = 360;
const MAX_WIDTH = 760;
const MIN_CONTENT_WIDTH = 420;

function clampWidth(value: number): number {
	const viewportCap = typeof window === "undefined"
		? MAX_WIDTH
		: Math.max(MIN_WIDTH, window.innerWidth - MIN_CONTENT_WIDTH);
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportCap, Math.round(value)));
}

function readWidth(): number {
	try {
		const value = Number(window.localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(value) && value > 0 ? clampWidth(value) : DEFAULT_WIDTH;
	} catch {
		return DEFAULT_WIDTH;
	}
}

export function useTopicInspectorLayout() {
	const [width, setWidth] = useState(() => typeof window === "undefined" ? DEFAULT_WIDTH : readWidth());
	const widthRef = useRef(width);
	widthRef.current = width;

	useEffect(() => {
		try {
			window.localStorage.setItem(WIDTH_KEY, String(width));
		} catch {
			/* ignore storage failures */
		}
	}, [width]);

	const resizeBy = useCallback((deltaPx: number) => {
		setWidth(clampWidth(widthRef.current + deltaPx));
	}, []);

	return { width, resizeBy };
}
