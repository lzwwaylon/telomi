import type { PublishedReport } from "@/features/chat/turn-utils";
import { uiText } from "@/app/ui-text";

export interface ResearchDelivery {
	runId: string;
	title: string;
	lede: string;
	artifactName: string;
	cardId: string;
}

/** The chat report card for a reply the Runtime stamped with a published report. */
export function researchDeliveryFromReport(report: PublishedReport | undefined): ResearchDelivery | null {
	if (!report || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(report.runId)) return null;
	const artifactName = `wiki/runs/${report.runId}/report/final.md`;
	return {
		runId: report.runId,
		artifactName,
		cardId: cardIdFromArtifactName(artifactName),
		title: report.title || uiText("common.researchReport"),
		lede: uiText("chat.researchDelivery.theReportIsReadyClickToViewTheFull"),
	};
}

function cardIdFromArtifactName(name: string): string {
	const bytes = new TextEncoder().encode(name.replace(/\.md$/u, ""));
	const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
		.replace(/\+/gu, "-")
		.replace(/\//gu, "_")
		.replace(/=+$/gu, "");
	return `path_${encoded}`;
}
