import { Terminal, FolderSearch } from "lucide-react";
import { SearchIcon as Search } from "@/shared/ui/icons";
import { uiText } from "@/app/ui-text";
import { cn } from "@/shared/lib/utils";
import { OverlayShell, type OverlayBadgeVariant } from "@/app/overlays/OverlayShell";

export type TerminalToolKind = "bash" | "grep" | "glob";

export interface TerminalOverlayProps {
	open: boolean;
	onClose: () => void;
	kind: TerminalToolKind;
	command: string;
	output: string;
	exitCode?: number;
	description?: string;
	error?: string;
}

// Match CSI / OSC / single-char ESC sequences emitted by colorized CLI tools
// (grep --color, ls --color, npm progress, etc.). Without stripping, the raw
// codes show up as literal "[33m" garbage in the overlay <pre>.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-_])/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

function badgeFor(kind: TerminalToolKind): {
	icon: typeof Terminal;
	label: string;
	variant: OverlayBadgeVariant;
	prompt: string;
} {
	switch (kind) {
		case "grep":
			return { icon: Search, label: "Grep", variant: "green", prompt: "grep" };
		case "glob":
			return { icon: FolderSearch, label: "Glob", variant: "purple", prompt: "glob" };
		default:
			return { icon: Terminal, label: "Bash", variant: "gray", prompt: "$" };
	}
}

function summarizeForTitle(s: string, max = 80): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function TerminalOverlay({
	open,
	onClose,
	kind,
	command,
	output,
	exitCode,
	description,
	error,
}: TerminalOverlayProps) {
	const config = badgeFor(kind);
	const cleanOutput = stripAnsi(output);
	const subtitle =
		typeof exitCode === "number" ? `exit ${exitCode}` : cleanOutput ? "" : uiText("app.terminaloverlay.noOutput");

	return (
		<OverlayShell
			open={open}
			onClose={onClose}
			badge={{ icon: config.icon, label: config.label, variant: config.variant }}
			title={description ? summarizeForTitle(description) : summarizeForTitle(command)}
			subtitle={subtitle}
			error={error ? { label: uiText("app.terminaloverlay.commandFailed"), message: stripAnsi(error) } : undefined}
		>
			<div className="flex flex-col gap-[0.6rem] font-[ui-monospace,SFMono-Regular,monospace] text-[12.5px] leading-[1.55]">
				<div className="flex items-start gap-[0.55rem] px-[0.8rem] py-[0.55rem] bg-[color-mix(in_oklch,var(--muted)_50%,var(--background))] text-[var(--foreground)] border border-[var(--border)] rounded-[8px] overflow-x-auto">
					<span className="text-[var(--success)] font-bold select-none flex-shrink-0">
						{config.prompt}
					</span>
					<span className="whitespace-pre-wrap break-words">{command}</span>
				</div>
				<pre
					className={cn(
						"m-0 px-[0.85rem] py-[0.7rem] bg-[color-mix(in_oklch,var(--muted)_30%,var(--background))] text-[var(--foreground)] border border-[var(--border)] rounded-[8px] max-h-[65vh] overflow-auto whitespace-pre-wrap break-words",
						exitCode !== undefined &&
							exitCode !== 0 &&
							"bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] border-[color-mix(in_oklab,var(--destructive)_22%,var(--border))]",
					)}
				>
					{cleanOutput || uiText("common.noOutput")}
				</pre>
			</div>
		</OverlayShell>
	);
}
