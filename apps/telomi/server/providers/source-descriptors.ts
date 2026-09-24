/**
 * The external sources Telomi integrates, one entry each. A descriptor is the only registration a
 * source has on the Node side: the settings page, the status check, the credential catalog, the
 * research registry and the Prime Search Python SDK staging all derive from this list.
 *
 * Adding a source: one file under `./sources/` listed here, one Python Source module in the Source
 * Service (discovered from its `SPECS`), one `tools/<name>.py` SDK module, one worker Skill directory,
 * and the two locale strings `settings.source.name.<id>`. The Source Service's own id list is checked
 * against this one at verification time.
 */
import type { SourceAuth } from "../../shared/sources.js";
import type { ResearchSourceCatalogEntry } from "./search-types.js";
import type { SearchCredentialField } from "./search-credential-catalog.js";
import { arxiv } from "./sources/arxiv.js";
import { browser } from "./sources/browser.js";
import { exa, firecrawl, tavily } from "./sources/general-web.js";
import { github } from "./sources/github.js";
import { huggingface } from "./sources/huggingface.js";
import { twitter } from "./sources/twitter.js";
import { userDocuments } from "./sources/user-documents.js";
import { youtube } from "./sources/youtube.js";

export type SourceVerify =
	/** Ask the Python Source Service to probe the source with the credential in use. */
	| "source_service"
	/** Run one account-scoped yt-dlp call with the browser-derived cookie file. */
	| "youtube"
	/** Whether the browser can be used: a managed host can be started (it runs on demand), a remote one must answer. */
	| "browser"
	/** Local or public with no credential; nothing to verify. */
	| "none";

/** How the research registry builds the Provider behind a source. */
export type SourceProviderRuntime =
	/** Searches through the Python Source Service under the built-in rate policy. */
	| { kind: "source_service"; minIntervalMs: number; maxConcurrency?: number }
	/** The Node-owned yt-dlp Provider. */
	| { kind: "youtube" }
	/** Executes only through the Runtime-owned browser Tool; the registry entry never searches. */
	| { kind: "browser" };

export interface SourceProviderDefinition {
	/** The research registry id. General web backends use `general_web_<backend>`. */
	id: string;
	runtime: SourceProviderRuntime;
	catalog: ResearchSourceCatalogEntry;
}

export interface SourceDescriptor {
	id: string;
	auth: SourceAuth;
	verify: SourceVerify;
	provider: SourceProviderDefinition;
	/** Credential fields the unified entry point manages. Absent when nothing is managed there. */
	fields?: readonly SearchCredentialField[];
	/**
	 * Where the user logs in inside Telomi's own browser, and the cookie that shows they did. Set for
	 * a source whose session cannot be copied from the user's browser: Google binds a session to a
	 * token it rotates from the page, so a copy and the original invalidate each other.
	 */
	login?: { url: string; cookie: { domain: string; name: string } };
}

export const SOURCE_DESCRIPTORS: readonly SourceDescriptor[] = [
	browser,
	twitter,
	youtube,
	github,
	huggingface,
	firecrawl,
	tavily,
	exa,
	arxiv,
	userDocuments,
];

export function sourceDescriptor(id: string): SourceDescriptor | undefined {
	return SOURCE_DESCRIPTORS.find((source) => source.id === id);
}
