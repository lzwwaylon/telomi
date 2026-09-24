/** Resolve an already decoded file path in the Goal's guest Workspace namespace. */
export function resolveWorkspacePath(path: string, currentFile?: string): string {
	let absolute = path;
	if (!path.startsWith("/")) {
		if (currentFile) {
			absolute = `${currentFile.slice(0, currentFile.lastIndexOf("/") + 1)}${path}`;
		} else {
			absolute = `/work/${path}`;
		}
	}
	const parts: string[] = [];
	for (const part of absolute.split("/")) {
		if (part === "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return `/${parts.join("/")}`;
}
