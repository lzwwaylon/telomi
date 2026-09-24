import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

interface RuntimeTools {
	readPaths: string[];
	binPaths: string[];
}

const cache = new Map<string, RuntimeTools>();

/** Resolve trusted host tools only. Never pass an Agent-controlled PATH or binary to ldd. */
export function runtimeTools(hostPath = process.env.PATH ?? ""): RuntimeTools {
	if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("SRT tools require macOS or Linux");
	const binaries = ["rg", "jq"].flatMap((name) => {
		for (const directory of hostPath.split(delimiter).filter(isAbsolute)) {
			const candidate = join(directory, name);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return [realpathSync(candidate)];
			} catch { /* Try the next trusted PATH entry. */ }
		}
		return [];
	});
	const key = JSON.stringify(binaries);
	let result = cache.get(key);
	if (!result) {
		const readPaths = new Set<string>();
		const visited = new Set<string>();
		const inspect = (binary: string, executable: string): void => {
			if (visited.has(binary)) return;
			if (visited.size >= 128) throw new Error("Sandbox tool dependency graph exceeds 128 files");
			visited.add(binary);
			const mac = process.platform === "darwin";
			let output: string;
			try {
				output = execFileSync(mac ? "/usr/bin/otool" : "/usr/bin/ldd", mac ? ["-L", binary] : [binary], {
					encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024,
				});
			} catch (error) {
				const failure = error as { stdout?: string; stderr?: string; status?: number };
				if (!mac && failure.status === 1 && /^\s*(not a dynamic executable|statically linked)\s*$/u.test(
					`${failure.stdout ?? ""}${failure.stderr ?? ""}`)) return;
				throw new Error(`Cannot inspect sandbox tool dependency: ${binary}`, { cause: error });
			}
			if (/=>\s+not found/u.test(output)) throw new Error(`Unresolved sandbox tool dependency: ${binary}`);
			const libraries = mac
				? output.split("\n").slice(1).map((line) => line.trim().split(" (compatibility version")[0]!).filter(Boolean)
				: [...output.matchAll(/(?:=>\s*)?(\/[^\s]+)/gu)].map((match) => match[1]!);
			for (let library of libraries) {
				library = library.replace(/^@loader_path(?=\/)/u, dirname(binary))
					.replace(/^@executable_path(?=\/)/u, dirname(executable));
				if (!isAbsolute(library)) throw new Error(`Unsupported sandbox tool dependency path: ${library}`);
				// These system library trees are already granted by the shared SRT policy.
				if (/^\/(?:usr\/lib(?:64)?|lib(?:64)?|System\/Library)\//u.test(library)) continue;
				if (!existsSync(library)) throw new Error(`Missing sandbox tool dependency: ${library}`);
				const canonical = realpathSync(resolve(library));
				readPaths.add(dirname(canonical));
				inspect(canonical, executable);
			}
		};
		const available = binaries.filter((binary) => {
			const previous = new Set(readPaths);
			visited.clear();
			try {
				const header = Buffer.alloc(4);
				const fd = openSync(binary, "r");
				try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
				const formats = process.platform === "linux" ? ["7f454c46"]
					: ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"];
				if (!formats.includes(header.toString("hex"))) throw new Error("Only native tool executables can be inspected");
				inspect(binary, binary);
				readPaths.add(binary);
				return true;
			} catch (error) {
				// Optional tools must not prevent a Python-only Kernel from starting.
				// Revoke partial grants; invoking this tool still fails inside the sandbox.
				for (const path of readPaths) if (!previous.has(path)) readPaths.delete(path);
				console.warn(`[telomi-srt] Optional tool unavailable: ${binary}: ${error instanceof Error ? error.message : String(error)}`);
				return false;
			}
		});
		result = { readPaths: [...readPaths], binPaths: [...new Set(available.map(dirname))] };
		cache.set(key, result);
	}
	return { readPaths: [...result.readPaths], binPaths: [...result.binPaths] };
}
