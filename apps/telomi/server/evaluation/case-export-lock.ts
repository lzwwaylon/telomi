const exportingCases = new Set<string>();

/** Protects a Case from retention until its Bundle tar no longer reads the Case directory. */
export async function withCaseExport<T>(caseDirectory: string, exportBundle: () => Promise<T>): Promise<T> {
	exportingCases.add(caseDirectory);
	try {
		return await exportBundle();
	} finally {
		exportingCases.delete(caseDirectory);
	}
}

export function caseExporting(caseDirectory: string): boolean {
	return exportingCases.has(caseDirectory);
}
