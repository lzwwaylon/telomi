import { createHmac } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const PROVIDER_EXECUTION_DIRECTORY = "provider-executions";

/** Bind bridge access to the native execution without exposing the host secret to kernels. */
export function primeExecutionToken(secret: string, executionId: string): string {
	return createHmac("sha256", secret).update(executionId).digest("hex");
}

export function providerExecutionChildId(sessionDir: string | undefined): string | undefined {
	if (!sessionDir) return undefined;
	const childId = basename(sessionDir);
	return /^sub-[A-Za-z0-9-]+$/u.test(childId) ? childId : undefined;
}

/** Shared by the host Tools, the kernel launcher and Case capture. No delegation policy lives here. */
/** Written into each child's `work/`; the Python SDK reports it as `agent_session_id`. */
export const EXECUTION_ID_FILE = ".execution-id";

export function providerExecutionWorkspace(root: string, childId: string): {
	childId: string;
	absolutePath: string;
	relativePath: string;
} {
	if (!/^sub-[A-Za-z0-9-]+$/u.test(childId)) throw new Error(`Invalid Provider execution child id '${childId}'`);
	const resolvedRoot = realpathSync(root);
	const executions = join(resolvedRoot, PROVIDER_EXECUTION_DIRECTORY);
	const absolutePath = join(executions, childId);
	for (const directory of [executions, absolutePath, join(absolutePath, "work"), join(absolutePath, ".prime-kernel")]) {
		mkdirSync(directory, { recursive: true });
		if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
			throw new Error("Provider workspace must contain real directories");
		}
	}
	// The kernel's only view of its own identity: every child mounts its workspace at the same
	// guest path and shares the worker environment, so the Python SDK reads this marker to name
	// itself to the Runtime bridge (Browser sessions, skill-read receipts).
	const marker = join(absolutePath, "work", EXECUTION_ID_FILE);
	if (!existsSync(marker)) writeFileSync(marker, `${childId}\n`, "utf-8");
	const sharedSkills = join(resolvedRoot, "skills");
	const skills = join(absolutePath, "skills");
	if (existsSync(sharedSkills)) {
		try { symlinkSync(sharedSkills, skills, "dir"); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!lstatSync(skills).isSymbolicLink() || realpathSync(skills) !== realpathSync(sharedSkills)) {
			throw new Error("Provider workspace Skill link does not match its staged Skills");
		}
	}
	return { childId, absolutePath, relativePath: relative(resolvedRoot, absolutePath) };
}
