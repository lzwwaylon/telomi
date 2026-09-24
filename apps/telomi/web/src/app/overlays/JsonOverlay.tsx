import { Braces } from "lucide-react";
import { uiText } from "@/app/ui-text";
import { CodeBlock } from "@/shared/markdown/CodeBlock";
import { OverlayShell } from "@/app/overlays/OverlayShell";

export interface JsonOverlayProps {
	open: boolean;
	onClose: () => void;
	title: string;
	subtitle?: string;
	value: unknown;
	error?: string;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function JsonOverlay({ open, onClose, title, subtitle, value, error }: JsonOverlayProps) {
	const text = typeof value === "string" ? value : safeStringify(value);
	return (
		<OverlayShell
			open={open}
			onClose={onClose}
			badge={{ icon: Braces, label: "JSON", variant: "blue" }}
			title={title}
			subtitle={subtitle}
			error={error ? { label: uiText("common.error.b859c7b"), message: error } : undefined}
		>
			<div className="max-w-[1000px] mx-auto">
				<CodeBlock code={text} language="json" mode="full" />
			</div>
		</OverlayShell>
	);
}
