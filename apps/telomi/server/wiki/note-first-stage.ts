import { stagePrompt } from "./note-first-prompt.js";
import { skillPrompt } from "./note-first-topic-skill.js";
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
import type { NoteFirstOutcome, NoteFirstStageRequest } from "./note-first-contract.js";

/** Read untrusted output without following links or accepting shared inodes. */
export function readNoteFirstOutput(path: string): Buffer {
 const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("Wiki output must be a single regular file under 16 MB");
  return readFileSync(descriptor);
 } finally { closeSync(descriptor); }
}

/** Includes Markdown bytes, not just the manifest that names those files. */
export function noteFirstOutputHash(workRoot: string): string {
 const files: Array<{ path: string; sha256: string }> = [{ path: "result.json", sha256: sha256(readNoteFirstOutput(join(workRoot, "result.json"))) }];
 const pagesRoot = join(workRoot, "pages");
 const visit = (directory: string, prefix: string): void => {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Wiki pages directory must not be a link");
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
   const path = join(directory, entry.name);
   const relative = `${prefix}/${entry.name}`;
   if (entry.isDirectory()) visit(path, relative);
   else if (!entry.isFile()) throw new Error("Wiki outputs cannot contain links or special files");
   else files.push({ path: relative, sha256: sha256(readNoteFirstOutput(path)) });
  }
 };
 if (existsSync(pagesRoot)) visit(pagesRoot, "pages");
 return hashJson(files.sort((left, right) => left.path.localeCompare(right.path)));
}

export function noteFirstTraceUsage(root: string): ResearchModelUsage {
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

export async function runNoteFirstStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 request.signal.throwIfAborted();
 const adapt = request.input.stage === "topic" ? skillPrompt : (value: string) => value;
 const system = adapt(stagePrompt(renderAgentPrompt("wiki", "note-first", "system-append", {}).content, request.input.stage));
 const user = adapt(renderAgentPrompt("wiki", "note-first", "user", { stage: request.input.stage }).content);
 const skills = snapshotSkills(bundledAgentSkillPaths("wiki", "note-first"));
 const thinking = resolveStageThinkingLevel("wikiMaintainer", "maintenance", request.env).thinkingLevel;
 const semantics = noteFirstCapabilityIdentity();
 const identity = hashJson({ input: request.input, system, user, semantics, skills: skills.sha256, root: request.env.TELOMI_WIKI_MAINTAINER_MODEL,
  modelDefinitions: request.env[PRIME_MODEL_DEFINITIONS_ENV], thinking });
 const checkpoint = join(request.workRoot, "checkpoint.json");
 if (existsSync(checkpoint)) {
  const saved = JSON.parse(readNoteFirstOutput(checkpoint).toString("utf8"));
  if (saved.identity !== identity) throw new Error("Note-first stage input or execution contract changed across resume");
  if (saved.status === "succeeded") {
   const acceptedPath = join(saved.attemptRoot, "runtime", "accepted-result.json");
   const receiptsPath = join(saved.attemptRoot, "runtime", "receipts.json");
   if (saved.resultHash !== sha256(readNoteFirstOutput(acceptedPath))
    || saved.receiptsHash !== sha256(readNoteFirstOutput(receiptsPath))
    || saved.outputHash !== noteFirstOutputHash(join(saved.attemptRoot, "work"))
    || saved.outcomeHash !== hashJson(saved.outcome)) throw new Error("Accepted Note-first checkpoint changed");
   request.onAttemptStarted?.(saved.attemptRoot);
   return saved.outcome as NoteFirstOutcome;
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
  await spawnPrimeWorker({ name: `Note-first ${request.input.stage}`, worker: fileURLToPath(new URL("./prime-note-first-worker.ts", import.meta.url)),
   agentRoot: work, runtimeRoot: runtime, readonlyRoots: [inputRoot], env: request.env, signal: request.signal,
   extraEnv: { NOTE_FIRST_RUNTIME: runtime, NOTE_FIRST_WORK: work, NOTE_FIRST_INPUT_ROOT: inputRoot,
    NOTE_FIRST_MODEL: request.env.TELOMI_WIKI_MAINTAINER_MODEL, NOTE_FIRST_THINKING: thinking } });
  request.signal.throwIfAborted();
  const acceptedPath = join(runtime, "accepted-result.json");
  const accepted = JSON.parse(readNoteFirstOutput(join(runtime, "accepted.json")).toString("utf8"));
  if (accepted.outputHash !== noteFirstOutputHash(work)
   || accepted.resultHash !== sha256(readNoteFirstOutput(acceptedPath))
   || accepted.receiptsHash !== sha256(readNoteFirstOutput(join(runtime, "receipts.json")))) throw new Error("Accepted Note-first artifacts changed");
  const outcome: NoteFirstOutcome = { result: JSON.parse(readNoteFirstOutput(acceptedPath).toString("utf8")),
   usage: noteFirstTraceUsage(request.workRoot), sessionPaths: sessionPaths(request.workRoot) };
  writeJsonAtomic(checkpoint, { identity, status: "succeeded", attemptRoot, ...accepted, outcomeHash: hashJson(outcome), outcome });
  return outcome;
 } catch (error) {
  const usage = noteFirstTraceUsage(request.workRoot);
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
export function noteFirstCapabilityIdentity(): string {
 const files = ["note-first-stage.ts", "prime-note-first-worker.ts", "note-first-contract.ts", "note-first-workspace.ts",
  "note-first-search.ts", "note-first-topic-skill.ts", "note-first-prompt.ts", "object-first-contract.ts", "object-first-edition.ts"];
 const semantics = files.map(path => sha256(readFileSync(fileURLToPath(new URL(path, import.meta.url)))));
 const system = renderAgentPrompt("wiki", "note-first", "system-append", {});
 return hashJson({ semantics, system: system.content, registration: system.configSha256,
  users: ["objects", "merge-objects", "plan-concepts", "concepts", "merge-concepts", "relations", "plan-topics", "topic"]
   .map(stage => renderAgentPrompt("wiki", "note-first", "user", { stage }).content),
  skills: snapshotSkills(bundledAgentSkillPaths("wiki", "note-first")).sha256 });
}
