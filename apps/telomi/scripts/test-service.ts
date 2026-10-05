import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AUTO_UPGRADE_INTERVAL_S, bootout, jobDefinitions, main, parseCommand, signedByDeveloper, SNAPSHOT_TIME } from "./service.js";
import { serviceLabel, UpgradeError, type Checkout } from "./upgrade.js";

function scratch(context: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "telomi-service-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("commands parse, and install defaults to the running Node without scheduled jobs", () => {
	assert.deepEqual(parseCommand(["install"], "/n/node"), { action: "install", options: { node: "/n/node", dailySnapshot: false } });
	assert.deepEqual(parseCommand(["install", "--node", "/usr/local/bin/node", "--auto-upgrade=dev", "--daily-snapshot"], "/n/node"),
		{ action: "install", options: { node: "/usr/local/bin/node", autoUpgrade: "dev", dailySnapshot: true } });
	const releases = parseCommand(["install", "--auto-upgrade"]);
	assert.equal(releases.action === "install" ? releases.options.autoUpgrade : undefined, "");
	assert.deepEqual(parseCommand(["status"]), { action: "status" });
	for (const argv of [[], ["status", "extra"], ["install", "--force"], ["install", "--node"], ["reload"]]) {
		assert.throws(() => parseCommand(argv), UpgradeError);
	}
});

test("jobs run Node directly, are named after the checkout, and schedule upgrades and snapshots", (context) => {
	const root = scratch(context);
	const other = join(root, "other");
	mkdirSync(other);
	const env = { HOME: "/Users/me", PATH: ["/opt/homebrew/bin", join(root, "node_modules/.bin"), "/usr/bin"].join(":") };
	const [server, upgrade, snapshot] = jobDefinitions({ repoRoot: root }, { node: "/usr/local/bin/node", autoUpgrade: "dev", dailySnapshot: true }, env);
	const base = serviceLabel(root);
	assert.notEqual(base, serviceLabel(other));
	assert.deepEqual(server, {
		Label: `${base}.server`,
		EnvironmentVariables: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin", TELOMI_OUTPUT_LOG: `/Users/me/Library/Logs/Telomi/${base}.server.log` },
		StandardOutPath: `/Users/me/Library/Logs/Telomi/${base}.server.log`,
		StandardErrorPath: `/Users/me/Library/Logs/Telomi/${base}.server.log`,
		ProgramArguments: ["/usr/local/bin/node", "--import", "tsx", "server/index.ts"],
		WorkingDirectory: join(root, "apps/telomi"),
		RunAtLoad: true,
		KeepAlive: true,
	});
	assert.deepEqual(upgrade!.ProgramArguments, ["/usr/local/bin/node", "--import", "tsx", join(root, "apps/telomi/scripts/upgrade.ts"), "--if-idle", "--ref", "dev", "--require-checks"]);
	assert.equal(upgrade!.StartInterval, AUTO_UPGRADE_INTERVAL_S);
	assert.deepEqual((snapshot!.ProgramArguments as string[]).slice(-2), ["--snapshot-only", "--if-idle"]);
	assert.deepEqual(snapshot!.StartCalendarInterval, SNAPSHOT_TIME);

	// Following Releases needs no check gate; without the options only the server is installed.
	const [, release] = jobDefinitions({ repoRoot: root }, { node: "/n/node", autoUpgrade: "", dailySnapshot: false }, env);
	assert.deepEqual((release!.ProgramArguments as string[]).slice(4), ["--if-idle"]);
	assert.equal(jobDefinitions({ repoRoot: root }, { node: "/n/node", dailySnapshot: false }, env).length, 1);
});

test("only a Developer ID signature keeps a stable identity for privacy grants", () => {
	assert.equal(signedByDeveloper("Signature size=9044\nAuthority=Developer ID Application: Node.js Foundation (HX7739G8FX)\nTeamIdentifier=HX7739G8FX\n"), true);
	assert.equal(signedByDeveloper("CodeDirectory v=20400 flags=0x2(adhoc)\nSignature=adhoc\nTeamIdentifier=not set\n"), false);
	assert.equal(signedByDeveloper("/opt/x/node: code object is not signed at all\n"), false);
});

test("bootout waits until launchd no longer lists the job, and gives up on one that never exits", (context) => {
	const root = mkdtempSync(join(tmpdir(), "telomi-bootout-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const calls = join(root, "calls.log");
	writeFileSync(join(root, "launchctl"), `#!/bin/sh
echo "$@" >> "${calls}"
[ "$1" = print ] || exit 0
[ "$(grep -c '^print' "${calls}")" -le "$(cat "${join(root, "listed")}")" ]
`, { mode: 0o755 });
	const path = process.env.PATH;
	process.env.PATH = `${root}:${path}`;
	context.after(() => { process.env.PATH = path; });
	writeFileSync(join(root, "listed"), "3");
	bootout("com.telomi.test.server");
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n").map((line) => line.split(" ")[0]), ["bootout", "print", "print", "print", "print"]);
	writeFileSync(calls, "");
	writeFileSync(join(root, "listed"), "1000000");
	assert.throws(() => bootout("com.telomi.test.server", 500), (error) => error instanceof UpgradeError && /still running/u.test(error.message));
});


test("service stop delegates owned Runtime cleanup and rejects cleanup failure", async (context) => {
	const root = scratch(context);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const calls = join(root, "calls.log");
	const result = join(root, "result");
	writeFileSync(join(bin, "python3"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nexit "$(cat "${result}")"\n`, { mode: 0o755 });
	const inst: Checkout = { repoRoot: root, dataDir: join(root, "data"), baseUrl: "http://127.0.0.1:1", env: { PATH: `${bin}:${process.env.PATH}` } };
	writeFileSync(result, "0");
	assert.equal(await main(["stop"], inst), 0);
	assert.equal(readFileSync(calls, "utf8").trim(), "apps/telomi/scripts/worktree.py stop");
	writeFileSync(result, "7");
	await assert.rejects(main(["stop"], inst), (error) => error instanceof UpgradeError && /exit 7/u.test(error.message));
});

test("restart stops the server and owned Runtime before bootstrap without changing scheduled jobs", async (context) => {
	const root = scratch(context);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const calls = join(root, "calls.log");
	const live = join(root, "live");
	const result = join(root, "result");
	writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$1" in print) [ -e "${live}" ];; bootout) rm -f "${live}";; *) exit 0;; esac\n`, { mode: 0o755 });
	writeFileSync(join(bin, "python3"), `#!/bin/sh\necho runtime-stop >> "${calls}"\nexit "$(cat "${result}")"\n`, { mode: 0o755 });
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath}`;
	context.after(() => { process.env.PATH = originalPath; });
	const inst: Checkout = { repoRoot: root, dataDir: join(root, "data"), baseUrl: "http://127.0.0.1:1", env: { PATH: process.env.PATH } };
	writeFileSync(result, "0"); writeFileSync(live, "1");
	assert.equal(await main(["restart"], inst), 0);
	const rows = readFileSync(calls, "utf8").trim().split("\n");
	assert.ok(rows.findIndex((line) => line.startsWith("bootout")) < rows.indexOf("runtime-stop"));
	assert.ok(rows.indexOf("runtime-stop") < rows.findIndex((line) => line.startsWith("bootstrap")));
	assert.ok(rows.every((line) => !line.includes(".snapshot") && !line.includes(".auto-upgrade")));
	writeFileSync(calls, ""); writeFileSync(result, "7"); writeFileSync(live, "1");
	await assert.rejects(main(["restart"], inst), /exit 7/u);
	assert.equal(readFileSync(calls, "utf8").includes("bootstrap"), false);
});
