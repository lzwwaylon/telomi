import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// These suites require explicit opt-in through their separate npm scripts.
const EXTERNAL_TESTS = [
	"tests/**/*-live.{ts,tsx}",
	"tests/providers/**/*-e2e.{ts,tsx}",
	"tests/agent-runtime/test-sandbox-crossvolume.ts",
	"tests/research/test-research-model-gateway.ts",
];

export function discoverTests(patterns = ["tests/**/test-*.{ts,tsx}", "scripts/test-*.ts"]): string[] {
	const files = globSync(patterns, { exclude: EXTERNAL_TESTS }).sort();
	if (files.length === 0) throw new Error(`No deterministic tests matched: ${patterns.join(", ")}`);
	return files;
}

/**
 * CI splits one file list across jobs with `--shard index/count`. Membership follows the sorted
 * position, so a file's shard changes only when the discovered list changes, and the shards of a
 * count partition the list exactly.
 */
export function selectShard(files: string[], shard: string): string[] {
	const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(shard);
	const index = Number(match?.[1]);
	const count = Number(match?.[2]);
	if (!match || index > count) throw new Error("--shard must be index/count with 1 <= index <= count");
	const selected = files.filter((_, position) => position % count === index - 1);
	if (selected.length === 0) throw new Error(`Shard ${shard} selects none of the ${files.length} matched tests`);
	return selected;
}

function main(argv: string[]): number {
	const concurrency = process.env.TELOMI_TEST_CONCURRENCY ?? "4";
	if (!/^[1-9]\d*$/u.test(concurrency) || !Number.isSafeInteger(Number(concurrency))) {
		throw new Error("TELOMI_TEST_CONCURRENCY must be a positive safe integer");
	}
	const shardAt = argv.indexOf("--shard");
	const shard = shardAt >= 0 ? argv[shardAt + 1] ?? "" : undefined;
	const patterns = shardAt >= 0 ? argv.filter((_, position) => position !== shardAt && position !== shardAt + 1) : argv;
	const matched = discoverTests(patterns.length ? patterns : undefined);
	const files = shard === undefined ? matched : selectShard(matched, shard);
	// Deterministic checks inherit OS/tooling settings, never product credentials,
	// service addresses or runtime overrides from a managed worktree/Agent shell.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
		/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_.*|TZ|SystemRoot|SYSTEMROOT|ComSpec|COMSPEC|PATHEXT|WINDIR|CI|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|NODE_V8_COVERAGE|TELOMI_TEST_.*|TELOMI_WORKTREE_CHECK_LOCK)$/u.test(key)));
	const data = mkdtempSync(join(tmpdir(), "telomi-deterministic-tests-"));
	env.TELOMI_DATA_DIR = data;
	env.TELOMI_TEST_RUN_DATA = data;
	try {
		// File isolation supports both top-level assertion scripts and node:test suites.
		// UI assertions require the existing Chinese locale setup and component CSS imports.
		for (const ui of [false, true]) {
			const group = files.filter((file) => (file.endsWith(".tsx") || /^tests\/(web|voice)\//u.test(file)) === ui);
			if (!group.length) continue;
			const result = spawnSync(process.execPath, [
				"--import", import.meta.resolve("tsx"),
				"--import", import.meta.url,
				...(ui
					? ["tests/web/setup-css-imports.ts", "tests/web/setup-ui-locale.ts"]
						.flatMap((setup) => ["--import", pathToFileURL(resolve(setup)).href])
					: []),
				"--test", `--test-concurrency=${concurrency}`, ...group,
			], { stdio: "inherit", env });
			if (result.error) throw result.error;
			if (result.status !== 0) return result.status ?? 1;
		}
		return 0;
	} finally {
		rmSync(data, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = main(process.argv.slice(2));
} else if (process.env.NODE_TEST_CONTEXT === "child-v8" && process.env.TELOMI_TEST_RUN_DATA
	&& process.env.TELOMI_DATA_DIR === process.env.TELOMI_TEST_RUN_DATA) {
	// Node preloads this module in each test-file process. Forked children already
	// have a private directory and must keep their parent's data and database.
	const data = mkdtempSync(join(process.env.TELOMI_TEST_RUN_DATA, "file-"));
	process.env.TELOMI_DATA_DIR = data;
	process.env.TELOMI_CACHE_DIR = join(data, "cache");
	process.env.SOURCE_SERVICE_ARXIV_SQLITE_PATH = join(data, "arxiv-runtime.sqlite3");
	const listener = createServer();
	await new Promise<void>((ready, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", ready);
	});
	const address = listener.address();
	// ponytail: a released port can be claimed externally; socket handoff would remove that race.
	await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
	if (!address || typeof address === "string") throw new Error("Unable to allocate the test Source Service port");
	process.env.TELOMI_RESEARCH_SOURCE_PORT = String(address.port);
}
