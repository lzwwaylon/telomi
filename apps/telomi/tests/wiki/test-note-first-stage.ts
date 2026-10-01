import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagePrompt } from "../../server/wiki/note-first-prompt.js";
import { skillPrompt } from "../../server/wiki/note-first-topic-skill.js";
import { renderAgentPrompt } from "../../server/agent-runtime/prompt-registry.js";
import type { NoteFirstStage } from "../../server/wiki/note-first-contract.js";
import { noteFirstOutputHash, readNoteFirstOutput } from "../../server/wiki/note-first-stage.js";

const root = mkdtempSync(join(tmpdir(), "note-first-output-"));
try {
 const stages: NoteFirstStage[] = ['objects', 'merge-objects', 'plan-concepts', 'concepts', 'merge-concepts', 'plan-topics', 'topic'];
 const source = renderAgentPrompt('wiki', 'note-first', 'system-append', {}).content;
 for (const stage of stages) {
  const prompt = stagePrompt(source, stage);
  assert.deepEqual([...prompt.matchAll(/^(objects|merge-objects|plan-concepts|concepts|audit-concepts|merge-concepts|plan-topics|topic): /gm)].map(match => match[1]), [stage]);
  assert.ok(renderAgentPrompt('wiki', 'note-first', 'user', { stage }).content.includes(stage));
 }
 for (const variant of ['question-plan-pi', 'concepts-pi', 'audit-concepts-pi', 'merge-concepts-pi']) {
  const prompt = renderAgentPrompt('wiki', 'note-first', 'system', {}, variant).content;
  assert.ok(prompt.trim(), `${variant} must render a nonempty stage contract`);
 }
 const topicPrompt = skillPrompt(stagePrompt(source, 'topic'));
 assert.ok(topicPrompt.includes('wiki.read'));
 assert.ok(!topicPrompt.includes('read_wiki'));
 assert.throws(() => stagePrompt(source.replace(/^merge-concepts: /m, 'missing: '), 'topic'));
 assert.throws(() => Reflect.apply(stagePrompt, undefined, [source, 'relations']), /Unknown Wiki stage/u);
 const work = join(root, "work");
 mkdirSync(join(work, "pages"), { recursive: true });
 writeFileSync(join(work, "result.json"), JSON.stringify({ pages: [{ file: "pages/O1.md" }] }));
 const page = join(work, "pages", "O1.md");
 writeFileSync(page, "Original supported statement.");
 const accepted = noteFirstOutputHash(work);
 writeFileSync(page, "Different statement, manifest unchanged.");
 assert.notEqual(noteFirstOutputHash(work), accepted, "changing Markdown after submission invalidates acceptance even when the manifest is unchanged");
 writeFileSync(page, "Original supported statement.");
 assert.equal(noteFirstOutputHash(work), accepted);
 writeFileSync(join(work, "pages", "extra.md"), "An undeclared page.");
 assert.notEqual(noteFirstOutputHash(work), accepted, "adding another output page invalidates acceptance");
 rmSync(join(work, "pages", "extra.md"));
 const outside = join(root, "outside.md");
 writeFileSync(outside, "Private data.");
 rmSync(page);
 symlinkSync(outside, page);
 assert.throws(() => readNoteFirstOutput(page));
 assert.throws(() => noteFirstOutputHash(work), /links/u);
 rmSync(page);
 linkSync(outside, page);
 assert.throws(() => noteFirstOutputHash(work), /single regular file/u, "hardlinked outputs must not share another file's inode");
 rmSync(join(work, "pages"), { recursive: true });
 symlinkSync(root, join(work, "pages"));
 assert.throws(() => noteFirstOutputHash(work), /link/u, "a linked output directory must never be traversed");
 console.log("Note-first accepted artifacts bind Markdown content and reject linked outputs");
} finally { rmSync(root, { recursive: true, force: true }); }
