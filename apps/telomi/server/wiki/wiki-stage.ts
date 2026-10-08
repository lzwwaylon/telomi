import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { listJsonl } from "../lib/fs.js";
import { hashJson, sha256 } from "../lib/hash.js";
import { sessionExecutionEntries } from "../observability/session-traces.js";
import type { WikiStageOutcome, WikiStageRequest } from "./wiki-stage-contract.js";

/** Read untrusted output without following links or accepting shared inodes. */
export function readWikiStageOutput(path: string): Buffer {
 const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("Wiki output must be a single regular file under 16 MB");
  return readFileSync(descriptor);
 } finally { closeSync(descriptor); }
}

/** Includes Markdown bytes, not just the manifest that names those files. */
export function wikiStageOutputHash(workRoot: string): string {
 const files: Array<{ path: string; sha256: string }> = [{ path: "result.json", sha256: sha256(readWikiStageOutput(join(workRoot, "result.json"))) }];
 if (existsSync(join(workRoot, 'facts.json'))) files.push({ path: 'facts.json', sha256: sha256(readWikiStageOutput(join(workRoot, 'facts.json'))) });
 const pagesRoot = join(workRoot, "pages");
 const visit = (directory: string, prefix: string): void => {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Wiki pages directory must not be a link");
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
   const path = join(directory, entry.name);
   const relative = `${prefix}/${entry.name}`;
   if (entry.isDirectory()) visit(path, relative);
   else if (!entry.isFile()) throw new Error("Wiki outputs cannot contain links or special files");
   else files.push({ path: relative, sha256: sha256(readWikiStageOutput(path)) });
  }
 };
 if (existsSync(pagesRoot)) visit(pagesRoot, "pages");
 return hashJson(files.sort((left, right) => left.path.localeCompare(right.path)));
}

export function wikiStageTraceUsage(root: string): ResearchModelUsage {
 const usage: ResearchModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
 for (const path of listJsonl(root).filter(path => path.includes("/sessions/"))) {
  const records = readFileSync(path, "utf8").split("\n").flatMap(line => {
   try { return [JSON.parse(line)]; } catch { return []; }
  });
  for (const record of sessionExecutionEntries(path, records)) {
   const item = record.type === "message" && record.message?.role === "assistant" ? record.message.usage
    : record.type === "compaction" || record.type === "branch_summary" ? record.usage : undefined;
   if (!item) continue;
   usage.inputTokens += (item.input ?? 0) + (item.cacheRead ?? 0) + (item.cacheWrite ?? 0);
   usage.outputTokens += item.output ?? 0;
   usage.costUsd += item.cost?.total ?? 0;
   usage.calls += 1;
  }
 }
 return usage;
}

export async function runWikiStageKind(request: WikiStageRequest): Promise<WikiStageOutcome> {
 request.signal.throwIfAborted();
 if (request.input.stage === "curate-evidence") return (await import("./pi-evidence-curation.js")).runPiEvidenceCurationStage(request);
 if (request.input.stage === "page-topics") return (await import("./page-topic-stage.js")).runPageTopicStage(request);
 if (request.input.stage === "merge-objects") return (await import("./pi-object-merge.js")).runPiObjectMergeStage(request);
 if (request.input.stage === "objects") return (await import("./pi-object-stage.js")).runPiObjectStage(request);
 if (["plan-concepts", "concepts", "audit-concepts", "merge-concepts"].includes(request.input.stage))
  return (await import("./pi-concept-stage.js")).runPiConceptStage(request);
 throw new Error(`Unsupported Wiki compilation stage: ${request.input.stage}`);
}

/** Compiler and stage checkpoints share the registered Prompt/reference/code identity. */
export function wikiStageCapabilityIdentity(): string {
 const files = ["wiki-stage.ts", "wiki-stage-contract.ts", "wiki-stage-workspace.ts",
  "wiki-stage-search.ts", "wiki-page-contract.ts", "wiki-edition.ts",
  "page-topic-stage.ts", "page-topic-contract.ts", "pi-evidence-curation.ts", "pi-object-stage.ts", "pi-object-targets.ts", "pi-object-merge.ts",
  "pi-file-stage.ts", "wiki-pi-runtime.ts", "../main-agent/wiki-context.ts", "../observability/session-traces.ts", "../providers/custom-models.ts", "../agent-runtime/logical-workspace-snapshot.ts", "../agent-runtime/srt-agent-sandbox.ts", "pi-concept-stage.ts", "pi-concept-contract.ts", "../agent-runtime/accept-agent-output.ts",
  "../../../extensions/pi-user-memory/index.ts", "../../../extensions/pi-user-memory/src/client.ts"];
 const semantics = files.map(path => sha256(readFileSync(fileURLToPath(new URL(path, import.meta.url)))));
 const prompt = renderAgentPrompt("wiki", "wiki-compilation", "system", {}, "objects-pi");
 return hashJson({ semantics, registration: prompt.configSha256,
  evidenceCuration: renderAgentPrompt("wiki", "wiki-compilation", "system", {}, "curate-evidence-pi").content,
  mainWikiSelection: renderAgentPrompt("main", "main-agent", "system-append", {}, "background-wiki-selection").content,
  userMemorySkill: sha256(readFileSync(fileURLToPath(new URL("../../agents/main/main-agent/skills/user-memory/SKILL.md", import.meta.url)))),
  pageTopics: renderAgentPrompt("wiki", "wiki-compilation", "system", {}, "page-topics").content,
  piObjects: renderAgentPrompt("wiki", "wiki-compilation", "system", {}, "objects-pi").content,
  piObjectPage: renderAgentPrompt("wiki", "wiki-compilation", "reference", {}, "object-page").content,
  piConceptCommon: renderAgentPrompt("wiki", "wiki-compilation", "reference", {}, "concept-common").content,
  piConcepts: ["question-plan-pi", "concepts-pi", "audit-concepts-pi", "merge-concepts-pi"]
   .map(variant => renderAgentPrompt("wiki", "wiki-compilation", "system", {}, variant).content),
  piObjectMerge: ["plan-object-targets-pi", "write-object-target-pi", "resolve-object-cues-pi"]
   .map(variant => renderAgentPrompt("wiki", "wiki-compilation", "system", {}, variant).content),
 });
}
