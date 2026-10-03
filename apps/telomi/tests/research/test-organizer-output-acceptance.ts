import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyPrimeSourceOrganizerIndex, preparePrimeSourceOrganizerIndex } from "../../server/research/pipeline/prime-source-organizer-index.js";
import { readAcceptedPrimeOrganizerIndex } from "../../server/research/pipeline/prime-search-contract.js";
import { primeKernelEnv } from "../../server/agent-runtime/prime-agent-srt.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "organizer-output-acceptance-")));
try {
	const fakePrime = join(root, "prime.mjs");
	writeFileSync(fakePrime, `
import assert from 'node:assert/strict';
import {appendFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
export {AuthStorage, ModelRegistry} from ${JSON.stringify(import.meta.resolve("prime-agent"))};
export const SettingsManager={create:()=>({applyOverrides(){},getAutoRefineSettings:()=>({enabled:false})})};
export class DefaultResourceLoader {async reload(){}}
export const SessionManager={create:()=>({})};
export async function createAgentSession(options) {
 assert.deepEqual(options.tools,['ipython']); assert.equal(options.customTools,undefined);
 const messages=[]; let turns=0;
 return {session:{messages,systemPrompt:'Organizer fixture',subscribe(){},
 async prompt(text){
  turns++; appendFileSync(join(options.cwd,'turns.jsonl'),JSON.stringify({text,turns})+'\\n');
  const scenario=process.env.ORGANIZER_FIXTURE_SCENARIO;
  if(scenario==='model-error') {
   messages.push({role:'assistant',provider:'fixture',model:'test',stopReason:'error',errorMessage:'controlled model refusal'}); return;
  }
  messages.push({role:'assistant',provider:'fixture',model:'test',stopReason:'stop',content:[{type:'text',text:'Long final reply. '.repeat(4000)}]});
  if(scenario==='success'||scenario==='repair'&&turns>1) writeFileSync(join(options.cwd,'decision.json'),JSON.stringify({groups:[],ungrouped:['S001','S002']}));
  if(scenario==='invalid') writeFileSync(join(options.cwd,'decision.json'),JSON.stringify({groups:[],ungrouped:['S001']}));
 },async waitForRlmQuiescence(){},async abort(){},async disposeAsync(){}}};
}
`);
	const credentials = join(root, "credentials"); mkdirSync(credentials);
	writeFileSync(join(credentials, "auth.json"), "{}");
	writeFileSync(join(credentials, "models.json"), JSON.stringify({ providers: { fixture: {
		api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: "fixture", models: [{ id: "test", reasoning: false }],
	} } }));
	const prepared = preparePrimeSourceOrganizerIndex(emptyPrimeSourceOrganizerIndex(), [1, 2].map(n => ({
		candidateId: `candidate:${n}`, sourceId: `source:${n}`, providerId: "github", title: `Source ${n}`,
		url: `https://example.test/${n}`, summary: "Source metadata", revisionSha256: String(n).repeat(64), snapshotPath: `snapshots/${n}`,
	})));
	for (const scenario of ["success", "repair", "invalid", "model-error"]) {
		const cwd = join(root, scenario), runtime = join(cwd, ".runtime"); mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, "index.json"), JSON.stringify({ index: prepared.index, new_source_ids: prepared.newSourceIds }));
		const inputPath = join(runtime, "sdk-input.json");
		writeFileSync(inputPath, JSON.stringify({ cwd, sessionDir: join(runtime, "session"), provider: "fixture", model: "test",
			thinking: "off", prompt: "Write decision.json and confirm briefly.", skills: [], tools: ["ipython"], organizerTools: true,
			scopedModels: [], rlmMaxDepth: 0 }));
		const run = () => execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../server/research/pipeline/prime-search-sdk-worker.ts", import.meta.url))], {
			env: { ...process.env, PRIME_SEARCH_SDK_INPUT: inputPath, PRIME_AGENT_CODING_AGENT_DIR: credentials,
				TELOMI_PRIME_CREDENTIAL_SOURCE: credentials, PRIME_AGENT_MODULE_PATH: fakePrime, ORGANIZER_FIXTURE_SCENARIO: scenario },
			encoding: "utf8", stdio: "pipe",
		});
		if (scenario === "model-error") assert.throws(run, /controlled model refusal/u);
		else {
			const stdout = run();
			if (scenario === "invalid") assert.match(stdout, /output_validation_exhausted/u);
			else {
				assert.deepEqual(readAcceptedPrimeOrganizerIndex(cwd), prepared.index, "only the frozen validated index is consumed");
				writeFileSync(join(cwd, "decision.json"), JSON.stringify({ groups: [], ungrouped: [] }));
				assert.deepEqual(readAcceptedPrimeOrganizerIndex(cwd), prepared.index, "later draft edits do not replace the accepted result");
			}
		}
		const turns = readFileSync(join(cwd, "turns.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(turns.length, scenario === "repair" ? 2 : scenario === "invalid" ? 3 : 1);
		if (scenario === "repair") assert.match(turns[1].text, /decision\.json does not exist/u);
		if (scenario === "invalid") assert.match(turns[2].text, /every newly observed Source exactly once/u);
	}
	const cwd = join(root, "success"), internal = join(cwd, ".runtime");
	const env = primeKernelEnv({ cwd, writableRoots: [cwd], privateRoots: [internal], env: process.env });
	execFileSync(env.PRIME_AGENT_KERNEL_PYTHON!, ["-c", `
from pathlib import Path
import errno
for name in ["index.json", "accepted-index.json"]:
    for mode in ["r", "w"]:
        try:
            with open(Path(".runtime") / name, mode) as handle:
                if mode == "r": handle.read()
        except OSError as error:
            assert error.errno in (errno.EPERM, errno.EACCES, errno.ENOENT, errno.EROFS)
        else:
            raise AssertionError("Kernel accessed host-owned " + name + " in mode " + mode)
Path("decision.json").write_text("{}")
`], { env, stdio: "pipe" });
	assert.deepEqual(readAcceptedPrimeOrganizerIndex(cwd), prepared.index, "native Kernel cannot alter the accepted authority");
	const ownerSource = readFileSync(fileURLToPath(new URL("../../server/research/pipeline/prime-search-batch.ts", import.meta.url)), "utf8");
	assert.match(ownerSource, /privateRoots: \[bundlesRoot, join\(root, "\.runtime"\), join\(organizerRoot, "\.runtime"\)\]/u,
		"production Organizer launch protects its internal validation input and frozen output");
	console.log("Organizer worker accepts files, repairs in one session, reports exhaustion, and preserves model failure");
} finally { rmSync(root, { recursive: true, force: true }); }
