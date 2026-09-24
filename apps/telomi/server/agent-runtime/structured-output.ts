import Ajv2020, { type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import type { Static, TSchema } from "@sinclair/typebox";

import { ResearchNodeError } from "./retry-policy.js";

const jsonSchemaValidator = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });

export function validateJsonSchema(
	schema: AnySchema,
	value: unknown,
	context?: { stage: string; file: string },
): void {
	const validate = jsonSchemaValidator.compile(schema);
	const valid = validate(value);
	const errors = valid ? [] : (validate.errors ?? []).slice(0, 20)
		.map(formatSchemaError);
	if (errors.length > 0) {
		const prefix = context
			? `[${context.stage}] file '${context.file}' has invalid fields`
			: "LLM response failed schema validation";
		throw new ResearchNodeError(`${prefix}: ${errors.join("; ")}`, "validation", true);
	}
}

/** Validate a value against a TypeBox schema and return it under the schema's static type. */
export function validateSchema<T extends TSchema>(schema: T, value: unknown): Static<T> {
	validateJsonSchema(schema, value);
	return value as Static<T>;
}

function formatSchemaError(error: ErrorObject): string {
	const path = error.instancePath || "/";
	if (error.keyword === "additionalProperties") {
		return `${path}: unexpected field '${String(error.params.additionalProperty)}'; additional properties are not allowed`;
	}
	if (error.keyword === "required") {
		return `${path === "/" ? "" : path}/${String(error.params.missingProperty)}: required field is missing`;
	}
	if (error.keyword === "enum") {
		return `${path}: must be one of ${JSON.stringify(error.params.allowedValues)}`;
	}
	if (error.keyword === "const") {
		return `${path}: must equal ${JSON.stringify(error.params.allowedValue)}`;
	}
	return `${path}: ${error.message ?? error.keyword}`;
}
