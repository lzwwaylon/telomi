/** Scripted session for testing the production Wiki Worker's file acceptance. No model or Provider calls. */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WikiStageInput } from "../../../server/wiki/wiki-stage-contract.js";
import * as prime from "prime-agent";
export * from "prime-agent";

export async function createAgentSession(options: NonNullable<Parameters<typeof prime.createAgentSession>[0]>) {
 const runtime = process.env.WIKI_STAGE_RUNTIME!, work = options.cwd!;
 const input = JSON.parse(readFileSync(join(runtime, "input.json"), "utf8")) as WikiStageInput;
 const scenario = input.instructions;
 const messages: Array<Record<string, unknown>> = [];
 const tools = options.customTools ?? [];
 let turns = 0;
 return { session: {
  messages, systemPrompt: "Scripted acceptance fixture", thinkingLevel: options.thinkingLevel,
  getAllTools: () => tools,
  getActiveToolNames: () => options.tools,
  subscribe: () => () => {},
  async prompt(text: string, promptOptions?: unknown) {
   turns++;
   appendFileSync(join(runtime, "fixture-prompts.jsonl"), `${JSON.stringify({ text, promptOptions })}\n`);
   if (scenario === "provider-error") {
    messages.push({ role: "assistant", stopReason: "error", errorMessage: "controlled provider failure",
     provider: options.model!.provider, model: options.model!.id });
    return;
   }
   messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Files written." }] });
   if (scenario === "missing-result" && turns === 1) return;
   if (scenario === "always-invalid" || (scenario === "invalid-result" && turns === 1)) {
    writeFileSync(join(work, "result.json"), "{}");
    return;
   }
   if (input.stage === "topic") {
    const dataset = JSON.parse(readFileSync(join(process.env.WIKI_STAGE_INPUT_ROOT!, "skills/wiki/dataset.json"), "utf8"));
    messages.push({ role: "toolResult", toolName: "ipython", toolCallId: `printed-section-${turns}`,
     isError: scenario === "topic-read-repair" && turns === 1,
     content: [{ type: "text", text: dataset.reads.S1 }] });
    // Deliberately emit no subscription event. Runtime must also inspect persisted Session results.
    writeFileSync(join(work, "result.json"), JSON.stringify({ topic_ref: "T1",
     matches: [{ section_ref: "S1", reason: "Complete section read." }], gaps: [] }));
    return;
   }
   if (input.entries.length > 0) {
    const read = tools.find(tool => tool.name === "read_wiki")!;
    await read.execute(`read-entry-${turns}`, { ref: "N1" }, new AbortController().signal, undefined, undefined);
    writeFileSync(join(work, "result.json"), JSON.stringify({ pages: [{ file: "pages/O1.md" }], deferred_entries: [] }));
    if (scenario === "missing-page" && turns === 1) return;
    mkdirSync(join(work, "pages"), { recursive: true });
    writeFileSync(join(work, "pages/O1.md"), '---\ntitle: "Fixture object"\ndescription: "Acceptance contract fixture"\n---\n\n## Mechanism\nSupported fixture statement [[N1]].\n');
   } else writeFileSync(join(work, "result.json"), JSON.stringify({ pages: [], deferred_entries: [] }));
  },
  async waitForRlmQuiescence() { appendFileSync(join(runtime, "fixture-quiescence.jsonl"), "{}\n"); },
  async abort() {},
  async disposeAsync() {
   writeFileSync(join(runtime, "sessions/fixture.jsonl"), messages.map(message => JSON.stringify({ type: "message", message })).join("\n"));
   if (scenario === "receipt-error") {
    rmSync(join(runtime, "receipts.json"));
    mkdirSync(join(runtime, "receipts.json"));
   }
   if (scenario === "tamper-after-acceptance") writeFileSync(join(work, "result.json"), "{}");
  },
 } };
}
