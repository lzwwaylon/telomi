import { stagePrompt } from "./wiki-stage-prompt.js";
import { skillPrompt } from "./wiki-topic-skill.js";
import { bundledAgentSkillPaths, snapshotSkills } from "../agent-runtime/skill-registry.js";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStageThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { PRIME_MODEL_DEFINITIONS_ENV } from "../agent-runtime/prime-agent-paths.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { spawnPrimeWorker } from "../agent-runtime/prime-worker.js";
import { listJsonl, writeJsonAtomic } from "../lib/fs.js";
import { hashJson, sha256 } from "../lib/hash.js";
import { toErrorMessage } from "../lib/values.js";
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
 for (const path of listJsonl(root).filter(path => path.includes("/sessions/"))) for (const line of readFileSync(path, "utf8").split("\n")) {
  let record;
  try { record = JSON.parse(line); } catch { continue; }
  if (record.type !== "message" || record.message?.role !== "assistant" || !record.message.usage) continue;
  const item = record.message.usage;
  usage.inputTokens += (item.input ?? 0) + (item.cacheRead ?? 0) + (item.cacheWrite ?? 0);
  usage.outputTokens += item.output ?? 0;
  usage.costUsd += item.cost?.total ?? 0;
  usage.calls += 1;
 }
 return usage;
}

export async function runWikiStageKind(request: WikiStageRequest): Promise<WikiStageOutcome> {
 request.signal.throwIfAborted();
 if (request.input.stage === "page-topics") return (await import("./page-topic-stage.js")).runPageTopicStage(request);
 if (request.input.stage === "merge-objects") return (await import("./pi-object-merge.js")).runPiObjectMergeStage(request);
 if (request.input.stage === "objects" && request.input.entries.length > 0 && JSON.stringify(request.input.entries).length <= 50_000) {
  return (await import("./pi-object-stage.js")).runPiObjectStage(request);
 }
 if (["plan-concepts", "concepts", "audit-concepts", "merge-concepts"].includes(request.input.stage))
  return (await import("./pi-concept-stage.js")).runPiConceptStage(request);
 return runAgentWikiStageKind(request);
}

async function runAgentWikiStageKind(request: WikiStageRequest): Promise<WikiStageOutcome> {
 request.signal.throwIfAborted();
 const adapt = request.input.stage === "topic" ? skillPrompt : (value: string) => value;
 const system = adapt(stagePrompt(renderAgentPrompt("wiki", "wiki-compilation", "system-append", {}).content, request.input.stage));
 const user = adapt(renderAgentPrompt("wiki", "wiki-compilation", "user", { stage: request.input.stage }).content);
 const skills = snapshotSkills(bundledAgentSkillPaths("wiki", "wiki-compilation"));
 const thinking = resolveStageThinkingLevel("wikiCurator", "maintenance", request.env).thinkingLevel;
 const semantics = wikiStageCapabilityIdentity();
 const identity = hashJson({ input: request.input, system, user, semantics, skills: skills.sha256, root: request.env.TELOMI_WIKI_CURATOR_MODEL,
  modelDefinitions: request.env[PRIME_MODEL_DEFINITIONS_ENV], thinking });
 const checkpoint = join(request.workRoot, "checkpoint.json");
 if (existsSync(checkpoint)) {
  const saved = JSON.parse(readWikiStageOutput(checkpoint).toString("utf8"));
  if (saved.identity !== identity) throw new Error("Wiki compilation stage input or execution contract changed across resume");
  if (saved.status === "succeeded") {
   const acceptedPath = join(saved.attemptRoot, "runtime", "accepted-result.json");
   const receiptsPath = join(saved.attemptRoot, "runtime", "receipts.json");
   if (saved.resultHash !== sha256(readWikiStageOutput(acceptedPath))
    || saved.receiptsHash !== sha256(readWikiStageOutput(receiptsPath))
    || saved.outputHash !== wikiStageOutputHash(join(saved.attemptRoot, "work"))
    || saved.outcomeHash !== hashJson(saved.outcome)) throw new Error("Accepted Wiki compilation checkpoint changed");
   request.onAttemptStarted?.(saved.attemptRoot);
   return saved.outcome as WikiStageOutcome;
  }
 }
 mkdirSync(request.workRoot, { recursive: true });
 const attemptRoot = realpathSync(mkdtempSync(join(request.workRoot, "attempt-")));
 const runtime = join(attemptRoot, "runtime");
 const work = join(attemptRoot, "work");
 const inputRoot = join(attemptRoot, "input");
 for (const path of [runtime, work, inputRoot]) mkdirSync(path);
 writeJsonAtomic(join(runtime, "input.json"), request.input);
 writeJsonAtomic(join(runtime, "skills.json"), skills);
 writeFileSync(join(runtime, "system-prompt.md"), system);
 writeFileSync(join(runtime, "user-prompt.md"), user);
 writeJsonAtomic(checkpoint, { identity, status: "running", attemptRoot });
 request.onAttemptStarted?.(attemptRoot);
 try {
  await spawnPrimeWorker({ name: `Wiki compilation ${request.input.stage}`, worker: fileURLToPath(new URL("./prime-wiki-stage-worker.ts", import.meta.url)),
   agentRoot: work, runtimeRoot: runtime, readonlyRoots: [inputRoot], env: request.env, signal: request.signal,
   onMessage: () => {},
   extraEnv: { WIKI_STAGE_RUNTIME: runtime, WIKI_STAGE_WORK: work, WIKI_STAGE_INPUT_ROOT: inputRoot,
    WIKI_STAGE_MODEL: request.env.TELOMI_WIKI_CURATOR_MODEL, WIKI_STAGE_THINKING: thinking } });
  request.signal.throwIfAborted();
  const acceptedPath = join(runtime, "accepted-result.json");
  const accepted = JSON.parse(readWikiStageOutput(join(runtime, "accepted.json")).toString("utf8"));
  if (accepted.outputHash !== wikiStageOutputHash(work)
   || accepted.resultHash !== sha256(readWikiStageOutput(acceptedPath))
   || accepted.receiptsHash !== sha256(readWikiStageOutput(join(runtime, "receipts.json")))) throw new Error("Accepted Wiki compilation artifacts changed");
  const outcome: WikiStageOutcome = { result: JSON.parse(readWikiStageOutput(acceptedPath).toString("utf8")),
   usage: wikiStageTraceUsage(request.workRoot), sessionPaths: sessionPaths(request.workRoot) };
  writeJsonAtomic(checkpoint, { identity, status: "succeeded", attemptRoot, ...accepted, outcomeHash: hashJson(outcome), outcome });
  return outcome;
 } catch (error) {
  const usage = wikiStageTraceUsage(request.workRoot);
  const paths = sessionPaths(request.workRoot);
  writeJsonAtomic(checkpoint, { identity, status: request.signal.aborted ? "cancelled" : "failed", attemptRoot,
   error: toErrorMessage(error), usage, sessionPaths: paths });
  throw Object.assign(error instanceof Error ? error : new Error(toErrorMessage(error)), { usage, sessionPaths: paths });
 }
}

function sessionPaths(root: string): string[] {
 return [...new Set(listJsonl(root).filter(path => path.includes("/sessions/")).map(path => path.slice(0, path.indexOf("/sessions/") + "/sessions".length)))];
}

/** Compiler and stage checkpoints share the registered Prompt/Skill/code identity. */
export function wikiStageCapabilityIdentity(): string {
 const files = ["wiki-stage.ts", "prime-wiki-stage-worker.ts", "wiki-stage-contract.ts", "wiki-stage-workspace.ts",
  "wiki-stage-search.ts", "wiki-topic-skill.ts", "wiki-stage-prompt.ts", "wiki-page-contract.ts", "wiki-edition.ts",
  "page-topic-stage.ts", "page-topic-contract.ts", "pi-object-stage.ts", "pi-object-targets.ts", "pi-object-merge.ts",
  "pi-file-stage.ts", "../agent-runtime/logical-workspace-snapshot.ts", "../agent-runtime/srt-agent-sandbox.ts", "pi-concept-stage.ts", "pi-concept-contract.ts", "../agent-runtime/accept-agent-output.ts"];
 const semantics = files.map(path => sha256(readFileSync(fileURLToPath(new URL(path, import.meta.url)))));
 const system = renderAgentPrompt("wiki", "wiki-compilation", "system-append", {});
 return hashJson({ semantics, system: system.content, registration: system.configSha256,
  pageTopics: renderAgentPrompt("wiki", "wiki-compilation", "system", {}, "page-topics").content,
  piObjects: renderAgentPrompt("wiki", "wiki-compilation", "system", {}, "objects-pi").content,
  piConceptCommon: renderAgentPrompt("wiki", "wiki-compilation", "reference", {}, "concept-common").content,
  piConcepts: ["question-plan-pi", "concepts-pi", "audit-concepts-pi", "merge-concepts-pi"]
   .map(variant => renderAgentPrompt("wiki", "wiki-compilation", "system", {}, variant).content),
  piObjectMerge: ["plan-object-targets-pi", "write-object-target-pi", "resolve-object-cues-pi"]
   .map(variant => renderAgentPrompt("wiki", "wiki-compilation", "system", {}, variant).content),
  users: ["objects", "merge-objects", "plan-concepts", "concepts", "merge-concepts", "plan-topics", "topic"]
   .map(stage => renderAgentPrompt("wiki", "wiki-compilation", "user", { stage }).content),
  skills: snapshotSkills(bundledAgentSkillPaths("wiki", "wiki-compilation")).sha256 });
}
