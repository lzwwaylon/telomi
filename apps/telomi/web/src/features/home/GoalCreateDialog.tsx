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
import { useTranslation } from "react-i18next";
import type { OutputLanguage } from "@shared/languages.js";

export interface GoalCreateDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	goalsCount: number;
	onCreate: (input: { title: string; description: string; outputLanguage: OutputLanguage }) => void | Promise<void>;
}

export function GoalCreateDialog({ open, onOpenChange, goalsCount, onCreate }: GoalCreateDialogProps) {
	const [titleDraft, setTitleDraft] = useState("");
	const [descDraft, setDescDraft] = useState("");
	const [outputLanguage, setOutputLanguage] = useState<OutputLanguage>("auto");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const titleRef = useRef<HTMLInputElement>(null);
	const { t } = useTranslation();

	useEffect(() => {
		if (open) {
			setTitleDraft("");
			setDescDraft("");
			setOutputLanguage("auto");
			setError("");
			setBusy(false);
			setTimeout(() => titleRef.current?.focus(), 0);
		}
	}, [open]);

	const submit = async () => {
		if (busy) return;
		const title = titleDraft.trim().slice(0, 80);
		if (!title) {
			setError(t("goals.titleRequired"));
			titleRef.current?.focus();
			return;
		}
		const description = descDraft.trim();
		setBusy(true);
		setError("");
		try {
			await onCreate({ title, description, outputLanguage });
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setError("");
				onOpenChange(next);
			}}
		>
			<DialogContent className="bg-card border-border" data-testid="goal-create-dialog">
				<DialogHeader>
					<DialogTitle>{t("goals.new")}</DialogTitle>
					<DialogDescription className="sr-only">
						{t("goals.createDescription")}
					</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<label className="grid gap-[0.3rem] text-[0.82rem] text-muted-foreground">
						{t("goals.title")}
						<Input
							ref={titleRef}
							value={titleDraft}
							onChange={(e) => setTitleDraft(e.target.value)}
							maxLength={80}
							placeholder={`Goal ${goalsCount + 1}`}
							className="w-full box-border rounded-[0.45rem] border-border bg-popover px-[0.65rem] py-2 text-[0.9rem] text-foreground shadow-none transition-colors focus-visible:border-[var(--input)] focus-visible:ring-0 h-auto"
							data-testid="goal-title"
						/>
					</label>
					<label className="grid gap-[0.3rem] text-[0.82rem] text-muted-foreground">
						{t("goals.descriptionOptional")}
						<Textarea
							value={descDraft}
							onChange={(e) => setDescDraft(e.target.value)}
							rows={3}
							className="w-full max-h-[min(40vh,20rem)] overflow-y-auto box-border rounded-[0.45rem] border-border bg-popover px-[0.65rem] py-2 text-[0.9rem] text-foreground shadow-none transition-colors focus-visible:border-[var(--input)] focus-visible:ring-0 resize-y min-h-0"
							data-testid="goal-description"
						/>
					</label>
					<label className="grid gap-[0.3rem] text-[0.82rem] text-muted-foreground">
						{t("goals.outputLanguage")}
						<select
							value={outputLanguage}
							onChange={(event) => setOutputLanguage(event.target.value as OutputLanguage)}
							className="appearance-none w-full rounded-[0.45rem] border border-border bg-popover px-[0.65rem] py-2 text-[0.9rem] text-foreground focus-visible:border-[var(--input)] focus-visible:outline-none"
							data-testid="goal-output-language"
						>
							<option value="auto">{t("goals.outputLanguageAuto")}</option>
							<option value="zh-CN">{t("goals.outputLanguageZhCN")}</option>
							<option value="en">{t("goals.outputLanguageEn")}</option>
						</select>
						<span className="text-[0.75rem] leading-relaxed">{t("goals.outputLanguageDescription")}</span>
					</label>
					{error && <div className="text-[0.8rem] text-destructive">{error}</div>}
					<DialogFooter className="gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={busy}
							className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-border bg-transparent text-foreground text-[0.88rem] px-[0.8rem] gap-2 font-normal shadow-none hover:bg-[var(--foreground-5)] hover:border-[var(--input)] hover:text-foreground"
						>
							{t("common.cancel")}
						</Button>
						<Button
							type="submit"
							variant="outline"
							disabled={busy || titleDraft.trim().length === 0}
							className="h-9 min-w-[5.5rem] rounded-[0.55rem] border-[var(--input)] bg-[var(--foreground)] text-[var(--background)] text-[0.88rem] px-[0.8rem] gap-2 font-normal shadow-none hover:bg-[var(--foreground-90)] hover:border-[var(--input)] hover:text-[var(--background)] disabled:opacity-50 disabled:cursor-not-allowed"
							data-testid="goal-submit"
						>
							{busy ? t("common.creating") : t("common.create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
