import { useEffect, useRef, useState } from "react";
import { Gauge, PlugZap, ShieldAlert, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { BellIcon as Bell } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { useCodexAccountAlerts } from "@/features/home/useCodexAccountAlerts";
import { useSourceAlerts } from "@/features/home/useSourceAlerts";
import { useCapabilityAlerts } from "@/features/home/useCapabilityAlerts";
import type { SettingsSection } from "@/features/settings/settings-sections";
import { useTranslation } from "react-i18next";
import { alertKey, unreadAlerts, useInboxMarks, visibleAlerts } from "@/features/home/inboxMarks";

interface NotificationBellProps {
	onOpenSettings: (section?: SettingsSection) => void;
}

/**
 * Global inbox bell: capabilities that need the user before they work again, Codex account alerts
 * and external sources research currently skips. Each alert opens the settings page that fixes it.
 */
export function NotificationBell({ onOpenSettings }: NotificationBellProps) {
	const { t } = useTranslation();
	const codexAlerts = useCodexAccountAlerts();
	const sourceAlerts = useSourceAlerts();
	const capabilityAlerts = useCapabilityAlerts();
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const [marks, mark] = useInboxMarks();

	const all = [
		...capabilityAlerts.map((alert) => ({
			...alert,
			icon: alert.target === "sources" ? PlugZap : alert.kind === "rejected" ? ShieldAlert : alert.kind === "failed" ? TriangleAlert : SlidersHorizontal,
			action: t("inbox.capability.open", { section: t(`settings.section.${alert.target}`) }),
		})),
		...codexAlerts.map((alert) => ({
			...alert,
			target: undefined as SettingsSection | undefined,
			icon: alert.kind === "quota" ? Gauge : ShieldAlert,
			action: t("inbox.viewAccounts"),
		})),
		...sourceAlerts.map((alert) => ({ ...alert, target: "sources" as const, icon: PlugZap, action: t("inbox.viewSources") })),
	];
	const alerts = visibleAlerts(marks, all);
	const unread = unreadAlerts(marks, all).length;
	const total = alerts.length;
	const allKeys = all.map(alertKey).join("\u0000");

	// Whatever is on screen while the panel is open counts as read.
	useEffect(() => {
		if (open) mark(all, "seen");
	}, [open, allKeys, mark]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && wrapRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div className="relative" ref={wrapRef}>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				title={unread > 0 ? t("inbox.unreadCount", { count: unread }) : t("inbox.pending")}
				aria-label={unread > 0 ? t("inbox.unreadCount", { count: unread }) : t("inbox.pending")}
				data-testid="topbar-inbox"
				className={cn(
					"relative flex items-center justify-center w-8 h-8 rounded-[8px] cursor-pointer",
					"text-[var(--ink-mut)] transition-[background-color,color] duration-150",
					"hover:bg-[var(--paper-2)] hover:text-[var(--ink)]",
					open && "bg-[var(--paper-2)] text-[var(--ink)]",
				)}
			>
				<Bell className="h-4 w-4" aria-hidden />
				{unread > 0 && (
					<span
						className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-medium leading-none text-[var(--paper)]"
						data-testid="inbox-badge"
					>
						{unread > 9 ? "9+" : unread}
					</span>
				)}
			</button>

			{open && (
				<div
					className="fixed left-[calc(var(--rail-w)+0.75rem)] right-3 top-[4.25rem] z-50 max-h-[calc(100vh-5rem)] w-auto overflow-auto rounded-[10px] border border-[var(--line)] bg-[var(--paper)] p-2 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-[70vh] sm:w-[360px]"
					role="dialog"
					aria-label={t("inbox.label")}
					data-testid="inbox-panel"
				>
					<div className="flex items-center justify-between px-2 py-1.5 text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
						<span>{t("inbox.pending")}{total > 0 ? ` · ${total}` : ""}</span>
						{total > 0 && (
							<button
								type="button"
								className="normal-case tracking-normal text-[var(--ink-mut)] hover:text-[var(--ink)]"
								onClick={() => mark(all, "dismissed")}
								data-testid="inbox-clear"
							>
								{t("inbox.clear")}
							</button>
						)}
					</div>

					{total === 0 ? (
						<div className="px-2 py-6 text-center text-[13px] text-[var(--ink-mut)]">
							{all.length > 0 ? t("inbox.cleared") : t("inbox.empty")}
						</div>
					) : (
						<div className="grid gap-2">
							{alerts.map((alert) => {
								const AlertIcon = alert.icon;
								return (
									<article
										key={alert.id}
										className="rounded-[8px] border border-[var(--line)] bg-[var(--paper)] p-3"
										data-testid={alert.id}
									>
										<div className="flex items-start gap-2">
											<AlertIcon
												size={15}
												className="mt-0.5 flex-none text-[var(--accent)]"
												aria-hidden
											/>
											<div className="min-w-0 flex-1">
												<div className="text-[11px] text-[var(--ink-faint)]">
													{alert.title}
												</div>
												<div className="mt-0.5 text-[13.5px] leading-5 text-[var(--ink)]">
													{alert.description}
												</div>
												<div className="mt-2">
													<button
														type="button"
														className="inline-flex h-7 items-center rounded-[6px] border border-[var(--accent)] px-2.5 text-[12px] text-[var(--accent)] hover:bg-[var(--paper-2)]"
														onClick={() => {
															setOpen(false);
															onOpenSettings(alert.target);
														}}
													>
														{alert.action}
													</button>
												</div>
											</div>
										</div>
									</article>
								);
							})}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
