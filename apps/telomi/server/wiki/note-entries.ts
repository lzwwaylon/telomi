import type { CornellNotesSnapshot } from "../cornell/contracts.js";
import { hashJson } from "../lib/hash.js";

interface NoteEntry {
	id: string; revisionSha256: string; sourceRunId: string; sourceId: string; sourceTitle: string; canonicalLocator: string;
	originCueRef?: string; sourceRevisionSha256?: string;
	members: CornellNotesSnapshot["notes"][number]["members"];
	section: string; sectionSummary?: string; cue: string; detail: string; topicRefs?: string[]; topicPlanRevision?: string;
	anchors: Array<{ path: string; startLine: number; endLine: number; sha256: string;
		sourceRunId?: string; sourceId?: string; sourceRevisionSha256?: string; sourceTitle?: string; canonicalLocator?: string }>;
}

export function noteWikiEntries(evidence: CornellNotesSnapshot, topicPlanRevision?: string): NoteEntry[] {
	return evidence.notes.flatMap((record) => record.note.sections.flatMap((section, sectionIndex) => section.cue_notes.map((note, noteIndex) => {
		const identity = note.origin_ref ? { origin: note.origin_ref }
			: { source: record.note.source_id, section: sectionIndex, cue: note.cue, note: noteIndex, detail: note.note };
		const revision = { identity, sourceTitle: record.title, canonicalLocator: record.canonical_locator, members: record.members,
			sourceRevisionSha256: record.source_revision_sha256, section: section.section_title, sectionSummary: section.summary,
			topicRefs: [...new Set(note.topic_refs ?? [])], anchors: note.evidence };
		return {
			id: `entry:${hashJson(identity).slice(0, 24)}`, revisionSha256: hashJson(revision), sourceRunId: record.source_run_id ?? evidence.run_id,
			...(note.origin_ref ? { originCueRef: note.origin_ref, sourceRevisionSha256: record.source_revision_sha256 } : {}),
			sourceId: record.note.source_id, sourceTitle: record.title, canonicalLocator: record.canonical_locator, members: record.members,
			section: section.section_title, sectionSummary: section.summary, cue: note.cue, detail: note.note,
			topicRefs: [...new Set(note.topic_refs ?? [])], ...(topicPlanRevision ? { topicPlanRevision } : {}),
			anchors: note.evidence.map((anchor) => ({ path: anchor.source_path, startLine: anchor.start_line,
				endLine: anchor.end_line, sha256: anchor.content_sha256,
				...(anchor.source_run_id ? { sourceRunId: anchor.source_run_id, sourceId: anchor.source_id,
					sourceRevisionSha256: anchor.source_revision_sha256, sourceTitle: anchor.source_title,
					canonicalLocator: anchor.canonical_locator } : {}) })),
		};
	})));
}
