import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AUTO_UPGRADE_INTERVAL_S, jobDefinitions, parseCommand, signedByDeveloper, SNAPSHOT_TIME } from "./service.js";
import { serviceLabel, UpgradeError } from "./upgrade.js";

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
		EnvironmentVariables: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin" },
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
