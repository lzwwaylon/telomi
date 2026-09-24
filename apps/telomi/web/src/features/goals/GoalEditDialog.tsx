import { useEffect, useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import type { GoalSummary } from "@shared/types";
import { useTranslation } from "react-i18next";
import type { OutputLanguage } from "@shared/languages.js";

export interface GoalEditPatch {
	title: string;
	description: string;
	outputLanguage: OutputLanguage;
}

export interface GoalEditDialogProps {
	goal: GoalSummary | null;
	onCancel: () => void;
	onConfirm: (goal: GoalSummary, patch: GoalEditPatch) => void | Promise<void>;
}

export function GoalEditDialog({ goal, onCancel, onConfirm }: GoalEditDialogProps) {
	const [titleDraft, setTitleDraft] = useState("");
	const [descDraft, setDescDraft] = useState("");
	const [outputLanguage, setOutputLanguage] = useState<OutputLanguage>("auto");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	const { t } = useTranslation();

	useEffect(() => {
		if (goal) {
			setTitleDraft(goal.title || "");
			setDescDraft(goal.description || "");
			setOutputLanguage(goal.outputLanguage);
			setError(null);
			setBusy(false);
			setTimeout(() => titleRef.current?.focus(), 0);
		}
	}, [goal]);

	const handleSubmit = async () => {
		if (!goal || busy) return;
		const title = titleDraft.trim().slice(0, 80);
		if (!title) {
			setError(t("goals.titleRequired"));
			titleRef.current?.focus();
			return;
		}
		const description = descDraft.trim();
		setBusy(true);
		setError(null);
		try {
			await onConfirm(goal, { title, description, outputLanguage });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	};

	const open = goal !== null;
	const dirty = !!goal && (titleDraft.trim() !== (goal.title || "") || descDraft.trim() !== (goal.description || "") || outputLanguage !== goal.outputLanguage);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) onCancel();
			}}
		>
			<DialogContent className="bg-card border-border" data-testid="goal-edit-dialog">
				<DialogHeader>
					<DialogTitle>{t("common.edit")} Goal</DialogTitle>
					<DialogDescription className="sr-only">
						{t("goals.editDescription")}
					</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						void handleSubmit();
					}}
				>
					<label className="grid gap-[0.3rem] text-[0.82rem] text-muted-foreground">
						{t("goals.title")}
						<Input
							ref={titleRef}
							value={titleDraft}
							onChange={(e) => setTitleDraft(e.target.value)}
							maxLength={80}
							className="w-full box-border rounded-[0.45rem] border-border bg-popover px-[0.65rem] py-2 text-[0.9rem] text-foreground shadow-none transition-colors focus-visible:border-[var(--input)] focus-visible:ring-0 h-auto"
							data-testid="goal-edit-title"
						/>
					</label>
					<label className="grid gap-[0.3rem] text-[0.82rem] text-muted-foreground">
						{t("goals.descriptionOptional")}
						<Textarea
							value={descDraft}
							onChange={(e) => setDescDraft(e.target.value)}
							rows={3}
							className="w-full max-h-[min(40vh,20rem)] overflow-y-auto box-border rounded-[0.45rem] border-border bg-popover px-[0.65rem] py-2 text-[0.9rem] text-foreground shadow-none transition-colors focus-visible:border-[var(--input)] focus-visible:ring-0 resize-y min-h-0"
							data-testid="goal-edit-description"
						/>
					</label>
					<label className="grid gap-[0.3rem] text-[0.82rem] text-muted-foreground">
						{t("goals.outputLanguage")}
						<select
							value={outputLanguage}
							onChange={(event) => setOutputLanguage(event.target.value as OutputLanguage)}
							className="appearance-none w-full rounded-[0.45rem] border border-border bg-popover px-[0.65rem] py-2 text-[0.9rem] text-foreground focus-visible:border-[var(--input)] focus-visible:outline-none"
							data-testid="goal-edit-output-language"
						>
							<option value="auto">{t("goals.outputLanguageAuto")}</option>
							<option value="zh-CN">{t("goals.outputLanguageZhCN")}</option>
							<option value="en">{t("goals.outputLanguageEn")}</option>
						</select>
					</label>
					{error && (
						<div className="text-[0.8rem] text-destructive" role="alert">
							{error}
						</div>
					)}
					<DialogFooter className="gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={onCancel}
							className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-border bg-transparent text-foreground text-[0.88rem] px-[0.8rem] gap-2 font-normal shadow-none hover:bg-[var(--foreground-5)] hover:border-[var(--input)] hover:text-foreground"
							data-testid="goal-edit-cancel"
						>
							{t("common.cancel")}
						</Button>
						<Button
							type="submit"
							variant="outline"
							disabled={busy || !dirty || titleDraft.trim().length === 0}
							className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-[var(--input)] bg-[var(--foreground)] text-[var(--background)] text-[0.88rem] px-[0.8rem] gap-2 font-normal shadow-none hover:bg-[var(--foreground-90)] hover:border-[var(--input)] hover:text-[var(--background)] disabled:opacity-50 disabled:cursor-not-allowed"
							data-testid="goal-edit-save"
						>
							{busy ? `${t("common.save")}…` : t("common.save")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
