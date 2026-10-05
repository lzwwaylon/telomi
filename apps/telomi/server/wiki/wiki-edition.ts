import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { hashJson } from "../lib/hash.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { listWikiMarkdown } from "./model/files.js";
import { splitFrontmatter } from "./model/frontmatter.js";
import type { noteWikiEntries } from "./note-entries.js";
import type { GoalTopicPlan } from "./contracts.js";
import { wikiPageEntryIds, type WikiPageContent, type WikiPagesResult, type WikiTopicResult, type WikiPageSection } from "./wiki-page-contract.js";
export type WikiNoteEntry = ReturnType<typeof noteWikiEntries>[number];
export interface PreviousWikiEdition {
 pages: WikiPageContent[];
 entries: WikiNoteEntry[];
 files: Map<string, { path: string; content: string }>;
 relations: WikiPagesResult["relations"];
}

export async function readPreviousWikiEdition(root: string): Promise<PreviousWikiEdition> {
 const previous: PreviousWikiEdition = { pages: [], entries: [], files: new Map(), relations: [] };
 if (!existsSync(root)) return previous;
 const registry = join(root, ".note-registry.json");
 if (!existsSync(registry)) {
  // Goal creation provisions empty directories before any Edition exists.
  // Any file or link may be existing knowledge and must retain the registry guard.
  if (readdirSync(root, { recursive: true, withFileTypes: true }).every(entry => entry.isDirectory())) return previous;
  throw new Error("Previous Wiki is missing its Note Registry");
 }
 previous.entries = JSON.parse(readFileSync(registry, "utf8")).entries;
 if (!Array.isArray(previous.entries) || previous.entries.some(entry => !/^entry:[a-f0-9]{24}$/u.test(entry.id))) throw new Error("Previous Wiki Note Registry is invalid");
 const saved = join(root, ".object-first-pages.json");
 const stored: WikiPageContent[] | undefined = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : undefined;
 if (stored && !Array.isArray(stored)) throw new Error("Previous Wiki page manifest must be an array");
 for (const path of await listWikiMarkdown(root)) {
  const content = readFileSync(path, "utf8");
  const { fields, body } = splitFrontmatter(content);
  if (fields?.type !== "entity" && fields?.type !== "concept") continue;
  const id = typeof fields.page_id === "string" ? fields.page_id : `${fields.type}:${hashJson(relative(root, path)).slice(0, 16)}`;
  const footnotes = new Map([...body.matchAll(/^\[\^(\d+)\]:.*Note Entry `?(entry:[a-f0-9]{24})`?/gmu)].map(match => [match[1]!, match[2]!]));
  const converted = body.replace(/^\s*#\s+.*\n+/u, "").replace(/\n## (?:Related|Evidence)\s*\n[\s\S]*$/u, "")
   .replace(/\[\^(\d+)\]/gu, (_match, index: string) => { const ref = footnotes.get(index); if (!ref) throw new Error("Previous Wiki has an unresolved footnote"); return `[[${ref}]]`; });
  const parsed: WikiPageContent = { id, kind: fields.type, title: String(fields.title), description: String(fields.description ?? ""), body: converted };
  const page = stored?.find(candidate => candidate.id === id) ?? parsed;
  if (hashJson({ ...page, body: page.body.trim() }) !== hashJson({ ...parsed, body: parsed.body.trim() })) {
   throw new Error(`Previous Wiki page manifest differs from published Markdown: ${id}`);
  }
  if (wikiPageEntryIds(page.body).some(ref => !previous.entries.some(entry => entry.id === ref))) throw new Error("Previous Wiki references an unknown Note Entry");
  if (previous.files.has(id)) throw new Error(`Previous Wiki duplicates Page identity ${id}`);
  previous.pages.push(page);
  previous.files.set(id, { path: relative(root, path), content });
 }
 if (stored && (stored.length !== previous.pages.length || stored.some(page => !previous.files.has(page.id)))) throw new Error("Previous Wiki page manifest does not match its files");
 const relationFile = join(root, ".object-first-relations.json");
 if (existsSync(relationFile)) previous.relations = JSON.parse(readFileSync(relationFile, "utf8"));
 else for (const [from, file] of previous.files) {
  const related = /\n## Related\s*\n([\s\S]*?)(?=\n## |$)/u.exec(file.content)?.[1] ?? "";
  for (const match of related.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)(?: - (.*))?$/gmu)) {
   const target = resolve(root, dirname(file.path), match[2]!.split("#")[0]!);
   const to = [...previous.files].find(([, candidate]) => resolve(root, candidate.path) === target)?.[0];
   if (!to) throw new Error(`Previous Wiki Related link cannot resolve: ${match[2]}`);
   previous.relations.push({ from, to, label: match[3]?.trim() || match[1]! });
  }
 }
 return previous;
}

export function writeWikiEdition(root: string, pages: WikiPageContent[], entries: WikiNoteEntry[], result: WikiPagesResult,
 previous: PreviousWikiEdition): void {
 mkdirSync(root, { recursive: true });
 const byId = new Map(entries.map(entry => [entry.id, entry]));
 const paths = pagePaths(pages, previous);
 for (const page of pages) {
  const target = join(root, paths.get(page.id)!);
  mkdirSync(dirname(target), { recursive: true });
  const related = result.relations.filter(edge => edge.from === page.id).map(edge => `- [${pages.find(candidate => candidate.id === edge.to)!.title}](${posix.relative(posix.dirname(paths.get(page.id)!), paths.get(edge.to)!)}) - ${edge.label}`);
  const old = previous.pages.find(candidate => candidate.id === page.id);
  if (old && hashJson(old) === hashJson(page)) {
   const content = previous.files.get(page.id)!.content;
   const oldRelations = previous.relations.filter(edge => edge.from === page.id);
   const newRelations = result.relations.filter(edge => edge.from === page.id);
   if (hashJson(oldRelations) === hashJson(newRelations)) writeFileSync(target, content);
   else {
    // Keep the authored body and evidence bytes exactly; only derived links change.
    const withoutRelated = content.replace(/\n## Related\s*\n[\s\S]*?(?=\n## |$)/u, "");
    writeFileSync(target, withoutRelated.replace(/\n## Evidence[ \t]*\r?\n/u, heading =>
     `${related.length ? `\n## Related\n\n${related.join("\n")}\n` : ""}${heading}`));
   }
   continue;
  }
  const ids = wikiPageEntryIds(page.body);
  const body = page.body.replace(/\[\[(entry:[a-f0-9]{24})\]\]/gu, (_match, id: string) => `[^${ids.indexOf(id) + 1}]`);

  writeFileSync(target, ["---", `page_id: ${JSON.stringify(page.id)}`, `type: ${page.kind}`, `title: ${JSON.stringify(page.title)}`,
   `description: ${JSON.stringify(page.description)}`, `entry_ids: ${JSON.stringify(ids)}`, `sources: ${JSON.stringify([...new Set(ids.flatMap(id => {
    const entry = byId.get(id)!; return [entry.sourceId, ...entry.anchors.flatMap(anchor => anchor.sourceId ? [anchor.sourceId] : [])];
   }))])}`,
   "---", "", `# ${page.title}`, "", body, ...(related.length ? ["", "## Related", ...related] : []), "", "## Evidence", "",
   ...ids.map((id, i) => { const entry = byId.get(id)!;
    const sources = [...new Map([[entry.canonicalLocator, entry.sourceTitle] as const, ...entry.members.map(member => [member.canonical_locator, member.title] as const),
     ...entry.anchors.flatMap(anchor => anchor.canonicalLocator && anchor.sourceTitle ? [[anchor.canonicalLocator, anchor.sourceTitle] as const] : [])]).entries()];
    return `[^${i + 1}]: ${sources.map(([url, title]) => `[${title}](${url})`).join("; ")}; Note Entry \`${id}\`; ${entry.anchors.map(anchor => `${anchor.path}:${anchor.startLine}-${anchor.endLine} (${anchor.sha256.slice(0, 12)})`).join("; ")}`;
   }), ""].join("\n"));
 }
 writeJsonAtomic(join(root, ".note-registry.json"), { schema_version: 2, entries });
 writeJsonAtomic(join(root, ".object-first-pages.json"), pages);
 writeJsonAtomic(join(root, ".object-first-relations.json"), result.relations);
 writeJsonAtomic(join(root, ".deferred-notes.json"), result.deferred_entries.map(row => ({ entry_id: row.entry_ref, reason: row.reason })));
}

/** Only these navigation files are written by a Topic-only update. */
export function writeWikiIndex(root: string, pages: WikiPageContent[], index: WikiTopicResult,
 sections: WikiPageSection[], topics: GoalTopicPlan, previous: PreviousWikiEdition): void {
 const paths = pagePaths(pages, previous);
 writeJsonAtomic(join(root, ".topic-plan.json"), topics);
 writeJsonAtomic(join(root, ".topic-index.json"), { schema_version: 1, ...index, sections });
 writeFileSync(join(root, "README.md"), ["# Goal Wiki", "", ...index.topics.flatMap(topic => [
  `## ${topics.topics.find(candidate => candidate.id === topic.topicId)!.title}`, "",
  ...(topic.status === 'failed' ? [`Topic indexing failed: ${(topic.error ?? 'Unknown error').replace(/[\r\n]+/gu, ' ')}`, ""] : []),
  ...topic.sections.map(ref => { const section = sections.find(candidate => candidate.ref === ref)!; const page = pages.find(candidate => candidate.id === section.pageId)!;
   return `- [${page.title}: ${section.heading}](${paths.get(page.id)}#${section.anchor})`; }),
  ...topic.gaps.map(gap => `- Coverage gap: ${gap}`), "", ]), "## All knowledge", "",
  ...pages.map(page => `- [${page.title}](${paths.get(page.id)})`), ""].join("\n"));
}
function pagePaths(pages: WikiPageContent[], previous: PreviousWikiEdition): Map<string, string> {
 const paths = new Map(pages.map(page => [page.id, previous.files.get(page.id)?.path ?? `${page.kind === "entity" ? "entities" : "concepts"}/${page.id.split(":")[1]}.md`]));
 if (new Set(paths.values()).size !== paths.size) throw new Error("Wiki page Pages collide on an output path");
 return paths;
}
