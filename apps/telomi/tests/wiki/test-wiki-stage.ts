import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAgentPrompt } from "../../server/agent-runtime/prompt-registry.js";
import { wikiStageOutputHash, readWikiStageOutput } from "../../server/wiki/wiki-stage.js";

const root = mkdtempSync(join(tmpdir(), "wiki-compilation-output-"));
try {
 for (const variant of ['objects-pi', 'plan-object-targets-pi', 'resolve-object-cues-pi', 'write-object-target-pi',
  'question-plan-pi', 'concepts-pi', 'audit-concepts-pi', 'merge-concepts-pi', 'page-topics']) {
  const prompt = renderAgentPrompt('wiki', 'wiki-compilation', 'system', {}, variant).content;
  assert.ok(prompt.trim(), `${variant} must render a nonempty stage contract`);
 }
 const work = join(root, "work");
 mkdirSync(join(work, "pages"), { recursive: true });
 writeFileSync(join(work, "result.json"), JSON.stringify({ pages: [{ file: "pages/O1.md" }] }));
 const page = join(work, "pages", "O1.md");
 writeFileSync(page, "Original supported statement.");
 const accepted = wikiStageOutputHash(work);
 writeFileSync(page, "Different statement, manifest unchanged.");
 assert.notEqual(wikiStageOutputHash(work), accepted, "changing Markdown after submission invalidates acceptance even when the manifest is unchanged");
 writeFileSync(page, "Original supported statement.");
 assert.equal(wikiStageOutputHash(work), accepted);
 writeFileSync(join(work, "pages", "extra.md"), "An undeclared page.");
 assert.notEqual(wikiStageOutputHash(work), accepted, "adding another output page invalidates acceptance");
 rmSync(join(work, "pages", "extra.md"));
 const outside = join(root, "outside.md");
 writeFileSync(outside, "Private data.");
 rmSync(page);
 symlinkSync(outside, page);
 assert.throws(() => readWikiStageOutput(page));
 assert.throws(() => wikiStageOutputHash(work), /links/u);
 rmSync(page);
 linkSync(outside, page);
 assert.throws(() => wikiStageOutputHash(work), /single regular file/u, "hardlinked outputs must not share another file's inode");
 rmSync(join(work, "pages"), { recursive: true });
 symlinkSync(root, join(work, "pages"));
 assert.throws(() => wikiStageOutputHash(work), /link/u, "a linked output directory must never be traversed");
 console.log("Wiki compilation accepted artifacts bind Markdown content and reject linked outputs");
} finally { rmSync(root, { recursive: true, force: true }); }
