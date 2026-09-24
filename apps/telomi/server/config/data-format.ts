// The data directory's identity and format version, checked before anything opens it.
//
// `format.json` at the root of the data directory records one integer version for the whole
// directory. Startup refuses a missing directory (an unmounted volume must not silently become
// a fresh installation), refuses data newer than this code understands (older code must never
// write newer data), and otherwise brings the directory up to CURRENT_FORMAT_VERSION through
// MIGRATIONS in order. Per-store `schemaVersion` fields stay with their stores.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDataDir } from "./data-dir.js";

export const DATA_FORMAT_FILE = "format.json";

export interface DataFormat {
	formatVersion: number;
	installationId: string;
}

export interface DataMigration {
	/** Short, stable name shown in startup logs. */
	name: string;
	/** Moves the data directory from version `index + 1` to `index + 2`. Must be safe to re-run after a crash. */
	run(dataDir: string): void | Promise<void>;
}

/** Forward-only. Append a step to raise CURRENT_FORMAT_VERSION; never edit or reorder published steps. */
export const MIGRATIONS: readonly DataMigration[] = [];

export const CURRENT_FORMAT_VERSION = 1 + MIGRATIONS.length;

export class DataDirectoryError extends Error {}

/** The recorded format, or undefined for a directory that has never been marked. Throws on an unreadable marker. */
export function readDataFormat(dataDir: string): DataFormat | undefined {
	const path = join(dataDir, DATA_FORMAT_FILE);
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new DataDirectoryError(`${path} is not valid JSON (${(error as Error).message}); fix or restore it before starting Telomi.`);
	}
	const { formatVersion, installationId } = (parsed ?? {}) as Partial<DataFormat>;
	if (!Number.isSafeInteger(formatVersion) || formatVersion! < 1 || typeof installationId !== "string" || !installationId) {
		throw new DataDirectoryError(`${path} must contain a positive integer formatVersion and an installationId; fix or restore it before starting Telomi.`);
	}
	return { formatVersion: formatVersion!, installationId };
}

function writeDataFormat(dataDir: string, format: DataFormat): void {
	const path = join(dataDir, DATA_FORMAT_FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(format, null, "\t")}\n`);
	renameSync(temporary, path);
}

/**
 * Makes `dataDir` safe to open with this code, or throws DataDirectoryError without writing anything.
 * The checkout's default directory is created on first start; any other configured directory must
 * already exist, so a path on an unmounted volume is never recreated on the system disk.
 */
export async function prepareDataDirectory(
	dataDir: string,
	options: { defaultDir?: string; migrations?: readonly DataMigration[]; log?: (message: string) => void } = {},
): Promise<DataFormat> {
	const migrations = options.migrations ?? MIGRATIONS;
	const currentVersion = 1 + migrations.length;
	const log = options.log ?? ((message) => console.log(`[telomi] ${message}`));
	const defaultDir = options.defaultDir ?? resolveDataDir({});
	if (!existsSync(dataDir)) {
		if (resolve(dataDir) !== resolve(defaultDir)) {
			throw new DataDirectoryError(
				`Data directory ${dataDir} does not exist. If it is on an external volume, mount it and start again. `
				+ `To start a new installation there, create the empty directory first (mkdir -p "${dataDir}").`,
			);
		}
		mkdirSync(dataDir, { recursive: true });
	}

	let format = readDataFormat(dataDir);
	if (!format) {
		const adopted = readdirSync(dataDir).length > 0;
		format = { formatVersion: 1, installationId: randomUUID() };
		writeDataFormat(dataDir, format);
		log(adopted
			? `data directory ${dataDir} predates format versioning; adopted as format version 1`
			: `initialized data directory ${dataDir} at format version 1`);
	}

	if (format.formatVersion > currentVersion) {
		throw new DataDirectoryError(
			`Data directory ${dataDir} is at format version ${format.formatVersion}, but this version of Telomi `
			+ `supports up to ${currentVersion}. It was written by a newer Telomi; run that version, `
			+ `or restore the backup taken before the upgrade together with its matching code.`,
		);
	}

	const { installationId } = format;
	for (let version = format.formatVersion; version < currentVersion; version++) {
		const migration = migrations[version - 1]!;
		log(`migrating data directory to format version ${version + 1}: ${migration.name}`);
		await migration.run(dataDir);
		writeDataFormat(dataDir, { formatVersion: version + 1, installationId });
	}
	return { formatVersion: currentVersion, installationId };
}
