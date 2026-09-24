import type { CornellNotesSnapshot } from "../../cornell/contracts.js";

export type AgentEvidenceHandle = `@${number}`;

export interface AgentEvidenceHandles {
	byEvidenceId: ReadonlyMap<string, AgentEvidenceHandle>;
	byHandle: ReadonlyMap<AgentEvidenceHandle, string>;
}

const EVIDENCE_HANDLE = /^@[1-9][0-9]*$/u;

export function createAgentEvidenceHandles(
	snapshots: readonly CornellNotesSnapshot[],
): AgentEvidenceHandles {
	const byEvidenceId = new Map<string, AgentEvidenceHandle>();
	const byHandle = new Map<AgentEvidenceHandle, string>();
	const bySource = new Map<string, AgentEvidenceHandle>();
	for (const snapshot of snapshots) {
		for (const evidence of snapshot.notes) {
			const source = evidenceSourceKey(evidence.title, evidence.canonical_locator);
			const handle = bySource.get(source)
				?? (`@${bySource.size + 1}` as AgentEvidenceHandle);
			bySource.set(source, handle);
			byEvidenceId.set(evidence.note.source_id, handle);
			byHandle.set(handle, evidence.note.source_id);
		}
	}
	return { byEvidenceId, byHandle };
}

function evidenceSourceKey(title: string, locator: string): string {
	let normalizedLocator = locator.trim();
	try {
		const url = new URL(normalizedLocator);
		url.hash = "";
		normalizedLocator = url.href;
	} catch {
		// Non-URL locators remain valid Evidence identities.
	}
	return JSON.stringify([
		title.trim().replace(/\s+/gu, " ").toLowerCase(),
		normalizedLocator,
	]);
}

export function requireAgentEvidenceHandle(
	handles: AgentEvidenceHandles,
	evidenceId: string,
): AgentEvidenceHandle {
	const handle = handles.byEvidenceId.get(evidenceId);
	if (!handle) throw new Error(`Evidence '${evidenceId}' has no Agent handle`);
	return handle;
}

export function resolveAgentEvidenceHandle(
	handles: AgentEvidenceHandles,
	handle: string,
): string {
	if (!EVIDENCE_HANDLE.test(handle)) throw new Error(`Invalid Evidence handle '${handle}'`);
	const evidenceId = handles.byHandle.get(handle as AgentEvidenceHandle);
	if (!evidenceId) throw new Error(`Agent referenced unknown Evidence handle '${handle}'`);
	return evidenceId;
}
