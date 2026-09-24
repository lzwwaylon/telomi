import { useCallback, useEffect, useState } from "react";

const PIN_STORAGE_KEY = "telomi-rail-pinned";
const PIN_CHANGE_EVENT = "telomi:rail-pinned";

function readInitial(): boolean {
	try {
		return window.localStorage.getItem(PIN_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

export function useRailPinned(): [
	boolean,
	(next: boolean | ((prev: boolean) => boolean)) => void,
] {
	const [pinned, setPinnedState] = useState<boolean>(readInitial);

	useEffect(() => {
		const onCustom = (e: Event) => {
			const detail = (e as CustomEvent<boolean>).detail;
			if (typeof detail === "boolean") setPinnedState(detail);
		};
		const onStorage = (e: StorageEvent) => {
			if (e.key === PIN_STORAGE_KEY) setPinnedState(e.newValue === "1");
		};
		window.addEventListener(PIN_CHANGE_EVENT, onCustom);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(PIN_CHANGE_EVENT, onCustom);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	const setPinned = useCallback(
		(next: boolean | ((prev: boolean) => boolean)) => {
			setPinnedState((prev) => {
				const value =
					typeof next === "function"
						? (next as (p: boolean) => boolean)(prev)
						: next;
				try {
					window.localStorage.setItem(PIN_STORAGE_KEY, value ? "1" : "0");
				} catch {}
				window.dispatchEvent(
					new CustomEvent<boolean>(PIN_CHANGE_EVENT, { detail: value }),
				);
				return value;
			});
		},
		[],
	);

	return [pinned, setPinned];
}
