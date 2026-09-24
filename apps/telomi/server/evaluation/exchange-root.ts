/**
 * Bundle Exchange Root。
 *
 * 当前仍用同机文件路径传递大 Bundle，所以 Import 是 Operations Listener 上唯一
 * 接受主机路径的入口。它必须收敛到启动时配置的一个目录：评估环境把 tar 写进这个
 * 目录，Telomi 只从这里读，任意绝对路径、`..` 穿越和符号链接一律拒绝。
 *
 * Exchange Root 本身不出现在 HTTP 契约里。评估环境启动 Eval Instance 时自己设置
 * `TELOMI_OPERATIONS_EXCHANGE_ROOT`，因此双方都知道它，谁也不需要向对方泄露
 * 磁盘布局。
 */
import { lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** `TELOMI_OPERATIONS_EXCHANGE_ROOT`，默认 `<workspaceDir>/operations-exchange`。 */
export function resolveOperationsExchangeRoot(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.TELOMI_OPERATIONS_EXCHANGE_ROOT?.trim();
	return configured ? resolve(configured) : join(resolve(workspaceDir), "operations-exchange");
}

export function ensureOperationsExchangeRoot(root: string): string {
	mkdirSync(root, { recursive: true });
	return root;
}

/**
 * Trust boundary: 把请求里的路径解析成 Exchange Root 内的一个真实普通文件，
 * 或者抛错。相对路径按 Exchange Root 解析，绝对路径必须落在其中。
 */
export function resolveExchangeBundlePath(exchangeRoot: string, requested: string): string {
	let rootReal: string;
	try {
		rootReal = realpathSync(exchangeRoot);
	} catch {
		throw new Error(`Bundle Exchange Root '${exchangeRoot}' does not exist`);
	}
	const target = resolve(exchangeRoot, requested);
	// Exchange Root 和请求路径可能各自通过符号链接拼写（macOS 的 /var -> /private/var）。
	// 三种拼法都算在内，但最后一段永远不做 realpath，符号链接文件仍由下面的逐段检查拒绝。
	const inside = within(exchangeRoot, target) ?? within(rootReal, target)
		?? within(rootReal, realParent(target));
	if (inside === undefined) {
		throw new Error(`Bundle import path must stay inside the Exchange Root '${rootReal}'`);
	}
	let current = rootReal;
	for (const segment of inside.split(sep)) {
		current = join(current, segment);
		if (stat(current).isSymbolicLink()) {
			throw new Error(`Bundle import path must not traverse a symlink: '${segment}'`);
		}
	}
	const file = stat(current);
	if (!file.isFile() || file.nlink !== 1) throw new Error("Bundle import path must be one regular file");
	return current;
}

/** `target` with its directory resolved through symlinks; the final component is left alone. */
function realParent(target: string): string {
	try {
		return join(realpathSync(dirname(target)), basename(target));
	} catch {
		return target;
	}
}

/** Relative path of `target` under `base`, or undefined when it escapes. */
function within(base: string, target: string): string | undefined {
	const rel = relative(base, target);
	return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : undefined;
}

function stat(path: string): Stats {
	try {
		return lstatSync(path);
	} catch {
		throw new Error(`Bundle import path does not exist inside the Exchange Root: '${path}'`);
	}
}
