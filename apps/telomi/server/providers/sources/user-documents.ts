import type { SourceDescriptor } from "../source-descriptors.js";

export const userDocuments: SourceDescriptor = {
	id: "user_documents",
	auth: "none",
	verify: "none",
	provider: {
		id: "user_documents",
		runtime: { kind: "source_service", minIntervalMs: 0, maxConcurrency: 4 },
		catalog: { implementationVersion: "workspace-documents-fastapi-v1", capability: "user-provided workspace documents", supportedContentTypes: ["application/pdf", "text/plain", "text/csv",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], fullTextAvailability: "full_text", credentialRequirement: "none",
			workerPython: { module: "tools.user_documents" },
			workerSkills: ["prime-user-documents-provider-skill"],
			reliabilityTier: 1, freshness: "static", costClass: "free", latencyClass: "low", capabilities: ["user_documents"],
			sourceClass: "workspace", queryContract: { input: "natural_language", schemaVersion: 1,
				instructions: [
					"Describe the facts or concepts to find in user-provided documents.",
					"Return shortlisted user-document candidates and their declared artifact paths from the assigned Provider child.",
				], examples: ["evaluation methodology and reported limitations"] },
			supportedFields: ["title", "url", "content", "artifact_path"], supportedFilters: [], evidenceTypes: ["user_document", "primary_document"], operations: ["document_read"] },
	},
};
