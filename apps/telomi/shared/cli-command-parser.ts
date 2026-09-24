import { parse as shellParse } from "shell-quote";

const PREFIX_COMMANDS = new Set([
	"sudo",
	"time",
	"nice",
	"nohup",
	"env",
	"timeout",
	"strace",
	"ltrace",
	"ionice",
	"taskset",
	"watch",
	"caffeinate",
]);

function basename(path: string): string {
	const index = path.lastIndexOf("/");
	return index >= 0 ? path.slice(index + 1) : path;
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

export function splitCommands(command: string): string[] {
	const commands: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let index = 0;

	while (index < command.length) {
		const char = command[index];
		const next = command[index + 1];

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			current += char;
			index++;
			continue;
		}
		if (char === '"' && !inSingleQuote) {
			if (index > 0 && command[index - 1] === "\\") {
				current += char;
				index++;
				continue;
			}
			inDoubleQuote = !inDoubleQuote;
			current += char;
			index++;
			continue;
		}

		if (!inSingleQuote && !inDoubleQuote) {
			if (char === "&" && next === "&") {
				if (current.trim()) commands.push(current.trim());
				current = "";
				index += 2;
				continue;
			}
			if (char === "|" && next === "|") {
				if (current.trim()) commands.push(current.trim());
				current = "";
				index += 2;
				continue;
			}
			if (char === "|") {
				if (current.trim()) commands.push(current.trim());
				current = "";
				index++;
				continue;
			}
			if (char === ";") {
				if (current.trim()) commands.push(current.trim());
				current = "";
				index++;
				continue;
			}
		}

		current += char;
		index++;
	}

	if (current.trim()) commands.push(current.trim());
	return commands;
}

export function extractCommandName(command: string): string | undefined {
	let parsed: ReturnType<typeof shellParse>;
	try {
		parsed = shellParse(command);
	} catch {
		return undefined;
	}

	const tokens = parsed.filter((token): token is string => typeof token === "string");
	let index = 0;

	while (index < tokens.length && isEnvAssignment(tokens[index]!)) index++;

	while (index < tokens.length) {
		const token = tokens[index]!;
		const commandName = basename(token);

		if (PREFIX_COMMANDS.has(commandName)) {
			index++;
			while (index < tokens.length && tokens[index]!.startsWith("-")) index++;
			if (
				commandName === "timeout" &&
				index < tokens.length &&
				/^\d+/.test(tokens[index]!)
			) {
				index++;
			}
			continue;
		}

		if (["bash", "zsh", "sh"].includes(commandName)) {
			const remaining = tokens.slice(index + 1);
			const commandFlagIndex = remaining.findIndex(
				(token) => token === "-c" || (token.startsWith("-") && token.includes("c")),
			);
			if (commandFlagIndex !== -1 && commandFlagIndex + 1 < remaining.length) {
				const innerCommand = remaining[commandFlagIndex + 1];
				if (innerCommand) return extractCommandName(innerCommand);
			}
		}

		break;
	}

	if (index >= tokens.length) return undefined;
	return basename(tokens[index]!);
}

export function extractCommandNames(command: string): string[] {
	if (!command || !command.trim()) return [];
	const names: string[] = [];
	for (const subCommand of splitCommands(command)) {
		const name = extractCommandName(subCommand);
		if (name) names.push(name);
	}
	return names;
}
