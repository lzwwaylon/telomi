import { useCallback, useEffect, useRef } from "react";
import { uiText } from "@/app/ui-text";
import { cn } from "@/shared/lib/utils";

interface ResizeHandleProps {
	/** "right": handle sits on the right edge of a left-side panel; dragging right increases width. */
	/** "left": handle sits on the left edge of a right-side panel; dragging left increases width. */
	side: "right" | "left";
	/** Called with delta px on each pointermove during a drag. */
	onResize: (deltaPx: number) => void;
	onResizeStart?: () => void;
	onResizeEnd?: () => void;
	className?: string;
	label?: string;
}

export function ResizeHandle({
	side,
	onResize,
	onResizeStart,
	onResizeEnd,
	className,
	label,
}: ResizeHandleProps) {
	const lastXRef = useRef<number>(0);
	const draggingRef = useRef<boolean>(false);

	const handlePointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			lastXRef.current = e.clientX;
			draggingRef.current = true;
			onResizeStart?.();

			const handleMove = (ev: PointerEvent) => {
				if (!draggingRef.current) return;
				const delta = ev.clientX - lastXRef.current;
				lastXRef.current = ev.clientX;
				const adjusted = side === "right" ? delta : -delta;
				if (adjusted !== 0) onResize(adjusted);
			};

			const handleUp = () => {
				if (!draggingRef.current) return;
				draggingRef.current = false;
				window.removeEventListener("pointermove", handleMove);
				window.removeEventListener("pointerup", handleUp);
				window.removeEventListener("pointercancel", handleUp);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				onResizeEnd?.();
			};

			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", handleMove);
			window.addEventListener("pointerup", handleUp);
			window.addEventListener("pointercancel", handleUp);
		},
		[side, onResize, onResizeStart, onResizeEnd],
	);

	useEffect(() => {
		return () => {
			if (draggingRef.current) {
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
			}
		};
	}, []);

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label || uiText("app.resizehandle.resizePanel")}
			onPointerDown={handlePointerDown}
			className={cn(
				"group absolute top-0 bottom-0 z-20 w-[8px] cursor-col-resize select-none touch-none",
				side === "right" ? "right-[-4px]" : "left-[-4px]",
				className,
			)}
			data-testid={`resize-handle-${side}`}
		>
			<span
				className={cn(
					"pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-transparent transition-colors duration-150",
					"group-hover:bg-[var(--foreground-30)] group-active:bg-[var(--accent)]",
				)}
			/>
		</div>
	);
}
