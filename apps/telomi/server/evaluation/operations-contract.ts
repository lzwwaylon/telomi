/**
 * Operations HTTP 契约的唯一真源。
 *
 * TypeBox Schema -> AJV 运行时验证 -> OpenAPI 文档 -> 外部评估环境生成类型。
 * 路由表和 Schema 都在这里定义，Router 和 OpenAPI 生成脚本共用同一份数据，
 * 因此两者不会漂移。这个模块只依赖 TypeBox 和 AJV，不加载 Replay Executor，
 * 生成脚本可以在不启动 Evaluation 的进程里 import 它。
 *
 * Schema 描述的是 Service 真正投影出的响应，不是内部存储结构。凡是主机绝对
 * 路径（Artifact 的 `absolutePath`、Material Cache 根目录、Exchange Root）都
 * 不进入契约：评估环境通过 Run 相对 ref 和专门的读文件路由取内容，永远不需要知道
 * Telomi 的磁盘布局。
 */
import { sha256 } from "../lib/hash.js";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { Type, type TSchema } from "@sinclair/typebox";

/** 评估环境在启动 Replay 前比对；不兼容立即失败。破坏性契约变更必须递增。 */
export const OPERATIONS_PROTOCOL_VERSION = 3;

export const OPERATIONS_BASE_PATH = "/operations/v1";

const NonEmptyString = Type.String({ minLength: 1 });
const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Count = Type.Integer({ minimum: 0 });
const Amount = Type.Number({ minimum: 0 });
/** 完全定义的 DTO；多出来的字段是协议漂移，响应验证会拒绝。 */
const Closed = { additionalProperties: false } as const;
/** 开放记录：Telomi 侧是强类型，但对评估环境只保证这些字段存在。 */
const Open = { additionalProperties: true } as const;

const CaseRef = Type.Object({
	sourceRunId: NonEmptyString,
	caseId: NonEmptyString,
}, Closed);

const AggregateMetrics = Type.Object({
	executions: Count,
	inputTokens: Count,
	outputTokens: Count,
	costUsd: Amount,
	calls: Count,
	turns: Count,
	toolCalls: Count,
	durationMs: Amount,
}, Closed);

const ExecutionMetrics = Type.Object({
	inputTokens: Count,
	outputTokens: Count,
	costUsd: Amount,
	calls: Count,
	turns: Count,
	toolCalls: Count,
	durationMs: Amount,
}, Closed);

const RunStatus = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("awaiting_evaluation"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
]);

/**
 * Run 目录相对的 Evidence 引用。命名项在所有 Recipe 上稳定；Recipe 还会投影出
 * 编号和节点专属的名字（`agentTrace2`、`candidateLedger1`、`sourceIndex3`），
 * 所以这张表刻意保持开放，值恒为 Run 相对路径，永远不是主机绝对路径。
 */
const ExecutionRefs = Type.Object({
	agentTrace: Type.Optional(NonEmptyString),
	activityTrace: Type.Optional(NonEmptyString),
	acquisitionTrace: Type.Optional(NonEmptyString),
	organizerTrace: Type.Optional(NonEmptyString),
	runtimeTrace: Type.Optional(NonEmptyString),
	providerLog: Type.Optional(NonEmptyString),
	organizerDecision: Type.Optional(NonEmptyString),
	organizerIndex: Type.Optional(NonEmptyString),
	sourceIndex: Type.Optional(NonEmptyString),
	systemPrompt: Type.Optional(NonEmptyString),
	userPrompt: Type.Optional(NonEmptyString),
}, { additionalProperties: NonEmptyString });

/**
 * 一次 execution 发布的输出。`ref` 相对 Run 目录，是评估环境需要的唯一句柄：
 * 文件内容通过 `readExecutionArtifact` 读取，目录 Artifact 的文件清单通过
 * `readEvaluationBatch` 的 `outputs` 获得。Artifact 的主机绝对路径留在 Telomi。
 */
const ExecutionArtifact = Type.Object({
	ref: NonEmptyString,
	sha256: Sha256,
	byteLength: Count,
	directory: Type.Boolean(),
}, Closed);

const Execution = Type.Object({
	id: NonEmptyString,
	caseRef: CaseRef,
	repetition: Type.Integer({ minimum: 1 }),
	variant: Type.Literal("candidate"),
	status: Type.Optional(Type.Union([
		Type.Literal("completed"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	])),
	/** Candidate 执行自己也被 Capture 成 Case；评估环境用它导出 Candidate Bundle。 */
	candidateCaseRef: Type.Optional(CaseRef),
	error: Type.Optional(Type.String()),
	artifact: ExecutionArtifact,
	metrics: ExecutionMetrics,
	refs: Type.Optional(ExecutionRefs),
}, Closed);

/** 正在跑、还没有 Artifact 和 metrics 的 Candidate execution。只在 `running` Run 上出现。 */
const ActiveExecution = Type.Object({
	id: NonEmptyString,
	caseRef: CaseRef,
	repetition: Type.Integer({ minimum: 1 }),
	variant: Type.Literal("candidate"),
	status: Type.Literal("running"),
	refs: ExecutionRefs,
}, Closed);

const Pair = Type.Object({
	id: NonEmptyString,
	caseRef: CaseRef,
	repetition: Type.Integer({ minimum: 1 }),
	a: Type.Union([Type.Literal("observed"), Type.Literal("candidate")]),
	b: Type.Union([Type.Literal("observed"), Type.Literal("candidate")]),
	candidateExecutionId: NonEmptyString,
}, Closed);

const PromptOverride = Type.Object({
	systemPrompt: Type.Optional(Type.String()),
	userPrompt: Type.Optional(Type.String()),
}, Closed);

/** Recorded-stage Agent 的 Candidate Prompt，按 Case 固定并按 Hash 绑定。 */
const CandidatePromptBundle = Type.Object({
	schemaVersion: Type.Literal(1),
	source: Type.Union([Type.Literal("observed"), Type.Literal("override")]),
	sha256: Sha256,
	cases: Type.Array(Type.Object({
		caseRef: CaseRef,
		systemPrompt: Type.String(),
		userPrompt: Type.String(),
		systemSha256: Sha256,
		userSha256: Sha256,
	}, Closed)),
}, Closed);

/** 请求里的 Candidate 变体在入队时被解析成这个形状，Run 上回给评估环境的就是它。 */
const ResolvedCandidate = Type.Object({
	capabilitySnapshotId: NonEmptyString,
	workspaceContentHash: NonEmptyString,
	capabilityBundleHash: NonEmptyString,
	promptMode: Type.Optional(Type.Union([Type.Literal("observed"), Type.Literal("override")])),
	promptOverride: Type.Optional(PromptOverride),
	promptBundle: Type.Optional(CandidatePromptBundle),
	expectedRuntimeBuild: Type.Optional(NonEmptyString),
	expectedAgentBundleSha256: Type.Optional(NonEmptyString),
}, Closed);

const CandidateReplayRun = Type.Object({
	schemaVersion: Type.Literal(4),
	mode: Type.Literal("candidate-replay"),
	/**
	 * `quality` Run 的 Observed Baseline 成功且有输出，因此产生匿名 Pair。
	 * `recovery` Run 的 Observed 失败或没有输出：Candidate 只要正常结束并通过输出契约就算
	 * 恢复成功，Telomi 不生成 Pair，评估环境不得为它请求盲评。
	 * 早于 Recovery Replay 的历史 Run 在读取时一律恢复成 `quality`，字段因此永远存在。
	 */
	kind: Type.Union([Type.Literal("quality"), Type.Literal("recovery")]),
	id: NonEmptyString,
	goalId: NonEmptyString,
	status: RunStatus,
	agentId: NonEmptyString,
	cases: Type.Array(CaseRef),
	candidate: ResolvedCandidate,
	observedMetrics: AggregateMetrics,
	repetitions: Type.Integer({ minimum: 1 }),
	rubricId: NonEmptyString,
	runtimeBuild: Type.Optional(Type.String()),
	agentBundleSha256: Type.Optional(Type.String()),
	createdAt: NonEmptyString,
	updatedAt: NonEmptyString,
	startedAt: Type.Optional(Type.String()),
	finishedAt: Type.Optional(Type.String()),
	executions: Type.Array(Execution),
	activeExecution: Type.Optional(ActiveExecution),
	pairs: Type.Array(Pair),
	error: Type.Optional(Type.String()),
}, Closed);

/**
 * Case Manifest 的稳定身份字段。其余内容刻意保持开放：完整 Case 语义由 Case Bundle
 * 承载，评估环境消费的是 Bundle，不是这个投影，把整份 Manifest 冻进 HTTP 契约只会让
 * 每次 Capture 改动都变成一次协议破坏。
 */
const EvaluationCase = Type.Object({
	schemaVersion: Type.Literal(1),
	caseId: NonEmptyString,
	runId: NonEmptyString,
	nodeId: NonEmptyString,
	attemptId: NonEmptyString,
	agentId: NonEmptyString,
	role: NonEmptyString,
	status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]),
	capturedAt: NonEmptyString,
	capabilitySnapshotId: Type.Optional(Type.String()),
}, Open);

const VariantRequest = Type.Object({
	promptMode: Type.Optional(Type.Union([Type.Literal("observed"), Type.Literal("override")])),
	promptOverride: Type.Optional(PromptOverride),
	capabilitySnapshotId: Type.Optional(NonEmptyString),
	expectedRuntimeBuild: Type.Optional(NonEmptyString),
	expectedAgentBundleSha256: Type.Optional(NonEmptyString),
}, Closed);

/** Candidate Replay 请求；Replay 只消费历史 Case，不接受直接输入。 */
const ReplayRequest = Type.Object({
	agentId: NonEmptyString,
	cases: Type.Array(CaseRef, { minItems: 1 }),
	candidate: VariantRequest,
	repetitions: Type.Optional(Type.Integer({ minimum: 1 })),
	rubricId: NonEmptyString,
}, Closed);

/** Bundle tar 的路径。必须落在启动时配置的 Exchange Root 内，不接受任意绝对路径。 */
const BundleImportRequest = Type.Object({
	path: NonEmptyString,
}, Closed);

const OperationsStatus = Type.Object({
	ok: Type.Literal(true),
	protocolVersion: Type.Integer({ minimum: 1 }),
	schemaHash: Sha256,
	mode: Type.Union([Type.Literal("capture"), Type.Literal("eval")]),
	writable: Type.Boolean(),
	active: Count,
	queued: Count,
	concurrency: Type.Integer({ minimum: 1 }),
	recipes: Type.Array(Type.String()),
	runtimeBuild: Type.String(),
	runtimeBuildMatchesDisk: Type.Boolean(),
	agentBundleSha256: Type.String(),
	/** 正式 Capture 是 fail-open 的，失败只出现在这里，不改变产品结果。 */
	capture: Type.Object({
		enabled: Type.Boolean(),
		failures: Count,
		recent: Type.Array(Type.Object({
			node: NonEmptyString,
			reason: Type.String(),
			at: NonEmptyString,
		}, Closed)),
		/** Case 保留策略的实际执行情况；评估环境据此知道一个 Case 还会不会在。 */
		retention: Type.Object({
			enabled: Type.Boolean(),
			maxAgeDays: Amount,
			maxBytes: Amount,
			lastSweepAt: Type.Optional(NonEmptyString),
			cases: Count,
			bytes: Amount,
			deletedByAge: Count,
			deletedBySize: Count,
			protectedActive: Count,
			protectedExporting: Count,
			warnings: Type.Array(Type.String()),
		}, Closed),
	}, Closed),
}, Closed);

/** 盲评一侧的输出投影。目录 Artifact 给文件清单，小文件直接内联。 */
const EvaluationArtifact = Type.Object({
	sha256: Sha256,
	byteLength: Count,
	directory: Type.Boolean(),
	content: Type.Optional(Type.String()),
	files: Type.Optional(Type.Array(Type.Object({
		relativePath: NonEmptyString,
		sha256: Sha256,
		byteLength: Count,
	}, Closed))),
}, Closed);

const EvaluationInput = Type.Object({
	userPrompt: Type.String(),
	sha256: Sha256,
	byteLength: Count,
	files: Type.Array(Type.Object({
		relativePath: NonEmptyString,
		sha256: Sha256,
		byteLength: Count,
		content: Type.Optional(Type.String()),
	}, Closed)),
}, Closed);

const ErrorResponse = Type.Object({ error: Type.String() }, Open);

export const SCHEMAS = {
	CaseRef,
	EvaluationCase,
	ExecutionRefs,
	ExecutionArtifact,
	ExecutionMetrics,
	Execution,
	ActiveExecution,
	Pair,
	AggregateMetrics,
	ResolvedCandidate,
	CandidateReplayRun,
	EvaluationInput,
	EvaluationArtifact,
	OperationsStatus,
	ReplayRequest,
	BundleImportRequest,
	CaseListResponse: Type.Object({
		ok: Type.Literal(true),
		cases: Type.Array(Type.Object({ ref: CaseRef, value: EvaluationCase }, Closed)),
	}, Closed),
	CaseResponse: Type.Object({ ok: Type.Literal(true), case: EvaluationCase }, Closed),
	CaseFileListResponse: Type.Object({
		ok: Type.Literal(true),
		files: Type.Array(Type.Object({
			ref: NonEmptyString,
			kind: NonEmptyString,
			sha256: Sha256,
			byteLength: Count,
		}, Closed)),
	}, Closed),
	CapabilitySnapshotResponse: Type.Object({
		ok: Type.Literal(true),
		snapshot: Type.Object({
			schemaVersion: Type.Literal(1),
			id: NonEmptyString,
			goalId: NonEmptyString,
			workspaceContentHash: NonEmptyString,
			createdAt: NonEmptyString,
			ref: NonEmptyString,
		}, Closed),
	}, Closed),
	ReplayRunResponse: Type.Object({ ok: Type.Literal(true), run: CandidateReplayRun }, Closed),
	BundleImportResponse: Type.Object({
		ok: Type.Literal(true),
		goalId: NonEmptyString,
		caseRef: CaseRef,
		bundleSha256: Sha256,
		capabilitySnapshotId: Type.Union([NonEmptyString, Type.Null()]),
	}, Closed),
	EvaluationBatchResponse: Type.Object({
		ok: Type.Literal(true),
		batch: Type.Object({
			runId: NonEmptyString,
			agentId: NonEmptyString,
			rubricId: NonEmptyString,
			pairs: Type.Array(Type.Object({
				pairId: NonEmptyString,
				caseRef: CaseRef,
				repetition: Type.Integer({ minimum: 1 }),
				input: EvaluationInput,
				outputs: Type.Object({
					A: EvaluationArtifact,
					B: EvaluationArtifact,
				}, Closed),
			}, Closed)),
		}, Closed),
	}, Closed),
	ErrorResponse,
} satisfies Record<string, TSchema>;

export type SchemaName = keyof typeof SCHEMAS;

export interface OperationsRoute {
	readonly method: "get" | "post";
	/** OpenAPI 风格路径；Express 路径由 `expressPath()` 派生。 */
	readonly path: string;
	readonly operationId: string;
	readonly summary: string;
	/** `read` 在 Capture 和 Eval 模式都暴露；`write` 只在 Eval 模式暴露。 */
	readonly access: "read" | "write";
	readonly requestSchema?: SchemaName;
	readonly responseSchema?: SchemaName;
	/** 成功响应的 HTTP 状态码；默认 200。 */
	readonly successStatus?: number;
	/** 直接回传文件，没有 JSON 响应 Schema。 */
	readonly binary?: true;
	readonly query?: readonly { readonly name: string; readonly required?: true }[];
}

export const OPERATIONS_ROUTES = [
	{
		method: "get", path: "/status", operationId: "getStatus", access: "read",
		summary: "Protocol handshake and Replay queue status", responseSchema: "OperationsStatus",
	},
	{
		method: "get", path: "/goals/{goalId}/cases", operationId: "listCases", access: "read",
		summary: "List captured Cases for a Goal", responseSchema: "CaseListResponse",
		query: [{ name: "agentId" }, { name: "limit" }],
	},
	{
		method: "get", path: "/goals/{goalId}/cases/{sourceRunId}/{caseId}", operationId: "readCase", access: "read",
		summary: "Read one Case manifest", responseSchema: "CaseResponse",
	},
	{
		method: "get", path: "/goals/{goalId}/cases/{sourceRunId}/{caseId}/files", operationId: "listCaseFiles",
		access: "read", summary: "List the Evidence files of one Case", responseSchema: "CaseFileListResponse",
	},
	{
		method: "get", path: "/goals/{goalId}/cases/{sourceRunId}/{caseId}/file", operationId: "readCaseFile",
		access: "read", summary: "Read one Evidence file of a Case by ref", binary: true,
		query: [{ name: "ref", required: true }],
	},
	{
		method: "get", path: "/goals/{goalId}/cases/{sourceRunId}/{caseId}/bundle", operationId: "exportCaseBundle",
		access: "read", summary: "Export a Case Bundle tar", binary: true,
	},
	{
		method: "get", path: "/goals/{goalId}/cases/{sourceRunId}/{caseId}/provider-children/{executionId}/bundle",
		operationId: "exportProviderChildCaseBundle", access: "read",
		summary: "Export one Provider Child as a self-contained Case Bundle", binary: true,
	},
	{
		method: "post", path: "/bundles/import", operationId: "importBundle", access: "write",
		summary: "Import a Case Bundle tar from the configured Exchange Root",
		requestSchema: "BundleImportRequest", responseSchema: "BundleImportResponse",
	},
	{
		method: "get", path: "/goals/{goalId}/capability-snapshots/{snapshotId}", operationId: "readCapabilitySnapshot",
		access: "write", summary: "Read a Capability Snapshot manifest", responseSchema: "CapabilitySnapshotResponse",
	},
	{
		method: "post", path: "/goals/{goalId}/replays", operationId: "startReplay", access: "write",
		summary: "Queue a Candidate Replay", requestSchema: "ReplayRequest", responseSchema: "ReplayRunResponse",
		successStatus: 202,
	},
	{
		method: "get", path: "/goals/{goalId}/replays/{runId}", operationId: "readReplay", access: "write",
		summary: "Read a Replay Run", responseSchema: "ReplayRunResponse",
	},
	{
		method: "get", path: "/goals/{goalId}/replays/{runId}/files", operationId: "readReplayFile", access: "write",
		summary: "Read one Trace or Artifact file of a Replay Run", binary: true,
		query: [{ name: "ref", required: true }],
	},
	{
		method: "get", path: "/goals/{goalId}/replays/{runId}/evaluation-batch", operationId: "readEvaluationBatch",
		access: "write", summary: "Read the blind A/B batch of a Replay Run", responseSchema: "EvaluationBatchResponse",
	},
	{
		method: "get", path: "/goals/{goalId}/replays/{runId}/evaluation-batch/{pairId}/outputs/{label}/artifact",
		operationId: "readEvaluationOutputArtifact", access: "write",
		summary: "Read one blind A/B output artifact", binary: true, query: [{ name: "file" }],
	},
	{
		method: "get", path: "/goals/{goalId}/replays/{runId}/executions/{executionId}/artifact",
		operationId: "readExecutionArtifact", access: "write",
		summary: "Read one execution artifact of a Replay Run", binary: true, query: [{ name: "file" }],
	},
	{
		method: "post", path: "/goals/{goalId}/replays/{runId}/cancel", operationId: "cancelReplay", access: "write",
		summary: "Cancel a Replay Run", responseSchema: "ReplayRunResponse",
	},
] as const satisfies readonly OperationsRoute[];

/** 路由表里存在的全部 operationId；Router 必须为每一个提供 Handler。 */
export type OperationsOperationId = (typeof OPERATIONS_ROUTES)[number]["operationId"];

/** `/goals/{goalId}/cases` -> `/goals/:goalId/cases` */
export function expressPath(route: OperationsRoute): string {
	return `${OPERATIONS_BASE_PATH}${route.path.replaceAll(/\{(\w+)\}/gu, ":$1")}`;
}

export function routesForMode(mode: "capture" | "eval"): readonly (typeof OPERATIONS_ROUTES)[number][] {
	return OPERATIONS_ROUTES.filter((route) => mode === "eval" || route.access === "read");
}

/**
 * 契约指纹。覆盖协议版本、全部 Schema 和路由表，任一变化都会改变结果，
 * 因此评估环境只比对 `protocolVersion` 和 `schemaHash` 就能发现漂移。
 */
export const OPERATIONS_SCHEMA_HASH = sha256(canonicalJson({
		protocolVersion: OPERATIONS_PROTOCOL_VERSION,
		basePath: OPERATIONS_BASE_PATH,
		routes: OPERATIONS_ROUTES,
		schemas: SCHEMAS,
	}));

/** 键按字典序排列的 JSON，保证不同 TypeBox 构造顺序得到同一个 Hash。 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>).sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const compiled = new Map<SchemaName, ValidateFunction>();

/**
 * Trust boundary: every Operations request body is validated before it reaches the service,
 * and every JSON success response is validated before it leaves the Operations Listener.
 */
export function validateOperations(name: SchemaName, value: unknown): void {
	const validate = compiled.get(name) ?? ajv.compile(SCHEMAS[name]);
	compiled.set(name, validate);
	if (validate(value)) return;
	const errors = (validate.errors ?? []).slice(0, 20)
		.map((error) => `${error.instancePath || "/"}: ${error.message ?? error.keyword}`);
	throw new Error(`${name} is invalid: ${errors.join("; ")}`);
}
