import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

export interface RotatingPlaceholderProps {
	placeholders: string[];
	intervalMs?: number;
	fadeMs?: number;
	className?: string;
	active?: boolean;
}

const EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

export function RotatingPlaceholder({
	placeholders,
	intervalMs = 5000,
	fadeMs = 300,
	className,
	active = true,
}: RotatingPlaceholderProps) {
	const [index, setIndex] = useState(0);

	useEffect(() => {
		setIndex(0);
	}, [placeholders]);

	useEffect(() => {
		if (!active) return;
		if (placeholders.length <= 1) return;
		const timer = window.setInterval(() => {
			setIndex((prev) => (prev + 1) % placeholders.length);
		}, intervalMs);
		return () => {
			window.clearInterval(timer);
		};
	}, [active, placeholders, intervalMs]);

	const text = placeholders[active ? index : 0] ?? "";
	const fadeSeconds = fadeMs / 1000;

	return (
		<AnimatePresence mode="wait" initial={false}>
			<motion.span
				key={text}
				className={className}
				aria-hidden="true"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: fadeSeconds, ease: EASE }}
			>
				{text}
			</motion.span>
		</AnimatePresence>
	);
}
