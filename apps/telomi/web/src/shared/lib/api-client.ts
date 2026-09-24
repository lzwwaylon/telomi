import { apiUrl } from "./api.js";

export class ApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly data: unknown,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ApiError";
	}
}

type ApiOptions = Omit<RequestInit, "method" | "body"> & {
	/** Override HTTP diagnostics for endpoints whose UI includes the raw error body. */
	errorMessage?: (status: number, body: string) => string;
	fallbackMessage?: string | ((status: number) => string);
	fetcher?: typeof fetch;
};

/** Preserve native response bodies and errors for streaming, binary, and custom response handling. */
function requestResponse(
	input: RequestInfo | URL,
	options: RequestInit & { fetcher?: typeof fetch } = {},
): Promise<Response> {
	const { fetcher = fetch, ...init } = options;
	return fetcher(input, init);
}

async function request<T>(method: string, path: string, body: unknown, options: ApiOptions = {}): Promise<T> {
	const { fallbackMessage, errorMessage, fetcher, ...init } = options;
	let status = 0;
	try {
		const headers = new Headers(init.headers);
		const rawBody = body instanceof Blob;
		if (body !== undefined && !rawBody && !headers.has("Content-Type")) {
			headers.set("Content-Type", "application/json");
		}
		const response = await requestResponse(apiUrl(path), {
			fetcher,
			...init,
			method,
			headers,
			body: body === undefined ? undefined : rawBody ? body : JSON.stringify(body),
		});
		status = response.status;
		const text = await response.text();
		let data: unknown;
		try {
			data = text ? JSON.parse(text) : undefined;
		} catch (cause) {
			if (response.ok) throw new ApiError("Invalid JSON response", status, text, { cause });
		}
		if (!response.ok) {
			const message = errorMessage ? errorMessage(status, text) : data && typeof data === "object" && "error" in data
				&& typeof data.error === "string" && data.error.trim()
				? data.error.trim()
				: (typeof fallbackMessage === "function" ? fallbackMessage(status) : fallbackMessage) || `HTTP ${status}`;
			throw new ApiError(message, status, data);
		}
		return data as T;
	} catch (cause) {
		if (cause instanceof ApiError || (cause instanceof DOMException && cause.name === "AbortError")) throw cause;
		throw new ApiError(cause instanceof Error ? cause.message : String(cause), status, undefined, { cause });
	}
}

export const apiClient = {
	response: requestResponse,
	get: <T = unknown>(path: string, options?: ApiOptions) => request<T>("GET", path, undefined, options),
	post: <T = unknown>(path: string, body?: unknown, options?: ApiOptions) => request<T>("POST", path, body, options),
	put: <T = unknown>(path: string, body?: unknown, options?: ApiOptions) => request<T>("PUT", path, body, options),
	patch: <T = unknown>(path: string, body?: unknown, options?: ApiOptions) => request<T>("PATCH", path, body, options),
	delete: <T = unknown>(path: string, options?: ApiOptions) => request<T>("DELETE", path, undefined, options),
};
