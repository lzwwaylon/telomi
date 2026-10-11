import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePolicy } from "../runtime.js";

test("virtual and relative shared objects never make the working directory a read-only library", t => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "srt-shared-objects-")));
	const work = join(root, "work"), libraries = join(root, "libraries"), outside = join(root, "outside");
	for (const path of [work, libraries, outside]) mkdirSync(path);
	const library = join(libraries, "libfixture.so.1");
	writeFileSync(library, "fixture library");
	const previousCwd = process.cwd();
	t.mock.method(process.report, "getReport", () => ({ sharedObjects: ["linux-vdso.so.1", "relative.so", "../outside/relative.so.2", library] }));
	try {
		process.chdir(work);
		const filesystem = { allowRead: [work], allowWrite: [work], denyRead: [], denyWrite: [] as string[] };
		const network = { allowedDomains: [], deniedDomains: [], strictAllowlist: true as const };
		const policy = validatePolicy({ filesystem, network });
		assert.ok(policy.filesystem.allowWrite.includes(work));
		assert.ok(!policy.filesystem.denyWrite.includes(work), "a virtual .so name must not resolve dirname('.') to the Agent workspace");
		assert.ok(!policy.filesystem.allowRead.includes(outside), "relative library names cannot grant neighboring directories");
		assert.ok(policy.filesystem.allowRead.includes(libraries), "real absolute shared-library directories stay readable");
		assert.ok(policy.filesystem.denyWrite.includes(libraries), "real shared libraries stay read-only");
		assert.ok(policy.filesystem.denyRead.includes("/"), "default read denial remains intact");
		assert.ok(validatePolicy({ filesystem: { ...filesystem, denyWrite: [work] }, network }).filesystem.denyWrite.includes(work),
			"explicit caller write denial must never be discarded");
	} finally { process.chdir(previousCwd); rmSync(root, { recursive: true, force: true }); }
});
