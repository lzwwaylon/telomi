import { useCallback, useState } from "react";

/**
 * Local read state for inbox alerts. Alerts are derived from live account and source
 * status, so they cannot be deleted; the user instead marks the current wording of an
 * alert as seen (opening the panel) or dismissed (the clear button). A key covers the
 * alert's id and text, so an alert whose content changes, for example quota moving from a
 * warning to exhausted, surfaces again as unread.
 */
export type InboxMark = "seen" | "dismissed";
export type InboxMarks = Record<string, InboxMark>;

export interface InboxAlertLike {
	id: string;
	title: string;
	description: string;
}

const STORAGE_KEY = "telomi.inbox.marks.v1";

export function alertKey(alert: InboxAlertLike): string {
	return `${alert.id}\n${alert.title}\n${alert.description}`;
}

/** Applies `mark` to every alert and drops marks for alerts that no longer exist. Dismissed never downgrades to seen. */
export function markAlerts(marks: InboxMarks, alerts: InboxAlertLike[], mark: InboxMark): InboxMarks {
	const next: InboxMarks = {};
	for (const alert of alerts) {
		const key = alertKey(alert);
		const current = marks[key];
		next[key] = mark === "dismissed" || current === "dismissed" ? "dismissed" : mark;
	}
	return next;
}

export function unreadAlerts<T extends InboxAlertLike>(marks: InboxMarks, alerts: T[]): T[] {
	return alerts.filter((alert) => marks[alertKey(alert)] === undefined);
}

export function visibleAlerts<T extends InboxAlertLike>(marks: InboxMarks, alerts: T[]): T[] {
	return alerts.filter((alert) => marks[alertKey(alert)] !== "dismissed");
}

function loadMarks(): InboxMarks {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		if (!parsed || typeof parsed !== "object") return {};
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				(entry): entry is [string, InboxMark] => entry[1] === "seen" || entry[1] === "dismissed",
			),
		);
	} catch {
		return {};
	}
}

export function useInboxMarks(): [InboxMarks, (alerts: InboxAlertLike[], mark: InboxMark) => void] {
	const [marks, setMarks] = useState<InboxMarks>(loadMarks);
	const mark = useCallback((alerts: InboxAlertLike[], value: InboxMark) => {
		setMarks((current) => {
			const next = markAlerts(current, alerts, value);
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				// Browser privacy settings can disable localStorage; the state still applies for this session.
			}
			return next;
		});
	}, []);
	return [marks, mark];
}
