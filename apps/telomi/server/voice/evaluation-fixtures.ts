import { sha256 } from "../lib/hash.js";
import {
	existsSync,
	readFileSync,
	statSync,
	} from "node:fs";
import { resolve } from "node:path";
import { assertInsideRoot } from "../lib/paths.js";
import type { VoiceEvaluationCase } from "./evaluation.js";
import { writeFileAtomic } from "../lib/fs.js";

const DEFAULT_MAX_FIXTURE_BYTES = 64 * 1024 * 1024;

export interface VoiceEvaluationFixtureLoaderOptions {
	repositoryRoot: string;
	cacheRoot: string;
	fetch?: typeof fetch;
	maxFixtureBytes?: number;
}

export class VoiceEvaluationFixtureLoader {
	private readonly repositoryRoot: string;
	private readonly cacheRoot: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxFixtureBytes: number;

	constructor(options: VoiceEvaluationFixtureLoaderOptions) {
		this.repositoryRoot = resolve(options.repositoryRoot);
		this.cacheRoot = resolve(options.cacheRoot);
		this.fetchImpl = options.fetch ?? fetch;
		this.maxFixtureBytes =
			options.maxFixtureBytes ?? DEFAULT_MAX_FIXTURE_BYTES;
		if (
			!Number.isInteger(this.maxFixtureBytes) ||
			this.maxFixtureBytes < 1 ||
			this.maxFixtureBytes > 1024 * 1024 * 1024
		) {
			throw new Error("maxFixtureBytes must be an integer from 1 byte to 1 GiB");
		}
	}

	async load(
		evaluationCase: VoiceEvaluationCase,
		options: { allowRemote: boolean },
	): Promise<Buffer> {
		const repositoryPath = resolve(
			this.repositoryRoot,
			evaluationCase.audio.path,
		);
		assertInsideRoot(
			this.repositoryRoot,
			repositoryPath,
			`${evaluationCase.id}: audio path`,
		);
		if (existsSync(repositoryPath)) {
			return this.readAndVerify(repositoryPath, evaluationCase, "repository");
		}

		const cachePath = resolve(
			this.cacheRoot,
			`${evaluationCase.audio.sha256}.${extensionForMime(evaluationCase.audio.mime)}`,
		);
		assertInsideRoot(this.cacheRoot, cachePath, `${evaluationCase.id}: cache path`);
		if (existsSync(cachePath)) {
			return this.readAndVerify(cachePath, evaluationCase, "cache");
		}

		if (!evaluationCase.audio.downloadUrl) {
			throw new Error(
				`${evaluationCase.id}: audio fixture is missing at ${repositoryPath}`,
			);
		}
		if (!options.allowRemote) {
			throw new Error(
				`${evaluationCase.id}: audio fixture is not cached and remote fetching is disabled`,
			);
		}

		const response = await this.fetchImpl(evaluationCase.audio.downloadUrl, {
			redirect: "follow",
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(
				`${evaluationCase.id}: fixture download failed with HTTP ${response.status}`,
			);
		}
		if (response.url && new URL(response.url).protocol !== "https:") {
			throw new Error(
				`${evaluationCase.id}: fixture download redirected outside HTTPS`,
			);
		}
		const declaredLength = response.headers.get("content-length");
		if (
			declaredLength &&
			Number(declaredLength) > this.maxFixtureBytes
		) {
			throw new Error(
				`${evaluationCase.id}: remote fixture exceeds ${this.maxFixtureBytes} bytes`,
			);
		}
		const audio = await readBoundedResponse(
			response,
			this.maxFixtureBytes,
			evaluationCase.id,
		);
		verifyDigest(audio, evaluationCase, "download");
		try {
			writeFileAtomic(cachePath, audio);
		} catch (error) {
			if (!existsSync(cachePath)) throw error;
		}
		return audio;
	}

	private readAndVerify(
		path: string,
		evaluationCase: VoiceEvaluationCase,
		source: "repository" | "cache",
	): Buffer {
		const size = statSync(path).size;
		if (size > this.maxFixtureBytes) {
			throw new Error(
				`${evaluationCase.id}: ${source} fixture exceeds ${this.maxFixtureBytes} bytes`,
			);
		}
		const audio = readFileSync(path);
		verifyDigest(audio, evaluationCase, source);
		return audio;
	}
}

async function readBoundedResponse(
	response: Response,
	maxBytes: number,
	caseId: string,
): Promise<Buffer> {
	if (!response.body) {
		throw new Error(`${caseId}: fixture download returned an empty body`);
	}
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			const chunk = Buffer.from(item.value);
			totalBytes += chunk.length;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new Error(
					`${caseId}: remote fixture exceeds ${maxBytes} bytes`,
				);
			}
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, totalBytes);
}

function verifyDigest(
	audio: Buffer,
	evaluationCase: VoiceEvaluationCase,
	source: string,
): void {
	const digest = sha256(audio);
	if (digest !== evaluationCase.audio.sha256) {
		throw new Error(
			`${evaluationCase.id}: ${source} fixture SHA-256 mismatch, expected ${evaluationCase.audio.sha256}, received ${digest}`,
		);
	}
}

function extensionForMime(mime: string): string {
	const lower = mime.toLocaleLowerCase();
	if (lower.includes("wav")) return "wav";
	if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
	if (lower.includes("flac")) return "flac";
	if (lower.includes("ogg")) return "ogg";
	if (lower.includes("webm")) return "webm";
	if (lower.includes("mp4") || lower.includes("m4a")) return "m4a";
	return "bin";
}
