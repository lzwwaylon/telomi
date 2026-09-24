export type FileIngestKind = "local";

export type FileIngestStatus = "queued" | "running" | "done" | "error";

export type FileIngestParsedStatus = "parsed" | "raw_saved";

export interface FileIngestRequest {
	kind?: FileIngestKind;
	inputPath: string;
	key?: string;
	source?: string;
	title?: string;
	force?: boolean;
	requestedBy?: string;
}

export interface FileIngestResult {
	cacheKey: string;
	cacheDir: string;
	rawPath: string;
	metadataPath: string;
	parsedPath: string;
	markdownPath?: string;
	structuredPath?: string;
	structuredFormat?: string;
	contentType: string | null;
	byteLength: number;
	parser: string;
	parsedStatus: FileIngestParsedStatus;
	parseMetadata?: Record<string, unknown>;
}

export interface FileIngestJob {
	version: 1;
	id: string;
	goalId: string;
	kind: FileIngestKind;
	inputPath: string;
	absInputPath: string;
	key?: string;
	source?: string;
	title?: string;
	requestedBy?: string;
	cacheKey: string;
	status: FileIngestStatus;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	attempts: number;
	maxAttempts: number;
	error?: string;
	result?: FileIngestResult;
}

export interface FileIngestServiceEvent {
	type: "queued" | "started" | "finished" | "failed" | "retry" | "resume" | "error";
	goalId?: string;
	jobId?: string;
	message?: string;
}
