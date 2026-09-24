import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function requireAudioFixture(path: string): Promise<void> {
	try {
		await access(path, constants.R_OK);
	} catch (error) {
		const generated = resolve(import.meta.dirname, "../../voice-evals/generated/v1");
		const fromGenerated = relative(generated, resolve(path));
		if ((error as NodeJS.ErrnoException).code === "ENOENT"
			&& fromGenerated && !isAbsolute(fromGenerated) && fromGenerated !== ".." && !fromGenerated.startsWith(`..${sep}`)) {
			throw new Error(`Missing generated audio fixture: ${path}. From apps/telomi, run npm run generate:voice-vad-fixtures -- --fetch-remote-fixtures to download and generate the standard fixtures, or provide an existing fixture where supported. No audio was downloaded.`, { cause: error });
		}
		throw error;
	}
}
