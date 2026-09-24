#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { readPiSession, readRunRecords, runRecordDir, runRecordsDir } from "../server/observability/run-records.js";

const [command, ...args] = process.argv.slice(2);

try {
	const dataDir = resolve(required(option(args, "--config/data-dir"), "--config/data-dir"));
	const goalId = required(option(args, "--goal"), "--goal");
	if (command === "list") {
		const root = runRecordsDir(dataDir, goalId);
		const runs = existsSync(root)
			? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
			: [];
		print({ goalId, root, runs });
	} else if (command === "inspect") {
		print(readRunRecords(runRecordDir(dataDir, goalId, required(option(args, "--run"), "--run"))));
	} else if (command === "inspect-session") {
		print(readPiSession(resolve(required(option(args, "--session"), "--session"))));
	} else {
		process.stderr.write([
			"Usage:",
			"  npm run evidence -- list --config/data-dir <pi-data> --goal <goal-id>",
			"  npm run evidence -- inspect --config/data-dir <pi-data> --goal <goal-id> --run <run-id>",
			"  npm run evidence -- inspect-session --config/data-dir <pi-data> --goal <goal-id> --session <file>",
			"",
		].join("\n"));
		process.exitCode = 2;
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

function print(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
