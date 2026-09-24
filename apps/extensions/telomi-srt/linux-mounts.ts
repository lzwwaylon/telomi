import { basename, isAbsolute, relative, sep } from "node:path";
import { parse } from "shell-quote";
import type { SrtPolicy } from "./runtime.js";

// SRT 0.0.73 restores writes before read-only ancestors after a denyRead tmpfs.
// Restore only grants it already emitted; never add permissions or move a mask.
// ponytail: overlapping denies stay fail-closed; extend composition only for a required layout.
export function linuxSandboxArgv(wrapped: readonly string[], filesystem: SrtPolicy["filesystem"]): string[] {
	let argv = [...wrapped];
	if (argv.length === 3 && argv[1] === "-c" && ["sh", "bash"].includes(basename(argv[0]!))) {
		const parsed = parse(argv[2]!, () => { throw new Error("Unexpected expansion in Linux sandbox wrapper"); });
		if (!parsed.every((token): token is string => typeof token === "string")) {
			throw new Error("Unexpected shell operator in Linux sandbox wrapper");
		}
		argv = parsed;
	}
	if (basename(argv[0] ?? "") !== "bwrap") throw new Error("Expected a bubblewrap sandbox command");
	const result = [argv[0]!];
	const emittedWrites = new Set<string>();
	const restrictions: Array<{ path: string; masksAncestor: boolean }> = [];
	const arities: Record<string, number> = {
		"--new-session": 0, "--die-with-parent": 0, "--unshare-net": 0,
		"--unshare-pid": 0, "--unshare-user": 0,
		"--bind": 2, "--ro-bind": 2, "--setenv": 2,
		"--unsetenv": 1, "--tmpfs": 1, "--dev": 1, "--proc": 1, "--cap-drop": 1,
	};
	for (let index = 1; index < argv.length;) {
		const option = argv[index]!;
		if (option === "--") {
			if (index + 1 === argv.length) throw new Error("Missing sandbox command");
			return [...result, ...argv.slice(index)];
		}
		const count = arities[option];
		if (typeof count !== "number" || index + count >= argv.length) throw new Error(`Unexpected bubblewrap option: ${option}`);
		const source = argv[index + 1]!;
		const destination = argv[index + 2]!;
		result.push(...argv.slice(index, index + count + 1));
		if (option === "--bind" && source === destination && filesystem.allowWrite.includes(destination)) {
			emittedWrites.add(destination);
		}
		if (option === "--ro-bind") {
			if (source === destination) {
				for (const write of emittedWrites) {
					if (write === destination || !inside(destination, write)) continue;
					if (filesystem.denyWrite.some((deny) => overlaps(deny, write))) continue;
					if (filesystem.denyRead.some((deny) => inside(write, deny))) continue;
					if (restrictions.some((deny) => inside(write, deny.path) || (deny.masksAncestor && inside(deny.path, write)))) continue;
					result.push("--bind", write, write);
				}
			}
			restrictions.push({ path: destination, masksAncestor: source !== destination });
		} else if (["--tmpfs", "--dev", "--proc"].includes(option)) {
			restrictions.push({ path: source, masksAncestor: false });
		}
		index += count + 1;
	}
	throw new Error("Missing bubblewrap command separator");
}

function inside(root: string, path: string): boolean {
	const suffix = relative(root, path);
	return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function overlaps(left: string, right: string): boolean {
	return inside(left, right) || inside(right, left);
}
