import { Router } from "express";
import { NetworkEgressManager, NetworkRequestError } from "./manager.js";
import { isAllowedBrowserOrigin } from "../config/network.js";

export function createNetworkEgressRouter(manager: NetworkEgressManager, port?: number): Router {
	const router = Router();
	router.get("/api/network/egress", (_request, response) => response.json(manager.snapshot()));
	for (const [method, path, operation] of [
		["put", "/api/network/egress", (body: unknown) => manager.configure(body)],
		["post", "/api/network/egress/refresh", () => manager.refresh()],
		["post", "/api/network/egress/login", () => manager.login()],
	] as const) router[method](path, async (request, response) => {
		if (request.get("sec-fetch-site") === "cross-site" || !isAllowedBrowserOrigin(request.get("origin"), port ?? request.socket.localPort ?? 8787)) {
			response.status(403).json({ errorCode: "request_not_allowed" });
			return;
		}
		try { response.json(await operation(request.body)); }
		catch (error) {
			const errorCode = error instanceof NetworkRequestError ? error.code : "apply_failed";
			response.status(errorCode === "invalid_configuration" ? 400 : 503).json({ errorCode });
		}
	});
	return router;
}
