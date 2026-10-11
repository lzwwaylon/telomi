import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prime from "prime-agent";
import type { Model } from "@earendil-works/pi-ai";
import { primeKernelEnv } from "../../server/agent-runtime/prime-agent-srt.js";
import { buildNoteAgentSystemPrompt, renderPrimeNoteAgentUserPrompt } from "../../server/research/pipeline/note-agent-prompt.js";

// Exercise the advertised workspace in the real native Session/IPython/SRT, without a model call.
const fixture = realpathSync(mkdtempSync(join(process.env.TELOMI_TEST_WORKSPACE_PARENT ?? tmpdir(), "prime-source-workspace-")));
const previousEnv = process.env;
let session: prime.AgentSession | undefined;
try {
	const root = join(fixture, "agent"), runtime = join(fixture, "runtime");
	for (const path of [join(root, "source/members/provider/item"), join(root, "inputs/reader-tools"), runtime]) mkdirSync(path, { recursive: true });
	writeFileSync(join(root, "inputs/context.md"), "Question-scoped reading priorities.");
	const paths = ["paper.md", "members/provider/item/paper.md"];
	for (const path of paths) writeFileSync(join(root, "source", path), "Original evidence.\nExact supported detail.\n");
	writeFileSync(join(root, "source/source-manifest.json"), JSON.stringify({ content_files: paths.map(path => ({ path })) }));
	writeFileSync(join(root, "inputs/reader-tools/reader_read.py"), readFileSync(new URL("../../server/research/pipeline/reader_read.py", import.meta.url), "utf8"));
	writeFileSync(join(runtime, "private.txt"), "host-only runtime data");
	process.env = primeKernelEnv({ cwd: root, readonlyRoots: [join(root, "source"), join(root, "inputs")],
		writableRoots: [root], privateRoots: [runtime], env: previousEnv });
	const model: Model<"openai-responses"> = { id: "fixture", name: "Fixture", api: "openai-responses", provider: "openai",
		baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const authStorage = prime.AuthStorage.inMemory({}, { usePrimeCliConfig: false });
	const settingsManager = prime.SettingsManager.inMemory({ autoRefine: { enabled: false }, retry: { enabled: false } });
	const scope = `${buildNoteAgentSystemPrompt()}\n${renderPrimeNoteAgentUserPrompt("Read the supplied Source.")}`;
	const loader = new prime.DefaultResourceLoader({ cwd: root, agentDir: runtime, settingsManager,
		noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, appendSystemPrompt: [scope] });
	await loader.reload();
	({ session } = await prime.createAgentSession({ cwd: root, agentDir: runtime, authStorage,
		modelRegistry: prime.ModelRegistry.inMemory(authStorage), model, settingsManager, resourceLoader: loader,
		sessionManager: prime.SessionManager.create(root, join(runtime, "sessions")), tools: ["ipython"],
		includeGoals: false, includeCompactSkill: false, prewarmIpythonKernel: false, rlmMaxDepth: 0,
		telemetryDisabled: true, autonomous: { enabled: false } }));
	assert.match(scope, /current workspace/u, "Source Reader writes in its actual current workspace");
	const execute = async (code: string) => {
		const result = await session!.agent.state.tools.find(tool => tool.name === "ipython")!.execute("workspace", { code });
		assert.equal(result.details.status, "ok", JSON.stringify(result));
		return result;
	};
	await execute(`from pathlib import Path
import json, os, sys
os.chdir('.')
assert str(Path.cwd()) == ${JSON.stringify(root)}
assert Path('inputs/context.md').read_text() == 'Question-scoped reading priorities.'
sys.path.insert(0, 'inputs/reader-tools')
from reader_read import read
manifest = json.loads(Path('source/source-manifest.json').read_text())
for relative in manifest['content_files']:
    relative = relative['path']
    source_path = Path('source') / relative
    assert source_path.read_text().startswith('Original evidence.')
    assert read(str(source_path), offset=2, limit=1).startswith('L2 | Exact supported detail.')
    assert read(relative, offset=2, limit=1).startswith('L2 | Exact supported detail.')
data = {'sections': [], 'tested_paths': [item['path'] for item in manifest['content_files']]}
Path('note.json.tmp').write_text(json.dumps(data))
Path('note.json.tmp').replace('note.json')
print('advertised workspace, manifest paths and atomic output work')`);
	await execute(`import errno
assert callable(read) and data['tested_paths'] == [item['path'] for item in manifest['content_files']]
for filename in ['source/paper.md', 'inputs/context.md']:
    try:
        Path(filename).write_text('tampered')
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES, errno.EROFS)
    else:
        raise AssertionError('read-only input was writable')
try:
    Path(${JSON.stringify(join(runtime, "private.txt"))}).read_text()
except OSError as error:
    assert error.errno in (errno.EPERM, errno.EACCES, errno.ENOENT)
else:
    raise AssertionError('host-only runtime was readable')`);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "note.json"), "utf8")), { sections: [], tested_paths: paths });
	assert.equal(readFileSync(join(root, "source/paper.md"), "utf8"), "Original evidence.\nExact supported detail.\n");
	console.log("Prime Source Reader: advertised workspace, Source-relative manifest paths, numbered reads, atomic output, persistent state and SRT boundaries passed");
} finally {
	try { await session?.disposeAsync(); }
	finally { process.env = previousEnv; rmSync(fixture, { recursive: true, force: true }); }
}
