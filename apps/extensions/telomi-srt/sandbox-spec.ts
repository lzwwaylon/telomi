import path from "node:path";

export const SANDBOX_TOOL_NAMES = ["read", "write", "edit", "bash", "ls", "find", "grep"] as const;
export const REPORT_SANDBOX_ROLES = [
	"report.search_planner",
	"report.cornell_note",
	"report.report_writer",
] as const;

export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];
export type ReportSandboxRole = (typeof REPORT_SANDBOX_ROLES)[number];
export type SandboxRole =
	| "main.goal_agent"
	| "evolution.candidate_author"
	| ReportSandboxRole;

export interface SandboxMountSpec {
	hostPath: string;
	guestPath: string;
	access: "read-only" | "read-write";
	/** Paths relative to this mount that must not be visible in the guest. */
	shadowPaths?: string[];
}

export interface SandboxWriteRule {
	guestPath: string;
	kind: "file" | "tree";
}

export interface SandboxExecutionSpec {
	version: 1;
	id: string;
	role: SandboxRole;
	sessionLabel: string;
	hostCwd: string;
	guestCwd: string;
	source?: {
		ref?: string;
		sha?: string;
	};
	mounts: SandboxMountSpec[];
	activeTools: SandboxToolName[];
	/** Positive allowlist. Only these values are copied into guest processes. */
	env: Record<string, string>;
	network: {
		mode: "deny" | "allow" | "http-allowlist";
		allowedHosts?: string[];
	};
	writablePaths: SandboxWriteRule[];
}

const TOOL_NAMES = new Set<string>(SANDBOX_TOOL_NAMES);
const ROLE_NAMES = new Set<SandboxRole>([
	"main.goal_agent",
	"evolution.candidate_author",
	...REPORT_SANDBOX_ROLES,
]);
const REPORT_ROLE_NAMES = new Set<SandboxRole>(REPORT_SANDBOX_ROLES);
const SECRET_ENV_PATTERN = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)(?:$|_)|^(?:AWS|AZURE|GITHUB|SSH)_|^GOOGLE_APPLICATION_CREDENTIALS$/i;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const extras = Object.keys(record).filter((key) => !allowed.includes(key));
	if (extras.length > 0) throw new Error(`${label} contains unsupported fields: ${extras.join(", ")}`);
}

function normalizeGuestPath(value: string, label: string): string {
	if (!path.posix.isAbsolute(value)) throw new Error(`${label} must be an absolute guest path`);
	const normalized = path.posix.normalize(value);
	if (normalized === "/") throw new Error(`${label} cannot be the guest root`);
	return normalized;
}

function isInside(root: string, value: string): boolean {
	return value === root || value.startsWith(`${root}/`);
}

function parseMount(value: unknown, index: number): SandboxMountSpec {
	const record = requireRecord(value, `mounts[${index}]`);
	assertExactKeys(record, ["hostPath", "guestPath", "access", "shadowPaths"], `mounts[${index}]`);
	const hostPath = path.resolve(requireString(record.hostPath, `mounts[${index}].hostPath`));
	const guestPath = normalizeGuestPath(requireString(record.guestPath, `mounts[${index}].guestPath`), `mounts[${index}].guestPath`);
	if (record.access !== "read-only" && record.access !== "read-write") {
		throw new Error(`mounts[${index}].access must be read-only or read-write`);
	}
	const shadowPaths = record.shadowPaths === undefined
		? undefined
		: (() => {
			if (!Array.isArray(record.shadowPaths) || !record.shadowPaths.every((item) => typeof item === "string")) {
				throw new Error(`mounts[${index}].shadowPaths must be a string array`);
			}
			return record.shadowPaths.map((item) => path.posix.normalize(`/${item.replace(/^\/+/, "")}`));
		})();
	return { hostPath, guestPath, access: record.access, ...(shadowPaths ? { shadowPaths } : {}) };
}

function parseWriteRule(value: unknown, index: number): SandboxWriteRule {
	const record = requireRecord(value, `writablePaths[${index}]`);
	assertExactKeys(record, ["guestPath", "kind"], `writablePaths[${index}]`);
	const guestPath = normalizeGuestPath(
		requireString(record.guestPath, `writablePaths[${index}].guestPath`),
		`writablePaths[${index}].guestPath`,
	);
	if (record.kind !== "file" && record.kind !== "tree") {
		throw new Error(`writablePaths[${index}].kind must be file or tree`);
	}
	return { guestPath, kind: record.kind };
}

export function parseSandboxExecutionSpec(value: unknown): SandboxExecutionSpec {
	const record = requireRecord(value, "sandbox spec");
	assertExactKeys(record, [
		"version", "id", "role", "sessionLabel", "hostCwd", "guestCwd", "source",
		"mounts", "activeTools", "env", "network", "writablePaths",
	], "sandbox spec");
	if (record.version !== 1) throw new Error("sandbox spec version must be 1");
	const id = requireString(record.id, "sandbox spec id");
	const role = requireString(record.role, "sandbox spec role") as SandboxRole;
	if (!ROLE_NAMES.has(role)) throw new Error(`unsupported sandbox role: ${role}`);
	const sessionLabel = requireString(record.sessionLabel, "sandbox sessionLabel");
	const hostCwd = path.resolve(requireString(record.hostCwd, "sandbox hostCwd"));
	const guestCwd = normalizeGuestPath(requireString(record.guestCwd, "sandbox guestCwd"), "sandbox guestCwd");

	if (!Array.isArray(record.mounts) || record.mounts.length === 0) {
		throw new Error("sandbox mounts must be a non-empty array");
	}
	const mounts = record.mounts.map(parseMount);
	const guestMounts = new Set<string>();
	for (const mount of mounts) {
		if (guestMounts.has(mount.guestPath)) throw new Error(`duplicate guest mount: ${mount.guestPath}`);
		guestMounts.add(mount.guestPath);
	}
	if (!mounts.some((mount) => isInside(mount.guestPath, guestCwd))) {
		throw new Error(`guest cwd is outside all mounts: ${guestCwd}`);
	}

	if (!Array.isArray(record.activeTools) || record.activeTools.length === 0) {
		throw new Error("sandbox activeTools must be a non-empty array");
	}
	const activeTools = record.activeTools.map((item, index) => {
		if (typeof item !== "string" || !TOOL_NAMES.has(item)) {
			throw new Error(`activeTools[${index}] is not a supported sandbox tool`);
		}
		return item as SandboxToolName;
	});
	if (new Set(activeTools).size !== activeTools.length) throw new Error("sandbox activeTools contains duplicates");

	const envRecord = requireRecord(record.env, "sandbox env");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(envRecord)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid guest env name: ${key}`);
		if (SECRET_ENV_PATTERN.test(key)) throw new Error(`secret-like env is not allowed in guest: ${key}`);
		if (typeof value !== "string") throw new Error(`guest env ${key} must be a string`);
		env[key] = value;
	}

	const networkRecord = requireRecord(record.network, "sandbox network");
	assertExactKeys(networkRecord, ["mode", "allowedHosts"], "sandbox network");
	if (networkRecord.mode !== "deny" && networkRecord.mode !== "allow" && networkRecord.mode !== "http-allowlist") {
		throw new Error("sandbox network mode must be deny, allow, or http-allowlist");
	}
	const allowedHosts = networkRecord.allowedHosts === undefined
		? undefined
		: (() => {
			if (!Array.isArray(networkRecord.allowedHosts) || !networkRecord.allowedHosts.every((item) => typeof item === "string")) {
				throw new Error("sandbox network.allowedHosts must be a string array");
			}
			return [...new Set(networkRecord.allowedHosts.map((item) => item.trim().toLowerCase()).filter(Boolean))];
		})();
	if (networkRecord.mode === "http-allowlist" && (!allowedHosts || allowedHosts.length === 0)) {
		throw new Error("http-allowlist mode requires at least one allowed host");
	}
	if (networkRecord.mode !== "http-allowlist" && allowedHosts !== undefined) {
		throw new Error("sandbox network.allowedHosts is only valid in http-allowlist mode");
	}

	if (!Array.isArray(record.writablePaths)) throw new Error("sandbox writablePaths must be an array");
	const writablePaths = record.writablePaths.map(parseWriteRule);
	for (const rule of writablePaths) {
		if (!mounts.some((mount) => mount.access === "read-write" && isInside(mount.guestPath, rule.guestPath))) {
			throw new Error(`writable path is outside read-write mounts: ${rule.guestPath}`);
		}
	}
	if (activeTools.includes("bash") && writablePaths.some((rule) => rule.kind === "file")) {
		throw new Error("bash sandboxes cannot rely on file-only write rules; use a dedicated read-write mount");
	}
	if (REPORT_ROLE_NAMES.has(role)) {
		if (guestCwd !== "/work") throw new Error(`report sandbox role ${role} requires guestCwd /work`);
		if (role === "report.cornell_note") {
			if (networkRecord.mode !== "deny") throw new Error("report Cornell Note requires denied network");
		} else if (networkRecord.mode !== "allow") {
			throw new Error(`report sandbox role ${role} requires open network`);
		}
		if (!mounts.some((mount) => mount.guestPath === "/work" && mount.access === "read-write")) {
			throw new Error(`report sandbox role ${role} requires a read-write /work mount`);
		}
		if (!writablePaths.some((rule) => rule.guestPath === "/work" && rule.kind === "tree")) {
			throw new Error(`report sandbox role ${role} requires writable /work tree`);
		}
	}

	let source: SandboxExecutionSpec["source"];

	if (record.source !== undefined) {
		const sourceRecord = requireRecord(record.source, "sandbox source");
		assertExactKeys(sourceRecord, ["ref", "sha"], "sandbox source");
		source = {
			...(typeof sourceRecord.ref === "string" ? { ref: sourceRecord.ref } : {}),
			...(typeof sourceRecord.sha === "string" ? { sha: sourceRecord.sha } : {}),
		};
	}

	return {
		version: 1,
		id,
		role,
		sessionLabel,
		hostCwd,
		guestCwd,
		...(source ? { source } : {}),
		mounts,
		activeTools,
		env,
		network: {
			mode: networkRecord.mode,
			...(allowedHosts ? { allowedHosts } : {}),
		},
		writablePaths,
	};
}

export function canonicalGuestPath(spec: SandboxExecutionSpec, value: string): string {
	const normalized = path.posix.resolve(spec.guestCwd, value);
	for (const mount of [...spec.mounts].sort((a, b) => b.guestPath.length - a.guestPath.length)) {
		const alias = path.posix.join("/data", mount.guestPath);
		if (isInside(alias, normalized)) {
			const suffix = normalized.slice(alias.length);
			return `${mount.guestPath}${suffix}`;
		}
	}
	return normalized;
}

export function isGuestWriteAllowed(
	spec: SandboxExecutionSpec,
	value: string,
	operation: "write" | "mkdir" = "write",
): boolean {
	const guestPath = canonicalGuestPath(spec, value);
	for (const rule of spec.writablePaths) {
		if (rule.kind === "tree" && isInside(rule.guestPath, guestPath)) return true;
		if (rule.kind === "file" && guestPath === rule.guestPath) return true;
		if (operation === "mkdir" && rule.kind === "file" && isInside(guestPath, rule.guestPath)) return true;
	}
	return false;
}

export function assertGuestWriteAllowed(
	spec: SandboxExecutionSpec,
	value: string,
	operation: "write" | "mkdir" = "write",
): void {
	if (!isGuestWriteAllowed(spec, value, operation)) {
		throw new Error(`sandbox policy blocks ${operation}: ${canonicalGuestPath(spec, value)}`);
	}
}
