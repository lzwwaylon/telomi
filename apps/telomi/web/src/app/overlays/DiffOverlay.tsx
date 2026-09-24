import { GitCommitVertical } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { OverlayShell } from "@/app/overlays/OverlayShell";
import { uiText } from "@/app/ui-text";

export interface DiffChange {
	id: string;
	filePath: string;
	original: string;
	modified: string;
}

export interface DiffOverlayProps {
	open: boolean;
	onClose: () => void;
	filePath: string;
	changes: DiffChange[];
	error?: string;
}

interface DiffLine {
	kind: "context" | "add" | "del";
	text: string;
}

function buildLineDiff(original: string, modified: string): DiffLine[] {
	const a = original.split("\n");
	const b = modified.split("\n");
	// `"foo\n".split("\n") === ["foo", ""]` — the trailing empty entry is a
	// phantom from EOF newline, not a real line. Drop it when both sides have
	// it (a real "added/removed trailing newline" diff keeps one side).
	if (a.length > 1 && b.length > 1 && a[a.length - 1] === "" && b[b.length - 1] === "") {
		a.pop();
		b.pop();
	}
	const out: DiffLine[] = [];
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max; i++) {
		const oa = a[i];
		const ob = b[i];
		if (oa === undefined) {
			out.push({ kind: "add", text: ob ?? "" });
		} else if (ob === undefined) {
			out.push({ kind: "del", text: oa });
		} else if (oa === ob) {
			out.push({ kind: "context", text: oa });
		} else {
			out.push({ kind: "del", text: oa });
			out.push({ kind: "add", text: ob });
		}
	}
	return out;
}

function countStats(changes: DiffChange[]): { plus: number; minus: number } {
	let plus = 0;
	let minus = 0;
	for (const c of changes) {
		const lines = buildLineDiff(c.original, c.modified);
		for (const ln of lines) {
			if (ln.kind === "add") plus++;
			else if (ln.kind === "del") minus++;
		}
	}
	return { plus, minus };
}

export function DiffOverlay({ open, onClose, filePath, changes, error }: DiffOverlayProps) {
	const stats = countStats(changes);
	const subtitle =
		changes.length > 0
			? `${uiText("app.diffoverlay.countChanges", { count: changes.length })} · +${stats.plus} −${stats.minus}`
			: undefined;

	return (
		<OverlayShell
			open={open}
			onClose={onClose}
			badge={{ icon: GitCommitVertical, label: uiText("common.edit"), variant: "amber" }}
			title={filePath}
			subtitle={subtitle}
			error={error ? { label: uiText("app.diffoverlay.editFailed"), message: error } : undefined}
		>
			<div className="max-w-[1000px] mx-auto">
				{changes.length === 0 && (
					<div className="text-[var(--foreground-50)] text-[13px] italic px-1 py-2">
						{uiText("app.diffoverlay.noChangesRecorded")}
					</div>
				)}
				{changes.map((change, idx) => {
					const lines = buildLineDiff(change.original, change.modified);
					return (
						<div key={change.id} className="[&+&]:mt-4">
							{changes.length > 1 && (
								<div className="text-[11.5px] font-semibold text-[var(--foreground-50)] mb-[0.35rem]">
									{uiText("app.diffoverlay.changeCurrentTotal", { current: idx + 1, total: changes.length })}
								</div>
							)}
							<div className="font-[ui-monospace,SFMono-Regular,monospace] text-[12.5px] bg-[color-mix(in_oklch,var(--muted)_30%,var(--background))] text-[var(--foreground)] border border-[var(--border)] rounded-[8px] overflow-auto py-[0.55rem]">
								{lines.map((ln, i) => (
									<div
										key={i}
										className={cn(
											"flex items-start px-[0.6rem] whitespace-pre-wrap break-words",
											ln.kind === "add" &&
												"bg-[color-mix(in_oklab,var(--success)_8%,transparent)] text-[var(--success)]",
											ln.kind === "del" &&
												"bg-[color-mix(in_oklab,var(--destructive)_8%,transparent)] text-[var(--destructive)]",
											ln.kind === "context" && "text-[var(--foreground-70)]",
										)}
									>
										<span className="flex-shrink-0 w-[1.4em] select-none opacity-60">
											{ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : " "}
										</span>
										<span className="flex-1 min-w-0">{ln.text || "\u00a0"}</span>
									</div>
								))}
							</div>
						</div>
					);
				})}
			</div>
		</OverlayShell>
	);
}
