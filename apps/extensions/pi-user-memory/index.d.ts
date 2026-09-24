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
	deleteDocumentsByTag(tag: string): Promise<number>;
	deleteBank(): Promise<void>;
}

export declare function registerPiUserMemory(pi: object, config?: PiUserMemoryConfig): void;
export declare function resolvePiUserMemoryConfig(config?: PiUserMemoryConfig): ResolvedPiUserMemoryConfig;
export default function piUserMemory(pi: object): void;
