import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledAgentSkillPaths, materializeSkills, snapshotSkills, type SkillSetSnapshot } from '../agent-runtime/skill-registry.js';
import { createNoteFirstWorkspace } from './note-first-workspace.js';
import type { NoteFirstInput } from './note-first-contract.js';

/** The Topic stage uses the same reading contract through a native Python Skill. */
export const skillPrompt = (source: string) => source.replaceAll('search_wiki', 'wiki.search').replaceAll('read_wiki', 'wiki.read')
 .replace('To expand one page, run from pathlib import Path; print(Path("../input/indexes/P1.json").read_text()) in IPython using its actual P alias.', 'To expand one page, print(wiki.overview("P1")) in IPython using its actual P alias.')
 .replace('Raw file reads do not create reading receipts.', 'Print complete selected sections in IPython; assigning text to variables does not establish delivery. Runtime checks model-visible output.')
 .replace('Raw filesystem reads do not create read receipts.', 'Print complete selected sections in IPython. Runtime records only complete section text actually returned to the model.')
 .replace('Read selected content through wiki.read; Runtime records which complete pages and sections were returned.', 'Read selected content through wiki.read and print it; Runtime records which complete sections were visibly returned.');

export function createStageWorkspace(input: NoteFirstInput, inputRoot: string,
 skillSnapshot: SkillSetSnapshot = snapshotSkills(bundledAgentSkillPaths('wiki', 'note-first'))) {
 if (input.stage !== 'topic') return { ...createNoteFirstWorkspace(input, inputRoot), skillRoot: undefined,
  observe(_toolCallId: string, _visible: string) {}, observations: (): Array<{ toolCallId: string; sectionRef: string }> => [] };

 // Export through a separate closure. Materializing data never grants reading receipts.
 const exported = createNoteFirstWorkspace(input, inputRoot);
 const sectionRefs = Object.values(exported.overviews).flatMap(page => page.sections.map(section => section.section_ref));
 const refs = [...Object.keys(exported.overviews), ...sectionRefs];
 const reads = Object.fromEntries(refs.map(ref => [ref, exported.read(ref)]));
 const sections = sectionRefs.map(ref => ({ ref, body: reads[ref]!.slice(ref.length + 1) }));
 const skills = materializeSkills(skillSnapshot, join(inputRoot, 'skills'));
 const skillRoot = skills.get('wiki');
 if (skills.size !== 1 || !skillRoot) throw new Error('Wiki Topic requires exactly the registered wiki Python Skill');
 writeFileSync(join(skillRoot, 'dataset.json'), JSON.stringify({ reads, search_rows: exported.searchIndex, overviews: exported.overviews }));
 const workspace = createNoteFirstWorkspace(input, inputRoot);
 assert.equal(workspace.receipts().sections.length, 0, 'Dataset export must not grant read receipts');
 assert.ok(!Object.keys(reads).some(ref => /^N\d+$/.test(ref)), 'Topic must not export standalone Cue content');
 assert.ok(!existsSync(join(inputRoot, 'evidence')) && !existsSync(join(inputRoot, 'evidence.md')), 'Topic must not expose evidence files');
 const userContext = skillPrompt(workspace.userContext) + `\n\nWiki Python Skill: read ${skillRoot}/SKILL.md in IPython before using wiki.overview, wiki.search and wiki.read. The wiki module is preloaded. Calls return Python values; print complete selected sections before linking.`;
 writeFileSync(join(inputRoot, 'index.md'), userContext);
 const observed = new Set<string>(), observations: Array<{ toolCallId: string; sectionRef: string }> = [];
 return { ...workspace, userContext, skillRoot,
  observe(toolCallId: string, visible: string) {
   for (const section of sections) if (!observed.has(section.ref) && visible.includes(section.body.trim())) {
    observed.add(section.ref); workspace.read(section.ref); observations.push({ toolCallId, sectionRef: section.ref });
   }
  }, observations: () => observations };
}
