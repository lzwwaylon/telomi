import type { Express, Request, Response } from "express";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { accountManagerEvents, accountManagerFor, loadedAccountSnapshots, type ProviderAccountManager } from "./manager.js";
import { CODEX_PROVIDER_KEY, readCredentialFromAuthJson } from "./store.js";
import type { AccountCredential, ProviderAccountsState } from "./types.js";
import { codexUsageMonitor } from "./codex/usage-monitor.js";
import { toErrorMessage } from "../lib/values.js";

function parseCredentialFromBody(body: unknown): { ok: true; credential: AccountCredential } | { ok: false; error: string } {
	if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
	const b = body as Record<string, unknown>;

	// Convenience: accept apiKey / oauth tokens via shorthand.
	if (typeof b.apiKey === "string" && b.apiKey.trim()) {
		return { ok: true, credential: { type: "api_key", key: b.apiKey.trim() } };
	}

	if (typeof b.access === "string" && b.access.trim()) {
		const cred: AccountCredential = {
			type: "oauth",
			access: b.access.trim(),
		};
		if (typeof b.refresh === "string" && b.refresh.trim()) cred.refresh = b.refresh.trim();
		if (typeof b.expires === "number") cred.expires = b.expires;
		if (typeof b.accountId === "string" && b.accountId.trim()) cred.accountId = b.accountId.trim();
		return { ok: true, credential: cred };
	}

	// Full passthrough: the user pasted the entire auth.json provider entry.
	if (b.credential && typeof b.credential === "object") {
		const c = b.credential as Record<string, unknown>;
		if (c.type === "api_key" && typeof c.key === "string" && c.key.trim()) {
			return { ok: true, credential: { type: "api_key", key: c.key.trim() } };
		}
		if (c.type === "oauth" && typeof c.access === "string" && c.access.trim()) {
			return { ok: true, credential: { ...c, type: "oauth" } as AccountCredential };
		}
	}

	return { ok: false, error: "需要提供 apiKey,或者 OAuth 的 {access, refresh, expires, accountId},或完整的 {credential: {...}}" };
}

export function mountAccountsApi(app: Express, onChange?: (provider: string, state: ProviderAccountsState) => void): void {
	if (onChange) {
		accountManagerEvents.on("change", (provider: string) => onChange(provider, accountsSnapshot(provider)));
		codexUsageMonitor.on("change", () => onChange(CODEX_PROVIDER_KEY, accountsSnapshot(CODEX_PROVIDER_KEY)));
	}

	/** Resolves the chain for a builtin provider, or answers 400 and returns null. */
	const managerFor = async (req: Request, res: Response): Promise<ProviderAccountManager | null> => {
		const provider = String(req.params.provider || "");
		if (!getBuiltinProviders().some((id) => id === provider)) {
			res.status(400).json({ error: `unknown provider '${provider}'` });
			return null;
		}
		const manager = accountManagerFor(provider);
		await manager.load();
		return manager;
	};

	app.get("/api/accounts", (_req: Request, res: Response) => {
		res.json(loadedAccountSnapshots());
	});

	app.get("/api/accounts/:provider", async (req: Request, res: Response) => {
		const manager = await managerFor(req, res);
		if (!manager) return;
		res.json(accountsSnapshot(manager.provider));
	});

	app.post("/api/accounts/:provider/usage/refresh", async (req: Request, res: Response) => {
		const manager = await managerFor(req, res);
		if (!manager) return;
		if (manager.provider !== CODEX_PROVIDER_KEY) {
			res.status(400).json({ error: `usage is not available for '${manager.provider}'` });
			return;
		}
		await codexUsageMonitor.refresh();
		res.json(accountsSnapshot(manager.provider));
	});

	app.post("/api/accounts/:provider", async (req: Request, res: Response) => {
		const manager = await managerFor(req, res);
		if (!manager) return;
		const parsed = parseCredentialFromBody(req.body);
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		const label = typeof (req.body as Record<string, unknown>)?.label === "string"
			? ((req.body as Record<string, unknown>).label as string)
			: "";
		try {
			const summary = await manager.addAccount({ label, credential: parsed.credential });
			res.json({ account: summary, state: accountsSnapshot(manager.provider) });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.delete("/api/accounts/:provider/:id", async (req: Request, res: Response) => {
		const manager = await managerFor(req, res);
		if (!manager) return;
		const id = String(req.params.id || "");
		if (!id) {
			res.status(400).json({ error: "id required" });
			return;
		}
		try {
			await manager.removeAccount(id);
			res.json(accountsSnapshot(manager.provider));
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.patch("/api/accounts/:provider/:id", async (req: Request, res: Response) => {
		const manager = await managerFor(req, res);
		if (!manager) return;
		const id = String(req.params.id || "");
		if (!id) {
			res.status(400).json({ error: "id required" });
			return;
		}
		const body = (req.body || {}) as Record<string, unknown>;
		try {
			if (typeof body.label === "string") {
				await manager.renameAccount(id, body.label);
			}
			if (body.credential || body.apiKey || body.access) {
				const parsed = parseCredentialFromBody(body);
				if (!parsed.ok) {
					res.status(400).json({ error: parsed.error });
					return;
				}
				await manager.updateCredential(id, parsed.credential);
			}
			res.json(accountsSnapshot(manager.provider));
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.put("/api/accounts/:provider/order", async (req: Request, res: Response) => {
		const manager = await managerFor(req, res);
		if (!manager) return;
		const body = (req.body || {}) as Record<string, unknown>;
		const order = Array.isArray(body.order) ? body.order.filter((x): x is string => typeof x === "string") : null;
		if (!order) {
			res.status(400).json({ error: "order: string[] required" });
			return;
		}
		try {
			await manager.reorderChain(order);
			res.json(accountsSnapshot(manager.provider));
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.post("/api/accounts/:provider/:id/activate", async (req: Request, res: Response) => {
		const manager = await managerFor(req, res);
		if (!manager) return;
		const id = String(req.params.id || "");
		if (!id) {
			res.status(400).json({ error: "id required" });
			return;
		}
		try {
			await manager.setActive(id);
			res.json(accountsSnapshot(manager.provider));
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.post("/api/accounts/:provider/import-current", async (req: Request, res: Response) => {
		const manager = await managerFor(req, res);
		if (!manager) return;
		const cred = readCredentialFromAuthJson(manager.provider);
		if (!cred) {
			res.status(404).json({ error: `auth.json 中没有 ${manager.provider} 凭证` });
			return;
		}
		try {
			const { result, account } = await manager.importOrUpdate({
				label: "已导入",
				credential: cred,
			});
			res.json({ result, account, state: accountsSnapshot(manager.provider) });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});
}

export function accountsSnapshot(provider: string): ProviderAccountsState {
	const state = accountManagerFor(provider).snapshot();
	return provider === CODEX_PROVIDER_KEY ? { ...state, usage: codexUsageMonitor.snapshot() } : state;
}
