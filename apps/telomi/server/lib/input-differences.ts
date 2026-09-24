export interface InputFieldDifference {
	path: string;
	requested: unknown;
	effective: unknown;
}

export function deterministicInputDifferences(requested: unknown, effective: unknown): InputFieldDifference[] {
	const differences: InputFieldDifference[] = [];
	walkDifference(requested, effective, "$", differences);
	return differences;
}

function walkDifference(requested: unknown, effective: unknown, path: string, out: InputFieldDifference[]): void {
	if (Object.is(requested, effective)) return;
	if (Array.isArray(requested) && Array.isArray(effective)) {
		const length = Math.max(requested.length, effective.length);
		for (let index = 0; index < length; index += 1) walkDifference(requested[index], effective[index], `${path}[${index}]`, out);
		return;
	}
	if (plainObject(requested) && plainObject(effective)) {
		const keys = [...new Set([...Object.keys(requested), ...Object.keys(effective)])].sort();
		for (const key of keys) walkDifference(requested[key], effective[key], `${path}.${key}`, out);
		return;
	}
	out.push({ path, requested, effective });
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
