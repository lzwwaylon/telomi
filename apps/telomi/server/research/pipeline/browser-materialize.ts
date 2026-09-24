import { sha256 } from "../../lib/hash.js";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

import {
	captureBrowserPage,
	downloadBrowserAttachment,
	executeBrowserTool,
	type BrowserToolClientConfig,
} from "../../providers/browser/tool-router.js";
import { convertLocalDocument, type ConvertedLocalDocument, type LocalDocumentConverters } from "../documents/local-document.js";


/**
 * Retain Browser evidence as converted local material. Reached from the Prime kernel through the
 * per-run Source bridge (`research_runtime.materialize_source`), never as a native Tool: the
 * Prime Agent works through ipython, and the Runtime keeps ownership of capture and conversion.
 */
export interface BrowserMaterializeConfig {
	artifactRoot: string;
	scopeRoot?: string;
	maxBytes?: number;
	converters?: LocalDocumentConverters;
}

export type BrowserMaterializeSource =
	| { kind: "current_page" }
	| { kind: "element"; ref: string }
	| { kind: "url"; url: string };

const DEFAULT_MAX_MATERIAL_BYTES = 50 * 1024 * 1024;
// Browser material kept the per-attempt parse budget and single retry of the file ingestion it used to pass through.
const CONVERSION_TIMEOUT_MS = 90_000;
const CONVERSION_ATTEMPTS = 2;
const ALLOWED_EXTENSIONS = new Set([
	".html", ".htm", ".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md", ".json", ".csv", ".tsv",
	".mp3", ".wav", ".m4a", ".webm", ".ogg", ".flac", ".aiff", ".aif",
]);

/** Validates the SDK's `source` argument; the shapes mirror the former Tool parameters. */
export function parseMaterializeSource(value: unknown): BrowserMaterializeSource {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("materialize source must be an object");
	const source = value as Record<string, unknown>;
	if (source.kind === "current_page") return { kind: "current_page" };
	if (source.kind === "element") {
		if (typeof source.ref !== "string" || !/^@e[1-9][0-9]*$/u.test(source.ref)) throw new Error("element source needs a ref like @e12");
		return { kind: "element", ref: source.ref };
	}
	if (source.kind === "url") {
		if (typeof source.url !== "string" || !source.url || source.url.length > 4_096) throw new Error("url source needs a non-empty url");
		return { kind: "url", url: source.url };
	}
	throw new Error("materialize source kind must be current_page, element, or url");
}

export async function materializeBrowserSource(
	config: BrowserToolClientConfig,
	materialize: BrowserMaterializeConfig,
	agentSessionId: string,
	params: {
		source: { kind: "current_page" } | { kind: "element"; ref: string } | { kind: "url"; url: string };
		title?: string;
	},
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const root = realpathSync(materialize.artifactRoot);
	const relativeDirectory = `work/materials/browser/material-${randomUUID()}`;
	const directory = join(root, relativeDirectory);
	const rawDirectory = join(directory, "raw");
	mkdirSync(rawDirectory, { recursive: true });
	const maxBytes = materialize.maxBytes ?? DEFAULT_MAX_MATERIAL_BYTES;
	let sourceUrl = "";
	let title = params.title?.trim() ?? "";
	let contentType: string | undefined;
	let captureKind: "rendered_dom" | "browser_download" | "http_get";
	let rawPath: string;
	try {
		if (params.source.kind === "current_page") {
			sourceUrl = await browserText(config, agentSessionId, ["get", "url"], signal);
			title ||= await browserText(config, agentSessionId, ["get", "title"], signal);
			rawPath = join(rawDirectory, "page.html");
			await captureBrowserPage(
				config,
				agentSessionId,
				relative(realpathSync(materialize.scopeRoot ?? root), rawPath).split(sep).join("/"),
				signal,
			);
			contentType = "text/html";
			captureKind = "rendered_dom";
		} else if (params.source.kind === "element") {
			const pageUrl = await browserText(config, agentSessionId, ["get", "url"], signal);
			const href = await browserText(config, agentSessionId, ["get", "attr", params.source.ref, "href"], signal);
			sourceUrl = new URL(href, pageUrl).toString();
			title ||= await browserText(config, agentSessionId, ["get", "text", params.source.ref], signal);
			rawPath = join(rawDirectory, filenameForUrl(sourceUrl));
			await downloadBrowserAttachment(
				config,
				agentSessionId,
				params.source.ref,
				relative(realpathSync(materialize.scopeRoot ?? root), rawPath).split(sep).join("/"),
				signal,
			);
			captureKind = "browser_download";
		} else {
			const url = httpUrl(params.source.url);
			const fetched = await fetchMaterial(url, rawDirectory, maxBytes, signal);
			sourceUrl = fetched.url;
			rawPath = fetched.path;
			contentType = fetched.contentType;
			title ||= basename(rawPath);
			captureKind = "http_get";
		}

		validateMaterialFile(rawPath, maxBytes);
		// Browser material is candidate evidence of this Provider execution, not a user document, so it is
		// converted in place and never reaches Goal file ingestion, its Activity or the Main Agent's /documents.
		const converted = await convertMaterial(rawPath, title, materialize.converters, signal);
		writeFileSync(join(directory, "document.md"), `${converted.markdown.trim()}\n`);
		writeFileSync(join(directory, "document.canonical.json"), `${JSON.stringify(converted.parsed.document)}\n`);
		const parser = converted.parsed.manifest.parser;
		const bytes = statSync(rawPath).size;
		const digest = sha256(readFileSync(rawPath));
		writeFileSync(join(directory, "provenance.json"), `${JSON.stringify({
			schema_version: 1,
			source_url: sourceUrl,
			title,
			capture_kind: captureKind,
			content_type: contentType ?? null,
			byte_length: bytes,
			sha256: digest,
			parser,
			captured_at: new Date().toISOString(),
		}, null, 2)}\n`);
		return {
			status: "ready",
			source_url: sourceUrl,
			title,
			capture_kind: captureKind,
			media_type: contentType ?? null,
			byte_length: bytes,
			sha256: digest,
			parser,
			material_path: relativeDirectory,
			markdown_path: `${relativeDirectory}/document.md`,
			canonical_path: `${relativeDirectory}/document.canonical.json`,
		};
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

async function convertMaterial(
	rawPath: string,
	title: string,
	converters: LocalDocumentConverters | undefined,
	signal?: AbortSignal,
): Promise<ConvertedLocalDocument> {
	for (let attempt = 1; ; attempt += 1) {
		const timeout = AbortSignal.timeout(CONVERSION_TIMEOUT_MS);
		try {
			return await convertLocalDocument({
				inputPath: rawPath,
				sourceName: basename(rawPath),
				...(title ? { title } : {}),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			}, converters);
		} catch (error) {
			if (attempt >= CONVERSION_ATTEMPTS || signal?.aborted) throw error;
		}
	}
}

async function browserText(
	config: BrowserToolClientConfig,
	agentSessionId: string,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	const result = await executeBrowserTool(config, agentSessionId, args, signal);
	if (result.exitCode !== 0 || result.truncated || !result.output.trim()) {
		throw new Error(`Browser command '${args.join(" ")}' did not return a complete value`);
	}
	return result.output.trim();
}

async function fetchMaterial(
	url: URL,
	directory: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<{ url: string; path: string; contentType?: string }> {
	const response = await fetch(url, { method: "GET", redirect: "follow", ...(signal ? { signal } : {}) });
	if (!response.ok) throw new Error(`Material download failed with HTTP ${response.status}`);
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > maxBytes) throw new Error(`Material download exceeds the ${maxBytes} byte limit`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new Error(`Material download exceeds the ${maxBytes} byte limit`);
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	const path = join(directory, filenameForUrl(response.url, contentType));
	writeFileSync(path, bytes, { flag: "wx" });
	return { url: response.url, path, ...(contentType ? { contentType } : {}) };
}

function validateMaterialFile(path: string, maxBytes: number): void {
	const stat = statSync(path);
	if (!stat.isFile() || stat.size < 1) throw new Error("Material download did not produce a file");
	if (stat.size > maxBytes) throw new Error(`Material exceeds the ${maxBytes} byte limit`);
	const extension = extname(path).toLowerCase();
	if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`Material type '${extension || "unknown"}' is not supported`);
	const header = readFileSync(path).subarray(0, 4);
	if (header.subarray(0, 2).toString("ascii") === "MZ"
		|| header.toString("hex") === "7f454c46"
		|| ["feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(header.toString("hex"))) {
		throw new Error("Executable downloads are not supported");
	}
}

function filenameForUrl(rawUrl: string, contentType?: string): string {
	const url = httpUrl(rawUrl);
	const raw = basename(decodeURIComponent(url.pathname)) || "material";
	let filename = raw.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 120) || "material";
	const inferredExtension = extensionForContentType(contentType);
	if (!extname(filename) || (!ALLOWED_EXTENSIONS.has(extname(filename).toLowerCase()) && inferredExtension !== ".bin")) {
		filename += inferredExtension;
	}
	return filename;
}

function extensionForContentType(contentType?: string): string {
	if (contentType === "text/html") return ".html";
	if (contentType === "application/pdf") return ".pdf";
	if (contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return ".docx";
	if (contentType?.startsWith("audio/")) return `.${contentType.slice("audio/".length).replace("mpeg", "mp3")}`;
	if (contentType === "application/json") return ".json";
	if (contentType?.startsWith("text/")) return ".txt";
	return ".bin";
}

function httpUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Material URL must use HTTP(S)");
	return url;
}
