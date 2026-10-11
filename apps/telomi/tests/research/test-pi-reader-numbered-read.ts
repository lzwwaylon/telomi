import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiReaderSandbox } from "../../server/research/pipeline/note-reader-pi.js";
import { createSrtAgentSandbox } from "../../server/agent-runtime/srt-agent-sandbox.js";
import { createReaderNumberedRead } from "../../server/research/pipeline/reader-numbered-read.js";

// ReadOperations is the cancellable I/O boundary; a stuck backend must not hold the Session open.
for (const phase of ["access", "detectImageMimeType", "readFile"] as const) {
	let enter!: () => void;
	const entered = new Promise<void>(resolve => { enter = resolve; });
	const stall = () => { enter(); return new Promise<never>(() => {}); };
	const tool = createReaderNumberedRead("/work", {
		access: async () => phase === "access" ? stall() : undefined,
		detectImageMimeType: async () => phase === "detectImageMimeType" ? stall() : null,
		readFile: async () => phase === "readFile" ? stall() : Buffer.from("line"),
	}, path => path);
	const controller = new AbortController();
	const rejected = assert.rejects(tool.execute("cancel-numbered", { path: "/work/source/paper.md" }, controller.signal,
		() => undefined, { cwd: "/work" } as Parameters<typeof tool.execute>[4]), /cancel numbered read/u);
	await entered;
	controller.abort(new Error("cancel numbered read"));
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([rejected, new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => reject(new Error(`Numbered read did not cancel stalled ${phase}`)), 1000);
		})]);
	} finally { clearTimeout(timeout); }
}

// Real SDK file tools and SRT preserve canonical evidence coordinates and native raw data.
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-reader-numbered-")));
const work = join(fixture, "work"), runtimeRoot = join(fixture, "runtime"), output = join(fixture, "tool-output");
const agentDir = join(fixture, "credentials"), hostSecret = join(fixture, "host-secret.txt");
const original = Buffer.from("\uFEFF甲😀\r\n\rbravo\nlast", "utf8");
const jsonText = '{"preserve":"JSON", "lines":[1,2]}';
const metadataText = '{\n  "metadata": {\n    "created_at": "2026-01-02T03:04:05.000Z"\n  }\n}';
const jsonlText = '{"id":1}\n{"id":2}';
const binary = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x0d, 0x0a]);
const secret = "HOST_SECRET_NOT_FOR_READER";
for (const path of [join(work, "source/S1"), join(work, "inputs"), runtimeRoot, output, agentDir]) mkdirSync(path, { recursive: true });
writeFileSync(join(work, "source/S1/paper.md"), original);
writeFileSync(join(work, "source/S1/config.json"), jsonText);
writeFileSync(join(work, "source/S1/acquisition-metadata.json"), metadataText);
writeFileSync(join(work, "source/S1/records.jsonl"), jsonlText);
writeFileSync(join(work, "source/S1/bytes.bin"), binary);
writeFileSync(join(work, "source/S1/tail.markdown"), "tail\n");
writeFileSync(join(work, "source/S1/empty.txt"), "");
writeFileSync(join(work, "source/S1/image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
writeFileSync(join(work, "scratch.md"), "scratch stays native");
writeFileSync(join(work, "inputs/context.txt"), "context stays native");
writeFileSync(join(work, "inputs/context.json"), jsonText);
writeFileSync(join(output, "spill.txt"), "spill stays native");
writeFileSync(join(work, "source/S1/many.txt"), Array.from({ length: 2003 }, (_, i) => `row-${i + 1}`).join("\n"));
writeFileSync(join(work, "source/S1/wide.txt"), Array.from({ length: 80 }, (_, i) => `${i + 1}:${"界😀".repeat(250)}`).join("\n"));
writeFileSync(join(work, "source/S1/long.txt"), `intro\n${"界".repeat(12_000)}\nTAIL_AFTER_BLOCKED_LINE`);
writeFileSync(hostSecret, secret);
symlinkSync(hostSecret, join(work, "source/S1/escape.md"));
const previous = process.env;
process.env = { ...previous, PI_CODING_AGENT_DIR: agentDir };
const sandbox = createPiReaderSandbox(work, output);
const native = createSrtAgentSandbox({ id: "reader-native-test", role: "report.note_agent", workDirectory: work, activeTools: ["read", "bash", "edit", "write"], nativeBash: true, network: "deny", readonlyMounts: ["source", "inputs"].map(name => ({ hostPath: join(work, name), guestPath: `/work/${name}`, access: "read-only" as const })) });
type Result = { content: Array<{ type: string; text?: string }>; details?: unknown; structuredContent?: unknown; isError?: boolean };
const invoke = async (owner: typeof sandbox, name: string, params: Record<string, unknown>): Promise<Result> => {
	const tool = owner.toolDefinitions.find(item => item.name === name);
	assert.ok(tool);
	return await tool.execute("numbered-fixture", params, new AbortController().signal, () => undefined,
		{ cwd: work } as Parameters<typeof tool.execute>[4]);
};
const read = (params: Record<string, unknown>) => invoke(sandbox, "read", params);
const text = (result: Result) => {
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0]!.type, "text");
	assert.equal(typeof result.content[0]!.text, "string");
	return result.content[0]!.text!;
};
const page = (result: Result, start: number, end: number, total: number, next: number | null) => {
	assert.notEqual(result.isError, true);
	assert.deepEqual(result.details, { format: "numbered", start_line: start, end_line: end, total_lines: total, next_offset: next });
	assert.ok(Buffer.byteLength(text(result), "utf8") <= 32 * 1024, "labels and footer count toward the byte budget");
	assert.ok(text(result).includes(`Showing original lines ${start}-${end} of ${total}.`));
	assert.ok(text(result).includes(`next_offset=${next}`));
	return text(result).split("\n").filter(line => /^L\d+ \| /u.test(line));
};
try {
	assert.deepEqual(page(await read({ path: "source/S1/paper.md", limit: 2 }), 1, 2, 4, 3), ["L1 | 甲😀", "L2 | "]);
	for (const path of ["@source/S1/paper.md", "/data/work/source/S1/paper.md"]) {
		assert.deepEqual(page(await read({ path, limit: 2 }), 1, 2, 4, 3), ["L1 | 甲😀", "L2 | "], "logical path aliases keep automatic numbering");
	}
	assert.deepEqual(page(await read({ path: "/work/source/S1/paper.md", offset: 2, limit: 2 }), 2, 3, 4, 4), ["L2 | ", "L3 | bravo"]);
	assert.deepEqual(page(await read({ path: "source/S1/paper.md", offset: 4 }), 4, 4, 4, null), ["L4 | last"]);
	assert.deepEqual(page(await read({ path: "source/S1/tail.markdown" }), 1, 2, 2, null), ["L1 | tail", "L2 | "]);
	assert.deepEqual(page(await read({ path: "source/S1/empty.txt" }), 1, 1, 1, null), ["L1 | "]);
	assert.deepEqual(page(await read({ path: "source/S1/config.json", format: "numbered" }), 1, 1, 1, null), [`L1 | ${jsonText}`]);
	assert.deepEqual(page(await read({ path: "source/S1/config.json" }), 1, 1, 1, null), [`L1 | ${jsonText}`]);
	assert.deepEqual(page(await read({ path: "source/S1/acquisition-metadata.json", offset: 3, limit: 1 }), 3, 3, 5, 4),
		['L3 |     "created_at": "2026-01-02T03:04:05.000Z"']);
	assert.deepEqual(page(await read({ path: "source/S1/records.jsonl" }), 1, 2, 2, null), ['L1 | {"id":1}', 'L2 | {"id":2}']);
	for (const path of ["source/S1/bytes.bin", "scratch.md", "inputs/context.txt", "inputs/context.json"]) {
		assert.deepEqual(await read({ path }), await invoke(native, "read", { path }), `auto keeps native semantics for ${path}`);
	}
	for (const path of ["source/S1/paper.md", "source/S1/bytes.bin", "source/S1/config.json", "source/S1/acquisition-metadata.json", "source/S1/records.jsonl"]) {
		assert.deepEqual(await read({ path, format: "raw" }), await invoke(native, "read", { path }), `raw is byte-for-byte native output for ${path}`);
	}
	const image = await invoke(native, "read", { path: "source/S1/image.png" });
	assert.ok(image.content.some(item => item.type === "image"), "fixture is actually handled as a native image");
	for (const format of ["auto", "numbered", "raw"]) {
		assert.deepEqual(await read({ path: "source/S1/image.png", format }), image, `${format} preserves native image handling`);
	}
	assert.deepEqual(page(await read({ path: "scratch.md", format: "numbered" }), 1, 1, 1, null), ["L1 | scratch stays native"]);
	await assert.rejects(read({ path: "source/S1/bytes.bin", format: "numbered" }), /UTF|encoded|encoding/iu);
	for (const key of ["offset", "limit"]) for (const value of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(read({ path: "source/S1/paper.md", [key]: value }), /positive|integer/iu);
	}
	await assert.rejects(read({ path: "source/S1/paper.md", offset: 5 }), /beyond|end of file/iu);
	for (const limit of [undefined, 10_000]) {
		const many = page(await read({ path: "source/S1/many.txt", ...(limit === undefined ? {} : { limit }) }), 1, 2000, 2003, 2001);
		assert.equal(many.length, 2000); assert.equal(many[0], "L1 | row-1"); assert.equal(many.at(-1), "L2000 | row-2000");
	}
	assert.deepEqual(page(await read({ path: "source/S1/many.txt", offset: 2001 }), 2001, 2003, 2003, null),
		["L2001 | row-2001", "L2002 | row-2002", "L2003 | row-2003"]);
	let offset = 1, pages = 0;
	while (offset <= 80) {
		const result = await read({ path: "source/S1/wide.txt", offset });
		const details = result.details as { end_line: number; next_offset: number | null };
		const lines = page(result, offset, details.end_line, 80, details.next_offset);
		assert.ok(lines.length > 0);
		for (const [index, line] of lines.entries()) assert.equal(line, `L${offset + index} | ${offset + index}:${"界😀".repeat(250)}`, "UTF-8 budget never splits a line or Unicode scalar");
		assert.equal(details.next_offset, details.end_line === 80 ? null : details.end_line + 1);
		offset += lines.length;
		assert.ok(++pages < 10, "pagination makes bounded progress");
	}
	assert.ok(pages > 1, "multibyte fixture exercises the byte limit rather than the line limit");
	assert.deepEqual(page(await read({ path: "source/S1/long.txt" }), 1, 1, 3, 2), ["L1 | intro"]);
	const blocked = await read({ path: "source/S1/long.txt", offset: 2 });
	assert.notEqual(blocked.isError, true, "an oversized line is a diagnostic with no falsely completed reading");
	assert.deepEqual(blocked.details, { format: "numbered", start_line: 2, end_line: null, total_lines: 3, next_offset: null, blocked_line: 2 });
	assert.match(text(blocked), /line 2.*32 KiB/u);
	assert.match(text(blocked), /No lines were displayed or skipped/u);
	assert.match(text(blocked), /bash\/Python.*bounded character ranges/u);
	assert.ok(!text(blocked).includes("TAIL_AFTER_BLOCKED_LINE"));
	assert.ok(!text(blocked).includes("next_offset=3"), "a blocked line cannot be presented as read or skipped");
	assert.deepEqual(page(await read({ path: "source/S1/long.txt", offset: 3 }), 3, 3, 3, null), ["L3 | TAIL_AFTER_BLOCKED_LINE"]);
	for (const format of ["auto", "numbered", "raw"]) {
		await assert.rejects(read({ path: hostSecret, format }), /outside|escapes|denied/u);
		await assert.rejects(read({ path: "source/S1/escape.md", format }), /outside|escapes|denied/u);
	}
	await assert.rejects(invoke(sandbox, "write", { path: "source/S1/paper.md", content: "tampered" }), /read-only/u);
	assert.deepEqual(readFileSync(join(work, "source/S1/paper.md")), original);
	assert.deepEqual(readFileSync(join(work, "source/S1/bytes.bin")), binary);

	assert.match(text(await read({ path: "/tool-output/spill.txt" })), /spill stays native/u);
	console.log("Reader numbered read: original lines, Unicode pagination, native raw/image handling, no silent long-line skip, permissions and cancellation passed");
} finally {
	process.env = previous;
	await sandbox.close(); await native.close();
	rmSync(fixture, { recursive: true, force: true });
}
