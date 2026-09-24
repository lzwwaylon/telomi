export { hashJson, sha256, stableJson } from "../../lib/hash.js";

export interface WikiSource {
	id: string;
	uri: string;
	sha256: string;
	provenance: string;
	contentPath: string;
	verifiedAt: string;
}
