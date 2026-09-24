import { useCallback, useEffect, useState } from "react";

export type Route =
	| "home"
	| "goal"
	| "artifact"
	| "chat"
	| "wiki"
	| "settings";

const ROUTE_STORAGE_KEY = "mom:route";
const VALID_ROUTES: ReadonlySet<Route> = new Set([
	"home",
	"goal",
	"artifact",
	"chat",
	"wiki",
	"settings",
]);
const GOAL_PATH_PREFIX = "/goal/";
const CHAT_PATH_PREFIX = "/chat/";
const WIKI_PATH_PREFIX = "/wiki/";
const ARTIFACT_PATH_PREFIX = "/read/";

// Static deep-link path → route. `/` and `""` map to "home" explicitly so that
// reload at root never falls through to localStorage. Anything not in this map AND not under
// CHAT_PATH_PREFIX falls back to localStorage.
const PATH_ROUTES: Record<string, Route> = {
	"/": "home",
	"": "home",
	"/settings": "settings",
};

const readRoute = (fallback: Route): Route => {
	if (typeof window === "undefined") return fallback;
	const pathname = window.location?.pathname;
	if (typeof pathname === "string") {
		if (pathname.startsWith(GOAL_PATH_PREFIX)) return "goal";
		if (pathname.startsWith(CHAT_PATH_PREFIX)) return "chat";
		if (pathname.startsWith(WIKI_PATH_PREFIX)) return "wiki";
		if (pathname.startsWith(ARTIFACT_PATH_PREFIX)) return "artifact";
		const direct = PATH_ROUTES[pathname];
		if (direct) return direct;
	}
	try {
		const raw = window.localStorage.getItem(ROUTE_STORAGE_KEY);
		return VALID_ROUTES.has(raw as Route) ? (raw as Route) : fallback;
	} catch {
		return fallback;
	}
};

const readGoalIdFromPrefix = (prefix: string): string | null => {
	if (typeof window === "undefined") return null;
	const path = window.location?.pathname;
	if (typeof path !== "string" || !path.startsWith(prefix)) return null;
	const raw = path.slice(prefix.length).split("/")[0] ?? "";
	if (!raw) return null;
	try {
		return decodeURIComponent(raw) || null;
	} catch {
		return raw || null;
	}
};

export const readChatGoalId = (): string | null => readGoalIdFromPrefix(CHAT_PATH_PREFIX);
export const readWikiGoalId = (): string | null => readGoalIdFromPrefix(WIKI_PATH_PREFIX);
export const readGoalPageGoalId = (): string | null => readGoalIdFromPrefix(GOAL_PATH_PREFIX);

export interface ArtifactRouteState {
	goalId: string;
	filename: string;
}

export const readArtifactRoute = (): ArtifactRouteState | null => {
	if (typeof window === "undefined") return null;
	const path = window.location?.pathname;
	if (typeof path !== "string" || !path.startsWith(ARTIFACT_PATH_PREFIX)) return null;
	const tail = path.slice(ARTIFACT_PATH_PREFIX.length);
	const [rawGoalId = "", ...rawFileParts] = tail.split("/");
	if (!rawGoalId || rawFileParts.length === 0) return null;
	try {
		const goalId = decodeURIComponent(rawGoalId);
		const filename = rawFileParts.map((part) => decodeURIComponent(part)).join("/");
		return goalId && filename ? { goalId, filename } : null;
	} catch {
		const filename = rawFileParts.join("/");
		return rawGoalId && filename ? { goalId: rawGoalId, filename } : null;
	}
};

export const readInitialGoalId = (): string | null =>
	readArtifactRoute()?.goalId ?? readWikiGoalId() ?? readChatGoalId() ?? readGoalPageGoalId();

export const readActiveTopicId = (): string | null => {
	if (typeof window === "undefined") return null;
	return new URLSearchParams(window.location.search).get("topic")?.trim() || null;
};

export const readWikiPagePath = (): string | null => {
	if (typeof window === "undefined") return null;
	return new URLSearchParams(window.location.search).get("page")?.trim() || null;
};

export const readTopicPlanRevision = (): string | null => {
	if (typeof window === "undefined") return null;
	return new URLSearchParams(window.location.search).get("revision")?.trim() || null;
};

const writeRoute = (next: Route): void => {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(ROUTE_STORAGE_KEY, next);
	} catch {
		/* ignore */
	}
};

const syncBodyDataset = (next: Route): void => {
	if (typeof document === "undefined") return;
	try {
		document.body.dataset.route = next;
	} catch {
		/* ignore */
	}
};

export function useRoute(initial?: Route): [Route, (next: Route) => void] {
	const fallback: Route = initial ?? "home";
	const [route, setRouteState] = useState<Route>(() => readRoute(fallback));

	useEffect(() => {
		syncBodyDataset(route);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const setRoute = useCallback((next: Route) => {
		setRouteState(next);
		writeRoute(next);
		syncBodyDataset(next);
	}, []);

	return [route, setRoute];
}

// Inverse of PATH_ROUTES - maps route to its canonical pathname for URL sync.
const ROUTE_PATHS: Partial<Record<Route, string>> = {
	settings: "/settings",
};

/**
 * Mirror the active route onto `window.location.pathname` via `replaceState`.
 *
 * - `route === "chat"` and `goalId` truthy → `/chat/<encoded-goalId>`
 * - `route === "goal"` and `goalId` truthy → `/goal/<encoded-goalId>`
 * - `route === "settings"` → `/settings`
 * - any other route (including `home`) → `/`
 *
 * URL stores the stable goalId (not title) so reload can recover `selected`.
 */
function artifactPath(goalId: string, filename: string): string {
	const encodedFile = filename
		.split("/")
		.filter(Boolean)
		.map((part) => encodeURIComponent(part))
		.join("/");
	return `${ARTIFACT_PATH_PREFIX}${encodeURIComponent(goalId)}/${encodedFile}`;
}

export function useUrlSync(
	route: Route,
	goalId: string | null | undefined,
	artifactFilename?: string | null,
	topicId?: string | null,
	topicRevision?: string | null,
	wikiPage?: string | null,
): void {
	useEffect(() => {
		if (typeof window === "undefined" || !window.history?.replaceState) return;
		let desired: string;
		if (route === "artifact" && goalId && artifactFilename) {
			desired = artifactPath(goalId, artifactFilename);
		} else if (route === "wiki" && goalId) {
			desired = `${WIKI_PATH_PREFIX}${encodeURIComponent(goalId)}`;
		} else if (route === "chat" && goalId) {
			desired = `${CHAT_PATH_PREFIX}${encodeURIComponent(goalId)}`;
		} else if (route === "goal" && goalId) {
			desired = `${GOAL_PATH_PREFIX}${encodeURIComponent(goalId)}`;
		} else if (ROUTE_PATHS[route]) {
			desired = ROUTE_PATHS[route] as string;
		} else {
			desired = "/";
		}
		if (route === "goal" || route === "chat" || route === "wiki") {
			const params = new URLSearchParams();
			if (topicId) params.set("topic", topicId);
			if (topicRevision) params.set("revision", topicRevision);
			if (route === "wiki" && wikiPage) params.set("page", wikiPage);
			if (params.size) desired += `?${params}`;
		} else if (route === "settings") {
			// The settings page owns `?section=`; stripping it would break its deep links on reload.
			desired += window.location.search || "";
		}
		const current = `${window.location.pathname || "/"}${window.location.search || ""}`;
		if (current === desired) return;
		try {
			// Evidence anchors (#evidence-N) belong to one Wiki page; drop them when the page changes.
			const hash = route === "wiki" ? "" : window.location.hash || "";
			window.history.replaceState(null, "", `${desired}${hash}`);
		} catch {
			/* ignore */
		}
	}, [route, goalId, artifactFilename, topicId, topicRevision, wikiPage]);
}
