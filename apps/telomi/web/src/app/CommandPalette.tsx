import { apiClient } from "@/shared/lib/api-client";
import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/ui/dialog";
import { Paperclip } from "lucide-react";
import { DocumentIcon as FileText, ChatIcon as MessageSquare, SearchIcon as Search, HeadphonesIcon } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { useTranslation } from "react-i18next";
import type { MessageId } from "@/app/locales/zh-CN";

type SearchScope = "current" | "all";
type SearchKind = "report" | "podcast" | "file" | "question";

interface SearchResult {
	id: string;
	kind: SearchKind;
	goalId: string;
	goalTitle: string;
	title: string;
	summary: string;
	updatedAt: string;
	artifactName?: string;
}

interface CommandPaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	selectedGoalId: string | null;
	selectedGoalTitle?: string;
	onOpenArtifact: (goalId: string, artifactName: string) => void;
	onOpenChat: (goalId: string) => void;
}

const GROUPS: ReadonlyArray<{ kind: SearchKind; label: MessageId }> = [
	{ kind: "report", label: "search.groups.report" },
	{ kind: "podcast", label: "search.groups.podcast" },
	{ kind: "file", label: "search.groups.file" },
	{ kind: "question", label: "search.groups.question" },
];

const GROUP_HEADING_CLS =
	"[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[0.68rem] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-[var(--foreground-30)]";

export function CommandPalette({
	open,
	onOpenChange,
	selectedGoalId,
	selectedGoalTitle,
	onOpenArtifact,
	onOpenChat,
}: CommandPaletteProps) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<SearchScope>(selectedGoalId ? "current" : "all");
	const [results, setResults] = useState<SearchResult[]>([]);
	const [state, setState] = useState<"idle" | "loading" | "error">("idle");

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setResults([]);
		setState("idle");
		setScope(selectedGoalId ? "current" : "all");
	}, [open, selectedGoalId]);

	useEffect(() => {
		const trimmed = query.trim();
		if (!open || !trimmed) {
			setResults([]);
			setState("idle");
			return;
		}
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			setState("loading");
			const params = new URLSearchParams({ q: trimmed });
			if (scope === "current" && selectedGoalId) params.set("goalId", selectedGoalId);
			void apiClient.get<{ results: SearchResult[] }>(`/api/search?${params}`, { signal: controller.signal })
				.then((payload) => {
					setResults(payload.results);
					setState("idle");
				})
				.catch((error: unknown) => {
					if (error instanceof DOMException && error.name === "AbortError") return;
					setResults([]);
					setState("error");
				});
		}, 180);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [open, query, scope, selectedGoalId]);

	const grouped = useMemo(() => GROUPS.map((group) => ({
		...group,
		results: results.filter((result) => result.kind === group.kind),
	})).filter((group) => group.results.length > 0), [results]);

	const select = (result: SearchResult) => {
		if (result.artifactName) onOpenArtifact(result.goalId, result.artifactName);
		else onOpenChat(result.goalId);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				overlayClassName="bg-[color-mix(in_oklch,var(--foreground)_18%,transparent)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
				className={cn(
					"top-[13vh] w-[min(680px,calc(100vw-2rem))] max-w-none sm:max-w-none translate-y-0 gap-0 p-0",
					"overflow-hidden rounded-[14px] border border-border bg-[var(--background)] text-[var(--foreground)] shadow-floating",
					"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
				)}
			>
				<Command label={t("search.label")} loop shouldFilter={false} className="flex flex-col">
					<DialogTitle className="sr-only">{t("search.title")}</DialogTitle>
					<DialogDescription className="sr-only">
						{t("search.description")}
					</DialogDescription>
					<div className="flex items-center gap-2 border-b border-[color-mix(in_oklch,var(--border)_60%,transparent)] px-4 py-3">
						<Search className="h-4 w-4 flex-none text-[var(--foreground-30)]" aria-hidden />
						<Command.Input
							value={query}
							onValueChange={setQuery}
							placeholder={t("search.placeholder")}
							className="min-w-0 flex-1 border-0 bg-transparent text-[0.95rem] text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-30)]"
							data-testid="content-search-input"
						/>
						<kbd className="hidden items-center rounded border border-border px-1.5 py-px text-[10px] tabular-nums text-[var(--foreground-30)] sm:inline-flex">
							Esc
						</kbd>
					</div>

					<div className="flex items-center gap-1 border-b border-[color-mix(in_oklch,var(--border)_45%,transparent)] px-4 py-2">
						{selectedGoalId && (
							<ScopeButton active={scope === "current"} onClick={() => setScope("current")} testid="content-search-scope-current">
								{t("search.currentGoal")}{selectedGoalTitle ? ` · ${selectedGoalTitle}` : ""}
							</ScopeButton>
						)}
						<ScopeButton active={scope === "all"} onClick={() => setScope("all")} testid="content-search-scope-all">
							{t("search.allGoals")}
						</ScopeButton>
					</div>

					<Command.List className="max-h-[min(62vh,560px)] overflow-y-auto px-2 pb-2">
						{!query.trim() && (
							<div className="px-5 py-10 text-center">
								<p className="text-[0.88rem] font-medium text-[var(--foreground-60)]">{t("search.emptyTitle")}</p>
								<p className="mt-1 text-[0.78rem] leading-relaxed text-[var(--foreground-30)]">{t("search.emptyDescription")}</p>
							</div>
						)}
						{query.trim() && state === "loading" && results.length === 0 && <SearchState>{t("search.loading")}</SearchState>}
						{query.trim() && state === "error" && <SearchState>{t("search.error")}</SearchState>}
						{query.trim() && state === "idle" && results.length === 0 && <SearchState>{t("search.noResults")}</SearchState>}

						{grouped.map((group) => (
							<Command.Group key={group.kind} heading={t(group.label)} className={GROUP_HEADING_CLS}>
								{group.results.map((result) => (
									<SearchRow key={result.id} result={result} showGoal={scope === "all"} onSelect={() => select(result)} />
								))}
							</Command.Group>
						))}
					</Command.List>
				</Command>
			</DialogContent>
		</Dialog>
	);
}

function ScopeButton({ active, children, onClick, testid }: { active: boolean; children: React.ReactNode; onClick: () => void; testid: string }) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-testid={testid}
			className={cn(
				"max-w-[70%] truncate rounded-full px-2.5 py-1 text-[0.72rem] font-medium transition-colors",
				active ? "bg-[var(--foreground)] text-[var(--background)]" : "text-[var(--foreground-40)] hover:bg-[var(--foreground-5)] hover:text-[var(--foreground)]",
			)}
		>
			{children}
		</button>
	);
}

function SearchState({ children }: { children: React.ReactNode }) {
	return <div className="px-4 py-10 text-center text-[0.82rem] text-[var(--foreground-30)]">{children}</div>;
}

function SearchRow({ result, showGoal, onSelect }: { result: SearchResult; showGoal: boolean; onSelect: () => void }) {
	const Icon = result.kind === "report" ? FileText : result.kind === "podcast" ? HeadphonesIcon : result.kind === "question" ? MessageSquare : Paperclip;
	return (
		<Command.Item
			value={result.id}
			onSelect={onSelect}
			data-testid={`content-search-result-${result.kind}`}
			className={cn(
				"group flex cursor-pointer items-start gap-3 rounded-[9px] px-3 py-2.5 text-[var(--foreground-60)]",
				"data-[selected=true]:bg-[var(--foreground-5)] data-[selected=true]:text-[var(--foreground)] aria-selected:bg-[var(--foreground-5)] aria-selected:text-[var(--foreground)]",
			)}
		>
			<span className="mt-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-[7px] border border-[var(--border)] bg-[var(--background)] text-[var(--foreground-30)] group-data-[selected=true]:text-[var(--foreground)]">
				<Icon className="h-3.5 w-3.5" aria-hidden />
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="truncate text-[0.86rem] font-medium text-[var(--foreground)]">{result.title}</span>
					{showGoal && <span className="flex-none truncate text-[0.68rem] text-[var(--foreground-30)]">{result.goalTitle}</span>}
				</span>
				<span className="mt-0.5 block truncate text-[0.73rem] text-[var(--foreground-30)]">{result.summary}</span>
			</span>
		</Command.Item>
	);
}
