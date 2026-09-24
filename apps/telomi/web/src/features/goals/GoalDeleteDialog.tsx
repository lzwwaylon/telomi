import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import type { GoalSummary } from "@shared/types";
import { useTranslation } from "react-i18next";

export interface GoalDeleteDialogProps {
	goal: GoalSummary | null;
	onCancel: () => void;
	onConfirm: (goal: GoalSummary) => void | Promise<void>;
}

export function GoalDeleteDialog({ goal, onCancel, onConfirm }: GoalDeleteDialogProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { t } = useTranslation();

	useEffect(() => {
		if (!goal) {
			setBusy(false);
			setError(null);
		}
	}, [goal]);

	const handleConfirm = async () => {
		if (!goal || busy) return;
		setBusy(true);
		setError(null);
		try {
			await onConfirm(goal);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const open = goal !== null;
	const title = goal?.title || t("home.untitled");

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) onCancel();
			}}
		>
			<DialogContent className="bg-card border-border" data-testid="goal-delete-dialog">
				<DialogHeader>
					<DialogTitle>{t("goals.deleteTitle")}</DialogTitle>
					<DialogDescription className="pt-1">
						{t("goals.deleteDescription", { title })}
					</DialogDescription>
				</DialogHeader>
				{error && (
					<div className="text-[0.8rem] text-destructive" role="alert">
						{error}
					</div>
				)}
				<DialogFooter className="gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={onCancel}
						disabled={busy}
						className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-border bg-transparent text-foreground text-[0.88rem] px-[0.8rem] gap-2 font-normal shadow-none hover:bg-[var(--foreground-5)] hover:border-[var(--input)] hover:text-foreground"
						data-testid="goal-delete-cancel"
					>
						{t("common.cancel")}
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => void handleConfirm()}
						disabled={busy}
						className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-destructive bg-destructive text-destructive-foreground text-[0.88rem] px-[0.8rem] gap-2 font-normal shadow-none hover:bg-destructive/90 hover:border-destructive hover:text-destructive-foreground disabled:opacity-50 disabled:cursor-not-allowed"
						data-testid="goal-delete-confirm"
					>
						{busy ? t("goals.deleting") : t("common.delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
