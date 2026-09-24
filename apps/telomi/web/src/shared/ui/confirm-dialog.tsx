import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";

const CANCEL_CLS = "h-9 min-w-[5.5rem] rounded-[0.55rem] border-border bg-transparent text-foreground text-[0.88rem] px-[0.8rem] gap-2 font-normal shadow-none hover:bg-[var(--foreground-5)] hover:border-[var(--input)] hover:text-foreground";
const CONFIRM_CLS = "h-9 min-w-[5.5rem] rounded-[0.55rem] text-[0.88rem] px-[0.8rem] gap-2 font-normal shadow-none disabled:opacity-50 disabled:cursor-not-allowed";
const DESTRUCTIVE_CLS = "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:border-destructive hover:text-destructive-foreground";
const NEUTRAL_CLS = "border-border bg-transparent text-foreground hover:bg-[var(--foreground-5)] hover:border-[var(--input)] hover:text-foreground";

/**
 * Asks before an action that is hard to take back. A browser `confirm()` would block the page, take
 * its button wording from the operating system rather than the UI language, and hold a single line
 * of plain text, so it can neither be themed nor say what the action costs.
 *
 * `description` is where the consequence goes: whether the action can be undone, and what survives it.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, destructive, acknowledge, busyLabel, onCancel, onConfirm, testId }: {
	open: boolean;
	title: string;
	description: string;
	confirmLabel: string;
	/** Styles the confirm button as a loss and is announced the same way. */
	destructive?: boolean;
	/** Reports something that already happened: there is nothing to cancel, so only one button. */
	acknowledge?: boolean;
	busyLabel?: string;
	onCancel: () => void;
	onConfirm: () => void | Promise<void>;
	testId?: string;
}) {
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) { setBusy(false); setError(null); }
	}, [open]);

	// A failed action keeps the dialog open with its reason, so the user is never left guessing
	// whether it went through.
	const confirm = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await onConfirm();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
			<DialogContent className="bg-card border-border" data-testid={testId}>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription className="pt-1">{description}</DialogDescription>
				</DialogHeader>
				{error && <div className="text-[0.8rem] text-destructive" role="alert">{error}</div>}
				<DialogFooter className="gap-2">
					{!acknowledge && (
						<Button type="button" variant="outline" onClick={onCancel} disabled={busy} className={CANCEL_CLS} data-testid={testId && `${testId}-cancel`}>
							{t("common.cancel")}
						</Button>
					)}
					<Button type="button" variant="outline" onClick={() => void confirm()} disabled={busy}
						className={`${CONFIRM_CLS} ${destructive ? DESTRUCTIVE_CLS : NEUTRAL_CLS}`} data-testid={testId && `${testId}-confirm`}>
						{busy ? busyLabel ?? confirmLabel : confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
