// 目录级 copy-on-write 物化。
//
// Node 的 fs.constants.COPYFILE_FICLONE 在 macOS 上是 no-op（实测 500MB 文件仍然
// 占用 +512MB），COPYFILE_FICLONE_FORCE 抛 ENOSYS。真克隆只能交给内核的
// clonefile(2)，这里通过 `cp -Rc` 触发，并且以整棵树为单位——逐文件起子进程约
// 5.8ms/文件，整树只要 0.13ms/文件。
//
// 不支持 clonefile 的文件系统、以及跨卷的目标（clonefile 会以 "Cross-device link"
// 硬失败）都会回到调用方原有的逐文件拷贝路径。

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";

export type CowResult = "clone" | "unavailable";

/**
 * 把 `sourceRoot` 的内容克隆进已存在的 `targetRoot`。
 * 返回 "unavailable" 时目标已被清空重建，调用方应走自己的逐文件拷贝。
 */
export function cloneDirectoryContents(sourceRoot: string, targetRoot: string): CowResult {
	try {
		execFileSync("/bin/cp", ["-Rc", `${sourceRoot}/`, targetRoot], { stdio: "pipe" });
		return "clone";
	} catch {
		rmSync(targetRoot, { recursive: true, force: true });
		mkdirSync(targetRoot, { recursive: true });
		return "unavailable";
	}
}

/**
 * 批量克隆一组 (source -> target) 文件。
 *
 * 逐文件起 `cp -c` 子进程约 5.8ms/文件，2400 个文件要 14 秒。`cp` 支持一次接收多个
 * 源文件复制进同一个目录，所以同名的按目标目录分组批量执行；需要改名的（例如
 * `.gitmodules` -> `gitmodules.txt`）数量很少，单独处理。
 *
 * 返回 false 表示这套路径不可用（例如跨卷），调用方应退回自己的逐文件拷贝。
 */
export function cloneFilesBatched(pairs: ReadonlyArray<{ source: string; target: string }>): boolean {
	if (pairs.length === 0) return true;
	const sameName = new Map<string, string[]>();
	const renamed: Array<{ source: string; target: string }> = [];
	for (const pair of pairs) {
		if (basename(pair.source) === basename(pair.target)) {
			const directory = dirname(pair.target);
			const bucket = sameName.get(directory);
			if (bucket) bucket.push(pair.source);
			else sameName.set(directory, [pair.source]);
		} else {
			renamed.push(pair);
		}
	}
	try {
		for (const [directory, sources] of sameName) {
			mkdirSync(directory, { recursive: true });
			for (let index = 0; index < sources.length; index += BATCH_SIZE) {
				execFileSync("/bin/cp", ["-c", ...sources.slice(index, index + BATCH_SIZE), directory], { stdio: "pipe" });
			}
		}
		for (const pair of renamed) {
			mkdirSync(dirname(pair.target), { recursive: true });
			execFileSync("/bin/cp", ["-c", pair.source, pair.target], { stdio: "pipe" });
		}
		return true;
	} catch {
		return false;
	}
}

// ARG_MAX 在 macOS 上约 1MB；每批 500 个路径远低于上限，同时把子进程数压到最少。
const BATCH_SIZE = 500;
