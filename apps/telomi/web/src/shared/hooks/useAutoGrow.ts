import { useCallback, useEffect, useRef } from "react";

interface UseAutoGrowOptions {
	minHeight?: number;
	maxHeight?: number;
	value?: string;
}

// `value` triggers re-measure on controlled-value change so
// the textarea shrinks back after clearing / submission.
export function useAutoGrow<T extends HTMLTextAreaElement = HTMLTextAreaElement>({
	minHeight = 72,
	maxHeight,
	value,
}: UseAutoGrowOptions = {}) {
	const ref = useRef<T>(null);

	const adjustHeight = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		let next = Math.max(el.scrollHeight, minHeight);
		if (maxHeight) next = Math.min(next, maxHeight);
		el.style.height = `${next}px`;
	}, [minHeight, maxHeight]);

	useEffect(() => {
		adjustHeight();
	}, [adjustHeight, value]);

	return { ref, adjustHeight };
}
