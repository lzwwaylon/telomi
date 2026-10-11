import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { createReaderNumberedRead } from "../../server/research/pipeline/reader-numbered-read.js";

const workspace = mkdtempSync(join(tmpdir(), "reader-python-read-"));
const modulePath = fileURLToPath(new URL("../../server/research/pipeline/reader_read.py", import.meta.url));
interface Request { path: string; offset?: number; limit?: number; format?: "auto" | "numbered" | "raw" }
type Result = { ok: true; text: string } | { ok: false; error: string };
const python = (requests: Request[]): Result[] => JSON.parse(execFileSync("python3", ["-I", "-B", "-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("reader_read", sys.argv[1])
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
results = []
for request in json.loads(sys.argv[2]):
    try:
        results.append({"ok": True, "text": reader.read(**request)})
    except Exception as error:
        results.append({"ok": False, "error": str(error)})
print(json.dumps(results, ensure_ascii=False))
`, modulePath, JSON.stringify(requests)], { cwd: workspace, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10_000 }));

try {
	mkdirSync(join(workspace, "source/members/provider/item"), { recursive: true });
	const files = { "paper.md": "\uFEFF甲😀\r\n\rbravo\nlast", "empty.txt": "", "tail.markdown": "tail\n",
		"many.txt": "x\n".repeat(2005), "wide.txt": Array.from({ length: 100 }, () => "界😀".repeat(250)).join("\n"),
		"long.txt": `intro\n${"界".repeat(12_000)}\ntail`, "config.json": '{"keep":"JSON"}' };
	for (const [name, content] of Object.entries(files)) writeFileSync(join(workspace, "source", name), content);
	writeFileSync(join(workspace, "plain.txt"), "workspace content");
	writeFileSync(join(workspace, "source/plain.txt"), "Source content");
	writeFileSync(join(workspace, "source/members/provider/item/paper.md"), "First line.\nSupported detail.\n");
	writeFileSync(join(workspace, "source/source-manifest.json"), JSON.stringify({ content_files: [
		{ path: "members/provider/item/paper.md" }, { path: "plain.txt" }, { path: "../outside.md" },
	] }));
	const host = (path: string) => join(workspace, path.replace(/^\/work\//u, ""));
	const numbered = createReaderNumberedRead("/work", {
		access: async path => accessSync(host(path)), readFile: async path => readFileSync(host(path)),
	}, path => path.startsWith("/") ? path : `/work/${path}`);
	const requests: Request[] = [
		...Object.keys(files).map(name => ({ path: `source/${name}` })),
		{ path: "source/paper.md", offset: 2, limit: 2 }, { path: "source/long.txt", offset: 2 },
		{ path: "source/long.txt", offset: 3 }, { path: "source/many.txt", offset: 2001 },
		{ path: "source/many.txt", limit: 9999 }, { path: "source/paper.md", format: "raw" },
		{ path: "source/config.json", format: "numbered" }, { path: "plain.txt" },
		{ path: "source/paper.md", offset: 0 }, { path: "source/paper.md", limit: 0 },
		{ path: "source/paper.md", offset: 99 }, { path: "source/paper.md", offset: 1.5 },
	];
	const results = python(requests);
	for (const [index, request] of requests.entries()) {
		const actual = results[index]!;
		if (!actual.ok) {
			await assert.rejects(numbered.execute("invalid", request, new AbortController().signal, () => undefined,
				{ cwd: "/work" } as Parameters<typeof numbered.execute>[4]), { message: actual.error });
			continue;
		}
		const result = await numbered.execute("parity", request, new AbortController().signal, () => undefined,
			{ cwd: "/work" } as Parameters<typeof numbered.execute>[4]);
		assert.deepEqual(result.content, [{ type: "text", text: actual.text }], JSON.stringify(request));
		assert.ok(Buffer.byteLength(actual.text) < 65_536, "one passage and its footer fit below IPython's output cap");
	}
	const aliases = python([{ path: "members/provider/item/paper.md", offset: 2, limit: 1 },
		{ path: "source/members/provider/item/paper.md", offset: 2, limit: 1 }, { path: "plain.txt" },
		{ path: "undeclared.md" }, { path: "../outside.md" }]);
	assert.deepEqual(aliases[0], aliases[1]);
	assert.ok(aliases[0]!.ok && aliases[0].text.startsWith("L2 | Supported detail."));
	assert.deepEqual(aliases[2], { ok: true, text: "workspace content" }, "existing workspace paths retain precedence");
	assert.ok(!aliases[3]!.ok && !aliases[4]!.ok, "only safe declared Source paths gain aliases");
	const raw = createReadTool(workspace, { autoResizeImages: false });
	const rawResult = await raw.execute("native", { path: "plain.txt" });
	assert.deepEqual(rawResult.content, [{ type: "text", text: "workspace content" }]);
	for (const [name, content] of Object.entries(files)) assert.equal(readFileSync(join(workspace, "source", name), "utf8"), content);
	writeFileSync(join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
	writeFileSync(join(workspace, "invalid.txt"), Buffer.from([0xc3, 0x28]));
	assert.ok(python([{ path: "binary.bin" }, { path: "invalid.txt" }]).every(result => !result.ok), "unsupported binary and UTF-8 inputs fail explicitly");
	console.log(`Python Source Reader: ${requests.length} Pi parity cases, exact paths, continuation, budget and original bytes passed`);
} finally { rmSync(workspace, { recursive: true, force: true }); }
