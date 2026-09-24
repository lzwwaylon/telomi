import { sha256 } from "../../lib/hash.js";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { ResearchNodeError } from "../../agent-runtime/retry-policy.js";
import { getResearchSourceServiceManager } from "../../providers/source-service-client.js";
import {
	canonicalDocumentSha256,
	parseCanonicalDocument,
	type CanonicalDocument,
} from "./canonical-document.js";
import { isInsideRoot } from "../../lib/paths.js";
import { toErrorMessage } from "../../lib/values.js";

export interface FastApiDocumentParseRequest {
	inputPath: string;
	inputRoot: string;
	contentType?: string;
	sourceName?: string;
	title?: string;
	pageRange?: readonly [number, number];
	assetOutputDir?: string;
	signal: AbortSignal;
}

export interface FastApiDocumentAsset {
	node_id: string;
	relative_path: string;
	markdown_path: string;
	sha256: string;
	byte_length: number;
	media_type: string;
	page: number;
	figure_index: number;
}

export interface FastApiDocumentParseResult {
	schema_version: 2;
	document: CanonicalDocument;
	manifest: {
		schema_version: 2;
		document_id: string;
		content_sha256: string;
		document_sha256: string;
		parser: string;
		content_type?: string | null;
		source_name: string;
		title?: string | null;
		parse_metadata: Record<string, unknown>;
		assets?: FastApiDocumentAsset[];
	};
}

export interface FastApiDocumentParser {
	parse(request: FastApiDocumentParseRequest): Promise<FastApiDocumentParseResult>;
}

export class HttpFastApiDocumentParser implements FastApiDocumentParser {
	async parse(request: FastApiDocumentParseRequest): Promise<FastApiDocumentParseResult> {
		const service = await getResearchSourceServiceManager().ensureReady();
		let response: Response;
		try {
			response = await fetch(`${service.baseUrl}/v1/documents/parse`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					authorization: `Bearer ${service.token}`,
				},
				body: JSON.stringify({
					schema_version: 1,
					input_path: request.inputPath,
					input_root: request.inputRoot,
					...(request.contentType ? { content_type: request.contentType } : {}),
					...(request.sourceName ? { source_name: request.sourceName } : {}),
					...(request.title ? { title: request.title } : {}),
					...(request.pageRange ? { page_range: request.pageRange } : {}),
					...(request.assetOutputDir ? { asset_output_dir: request.assetOutputDir } : {}),
				}),
				signal: request.signal,
			});
		} catch (error) {
			if (request.signal.aborted) {
				throw new ResearchNodeError("FastAPI document parse cancelled", "cancelled", false, { cause: asError(error) });
			}
			throw new ResearchNodeError(
				`FastAPI document parser request failed: ${toErrorMessage(error)}`,
				"provider",
				true,
				{ cause: asError(error) },
			);
		}
		if (!response.ok) {
			let message = `FastAPI document parser returned HTTP ${response.status}`;
			try {
				const payload = await response.json() as { error?: { message?: unknown } };
				if (typeof payload.error?.message === "string") message = payload.error.message;
			} catch {
				// Keep the bounded status diagnostic.
			}
			throw new ResearchNodeError(message, response.status === 422 ? "validation" : "provider", response.status >= 500);
		}
		const payload = await response.json() as FastApiDocumentParseResult & { schema_version?: unknown };
		if (payload.schema_version !== 2
			|| !payload.manifest
			|| payload.manifest.schema_version !== 2) {
			throw new ResearchNodeError("FastAPI document parser returned an invalid response", "validation", false);
		}
		let document: CanonicalDocument;
		try {
			document = parseCanonicalDocument(payload.document);
		} catch (error) {
			throw new ResearchNodeError(
				`FastAPI document parser returned an invalid canonical document: ${toErrorMessage(error)}`,
				"validation",
				false,
			);
		}
		const actualDocumentHash = canonicalDocumentSha256(document);
		if (actualDocumentHash !== payload.manifest.document_sha256) {
			throw new ResearchNodeError("FastAPI document parser canonical document hash mismatch", "validation", false);
		}
		validateAssets(payload.manifest.assets, request.inputRoot);
		return { ...payload, document };
	}
}

function validateAssets(value: unknown, inputRoot: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) throw new ResearchNodeError("FastAPI document assets are invalid", "validation", false);
	const root = realpathSync(inputRoot);
	for (const [index, rawAsset] of value.entries()) {
		const asset = rawAsset as Partial<FastApiDocumentAsset> | null;
		if (!asset || typeof asset.relative_path !== "string" || isAbsolute(asset.relative_path)
			|| typeof asset.markdown_path !== "string" || asset.markdown_path.split("/").some((part) => !part || part === "." || part === "..")
			|| typeof asset.node_id !== "string" || !asset.node_id.startsWith("node:figure:")
			|| typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256)
			|| typeof asset.byte_length !== "number" || !Number.isInteger(asset.byte_length) || asset.byte_length < 1
			|| asset.media_type !== "image/png") {
			throw new ResearchNodeError(`FastAPI document asset ${index} is invalid`, "validation", false);
		}
		const target = resolve(root, asset.relative_path);
		if (!existsSync(target)) throw new ResearchNodeError(`FastAPI document asset ${index} is missing`, "validation", false);
		const safe = realpathSync(target);
		const stat = lstatSync(target);
		if (safe === root || !isInsideRoot(root, safe) || !stat.isFile() || stat.isSymbolicLink()) {
			throw new ResearchNodeError(`FastAPI document asset ${index} escapes its input root`, "validation", false);
		}
		const content = readFileSync(safe);
		if (content.byteLength !== asset.byte_length || sha256(content) !== asset.sha256) {
			throw new ResearchNodeError(`FastAPI document asset ${index} hash mismatch`, "validation", false);
		}
	}
}

function asError(error: unknown): Error | undefined {
	return error instanceof Error ? error : undefined;
}
