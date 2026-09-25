export interface PiUserMemoryConfig {
	baseUrl?: string;
	bankId?: string;
	goalId?: string;
	retainTurns?: boolean;
}

export interface ResolvedPiUserMemoryConfig {
	baseUrl: string;
	bankId: string;
	goalId?: string;
}

export interface RetainInput {
	documentId: string;
	occurredAt: string;
	content: string;
	context: string;
	tags?: string[];
	metadata?: Record<string, string>;
	observationScopes?: string[][] | "shared";
	async?: boolean;
}

export interface HindsightMemory {
	id: string;
	text: string;
	type: string;
	document_id?: string | null;
}

export interface RecallResult {
	results: HindsightMemory[];
	entities?: unknown[];
}

export interface ReflectResult {
	text: string;
	based_on?: { memories?: HindsightMemory[]; [key: string]: unknown } | null;
	[key: string]: unknown;
}

export declare class HindsightClient {
	constructor(baseUrl: string, bankId: string);
	retain(input: RetainInput): Promise<unknown>;
	recall(query: string, options?: { goalId?: string }): Promise<RecallResult>;
	reflect(query: string, options?: { goalId?: string }): Promise<ReflectResult>;
	listDocuments(tags: string[]): Promise<HindsightDocument[]>;
	listDocumentsById(idPart: string): Promise<HindsightDocument[]>;
	getDocument(documentId: string): Promise<HindsightDocumentDetail | undefined>;
	setDocumentTags(documentId: string, tags: string[]): Promise<void>;
	deleteDocument(documentId: string): Promise<void>;
	listMemoryUnits(tags: string[], state: "valid" | "invalidated"): Promise<HindsightMemoryUnit[]>;
	getMemoryUnit(memoryId: string): Promise<HindsightMemoryUnit | undefined>;
	updateMemoryUnit(memoryId: string, update: MemoryUnitUpdate): Promise<HindsightMemoryUnit>;
	deleteBank(): Promise<void>;
}

export interface HindsightDocument {
	id: string;
	created_at: string;
	tags: string[];
	document_metadata?: Record<string, string> | null;
}

export interface HindsightDocumentDetail extends HindsightDocument {
	original_text: string;
}

export interface HindsightMemoryUnit {
	id: string;
	text: string;
	fact_type: string;
	state: "valid" | "invalidated";
	document_id?: string | null;
	tags: string[];
	edited_at?: string | null;
	invalidated_at?: string | null;
}

export interface MemoryUnitUpdate {
	text?: string;
	state?: "valid" | "invalidated";
}

export declare const GLOBAL_MEMORY_TAG = "scope:global";
export declare const MEMORY_UNAVAILABLE_TEXT: string;
export declare function isMemoryUnavailable(error: unknown): boolean;

export declare function registerPiUserMemory(pi: object, config?: PiUserMemoryConfig): void;
export declare function resolvePiUserMemoryConfig(config?: PiUserMemoryConfig): ResolvedPiUserMemoryConfig;
export default function piUserMemory(pi: object): void;
