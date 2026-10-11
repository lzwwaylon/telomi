import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { constants, createWriteStream } from "node:fs";
import { link, open, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { isRecord, toErrorMessage } from "../../lib/values.js";

/** Publish SDK spill files without granting the Reader access to the host temp directory. */
export function readerOutputFiles(directory: string): ExtensionFactory {
	return pi => {
		pi.on("tool_result", async event => {
			if (event.toolName !== "bash") return;
			if (!isRecord(event.details) || typeof event.details.fullOutputPath !== "string") return;
			const source = event.details.fullOutputPath;
			const staging = join(dirname(directory), `.reader-output-${randomUUID()}.tmp`);
			try {
				const name = basename(source);
				const expectedName = /^pi-bash-[a-f0-9]+\.log$/u;
				if (!expectedName.test(name)
					|| await realpath(dirname(source)) !== await realpath(tmpdir())) {
					throw new Error("Native output file is outside the SDK output location");
				}
				const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					const stat = await file.stat();
					if (!stat.isFile() || stat.nlink !== 1) throw new Error("Native output must be a private regular file");
					await pipeline(file.createReadStream({ autoClose: false }), createWriteStream(staging, { flags: "wx", mode: 0o600 }));
				} finally { await file.close(); }
				await link(staging, join(directory, name));
				const published = `/tool-output/${name}`;
				return {
					content: event.content.map(item => item.type === "text" ? { ...item, text: item.text.replaceAll(source, published) } : item),
					details: { ...event.details, fullOutputPath: published },
				};
			} catch (error) {
				// Pi reports thrown hook errors but otherwise returns the original successful result.
				return { content: [{ type: "text", text: `Could not publish native tool output: ${toErrorMessage(error)}` }], details: {}, isError: true };
			} finally { await unlink(staging).catch(() => {}); }
		});
	};
}
