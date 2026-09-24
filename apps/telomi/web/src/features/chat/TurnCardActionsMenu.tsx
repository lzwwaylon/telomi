import * as React from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, FileDiff, MoreHorizontal } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

export interface TurnCardActionsMenuProps {
	onOpenDetails?: () => void;
	onOpenMultiFileDiff?: () => void;
	hasEditOrWriteActivities?: boolean;
	className?: string;
}

export function TurnCardActionsMenu({
	onOpenDetails,
	onOpenMultiFileDiff,
	hasEditOrWriteActivities,
	className,
}: TurnCardActionsMenuProps) {
	const { t } = useTranslation();
	const [isOpen, setIsOpen] = React.useState(false);

	if (!onOpenDetails && !onOpenMultiFileDiff) return null;

	return (
		<DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={t("turnCard.viewTurnDetails")}
					className={cn(
						"p-1 rounded-[6px] transition-opacity shrink-0",
						"opacity-0 group-hover:opacity-100",
						"bg-background shadow-minimal",
						"text-muted-foreground/50 hover:text-foreground",
						"focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100",
						isOpen && "opacity-100 text-foreground",
						className,
					)}
				>
					<MoreHorizontal className="w-3 h-3" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
			{onOpenMultiFileDiff && hasEditOrWriteActivities && (
				<DropdownMenuItem onSelect={onOpenMultiFileDiff}>
					<FileDiff />
					{t("turnCard.viewFileChanges")}
				</DropdownMenuItem>
			)}
			{onOpenDetails && (
				<DropdownMenuItem onSelect={onOpenDetails}>
					<ArrowUpRight />
					{t("turnCard.viewTurnDetails")}
				</DropdownMenuItem>
			)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
