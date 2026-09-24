import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { listJsonDir, readJson, writeJsonAtomic } from "./fs.js";
import { assertFileNameSegment } from "./paths.js";
import { toErrorMessage } from "./values.js";

/** JSON documents keyed by filename stem. Missing documents return undefined. */
export class JsonDocumentStore<T> {
	constructor(
		private readonly directory: string,
		/** Validate a document and its filename stem, or throw an error identifying the invalid field. */
		private readonly validator?: (value: unknown, id: string) => T,
	) {}

	get(id: string): T | undefined {
		const path = this.path(id);
		if (!existsSync(path)) return undefined;
		return this.validate(readJson<T>(path), path);
	}

	private validate(value: T, path: string): T {
		if (!this.validator) return value;
		try {
			return this.validator(value, basename(path, ".json"));
		} catch (error) {
			throw new Error(`Invalid JSON document ${path}: ${toErrorMessage(error)}`, { cause: error });
		}
	}

	put(id: string, value: T): void {
		writeJsonAtomic(this.path(id), value, { mode: 0o600 });
	}

	/** Sorted by filename; unreadable documents are skipped only without a validator. */
	list(): T[] {
		return listJsonDir<T>(this.directory, { strict: Boolean(this.validator) })
			.map(({ value, path }) => this.validate(value, path));
	}

	delete(id: string): void {
		rmSync(this.path(id), { force: true });
	}

	private path(id: string): string {
		return join(this.directory, `${assertFileNameSegment(id, "JSON document id")}.json`);
	}
}
