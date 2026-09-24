import { isIP } from "node:net";

export type SelfHostedSttEndpointResolution =
	| {
			ok: true;
			baseUrl: string;
			modelsEndpoint: string;
			transcriptionEndpoint: string;
	  }
	| { ok: false; error: string };

/**
 * Resolve one user-configured OpenAI-compatible STT base URL.
 *
 * Plain HTTP is intentionally limited to loopback and private LAN targets.
 * Public servers must use HTTPS. Credentials remain in auth.json and are not
 * accepted in the URL, which keeps logs and API responses secret-free.
 */
export function resolveSelfHostedSttEndpoint(
	value: string | null | undefined,
): SelfHostedSttEndpointResolution {
	const configured = typeof value === "string" ? value.trim() : "";
	if (!configured) {
		return { ok: false, error: "self-hosted STT base URL is not configured" };
	}

	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		return { ok: false, error: "self-hosted STT base URL is invalid" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, error: "self-hosted STT endpoint must use HTTP or HTTPS" };
	}
	if (url.username || url.password) {
		return { ok: false, error: "self-hosted STT endpoint must not contain credentials" };
	}
	if (url.search || url.hash) {
		return { ok: false, error: "self-hosted STT endpoint must not contain a query or fragment" };
	}

	const hostClass = classifyHost(url.hostname);
	if (hostClass === "blocked") {
		return {
			ok: false,
			error: "self-hosted STT link-local and metadata endpoints are not allowed",
		};
	}
	if (url.protocol === "http:" && hostClass === "public") {
		return {
			ok: false,
			error: "self-hosted STT public endpoints must use HTTPS",
		};
	}

	const pathname = url.pathname.replace(/\/+$/, "");
	const transcriptionPath = /\/audio\/transcriptions$/i.test(pathname)
		? pathname
		: `${pathname}/audio/transcriptions`;
	const apiBasePath = transcriptionPath.replace(/\/audio\/transcriptions$/i, "");
	url.pathname = apiBasePath || "/";
	const baseUrl = url.toString().replace(/\/$/, "");
	url.pathname = `${apiBasePath}/models` || "/models";
	const modelsEndpoint = url.toString();
	url.pathname = transcriptionPath;
	const transcriptionEndpoint = url.toString();
	return { ok: true, baseUrl, modelsEndpoint, transcriptionEndpoint };
}

type HostClass = "private" | "public" | "blocked";

function classifyHost(rawHostname: string): HostClass {
	const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		hostname === "metadata" ||
		hostname === "metadata.google.internal" ||
		hostname.endsWith(".metadata.google.internal")
	) {
		return "blocked";
	}
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local")
	) {
		return "private";
	}
	const family = isIP(hostname);
	if (family === 4) return classifyIpv4(hostname);
	if (family === 6) return classifyIpv6(hostname);
	return "public";
}

function classifyIpv4(hostname: string): HostClass {
	const octets = hostname.split(".").map(Number);
	const [first = -1, second = -1] = octets;
	if (first === 127 || first === 10) return "private";
	if (first === 172 && second >= 16 && second <= 31) return "private";
	if (first === 192 && second === 168) return "private";
	if (
		first === 0 ||
		(first === 169 && second === 254) ||
		first >= 224
	) {
		return "blocked";
	}
	return "public";
}

function classifyIpv6(hostname: string): HostClass {
	if (hostname === "::1") return "private";
	if (/^f[cd]/i.test(hostname)) return "private";
	if (/^fe[89ab]/i.test(hostname) || hostname === "::") return "blocked";
	return "public";
}
