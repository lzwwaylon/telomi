import { Type, type Static } from "@sinclair/typebox";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { validateJsonSchema } from "../../agent-runtime/structured-output.js";
import { safeRegularFile } from "../../agent-runtime/artifact-store.js";
import type { ExecutableReportPlan, ExecutableReportSection } from "./report-plan.js";
import { toErrorMessage } from "../../lib/values.js";

const NonEmptyString = Type.String({ minLength: 1 });

export const WriterSectionOutputSchema = Type.Object({
	section_id: NonEmptyString,
	body_markdown: NonEmptyString,
}, { additionalProperties: false });

export const WriterOutputSchema = Type.Object({
	schema_version: Type.Literal(1),
	sections: Type.Array(WriterSectionOutputSchema, { minItems: 1 }),
}, { additionalProperties: false });

export const WriterChapterManifestSchema = Type.Object({
	schema_version: Type.Literal(1),
	sections: Type.Array(Type.Object({
		section_id: NonEmptyString,
		path: NonEmptyString,
		/**
		 * Writer 自定结构时，章节标题只存在于 Writer 手里，Runtime 没有事先的 Outline 可对。
		 * 收下它，Runtime 才能反推出 Plan 并继续做标题校验与编译。
		 */
		title: Type.Optional(NonEmptyString),
	}, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export type WriterOutput = Static<typeof WriterOutputSchema>;

export function validateWriterOutput(
	value: unknown,
	expectedSections: readonly ExecutableReportSection[],
): WriterOutput {
	validateJsonSchema(WriterOutputSchema, value, { stage: "report-writer:final-output", file: "writer-output/manifest.json" });
	const output = value as WriterOutput;
	const expectedIds = expectedSections.map((section) => section.section_id);
	const actualIds = output.sections.map((section) => section.section_id);
	if (new Set(actualIds).size !== actualIds.length) {
		throw writerViolation("writer-output/manifest.json", "sections[].section_id", "must contain unique Section IDs");
	}
	if (
		actualIds.length !== expectedIds.length
		|| expectedIds.some((sectionId) => !actualIds.includes(sectionId))
	) {
		throw writerViolation("writer-output/manifest.json", "sections[].section_id",
			`must match the assigned Section set; expected ${expectedIds.join(", ")}, received ${actualIds.join(", ")}`);
	}
	for (const [index, section] of output.sections.entries()) {
		if (!section.body_markdown.trim()) {
			throw writerViolation("writer-output/manifest.json", `sections[${index}].body_markdown`, "must be a non-empty string");
		}
		if (containsRuntimeOwnedHeading(section.body_markdown)) {
			throw writerViolation(`writer-output/sections/${section.section_id}.md`, "$", "must not contain a level 1 or 2 heading owned by Runtime");
		}
	}
	return output;
}

/**
 * 从 Writer 自己写的 manifest 反推 Executable Plan。用于"Prime Root 自定结构"这条路径：
 * 那里没有事先的 Outline，章节清单由 Writer 产出，Runtime 事后接住。
 */
export function planFromWriterManifest(manifestPath: string, title: string): ExecutableReportPlan {
	const manifest = readManifestJson(manifestPath, "Writer Chapter manifest");
	validateJsonSchema(WriterChapterManifestSchema, manifest, { stage: "report-writer:outline", file: "writer-output/manifest.json" });
	const value = manifest as Static<typeof WriterChapterManifestSchema>;
	const seen = new Set<string>();
	return {
		title,
		sections: value.sections.map((section, index) => {
			const expectedId = `section-${String(index + 1).padStart(3, "0")}`;
			if (section.section_id !== expectedId) {
				throw writerViolation("writer-output/manifest.json", `sections[${index}].section_id`, `must equal Runtime ID '${expectedId}', received '${section.section_id}'`);
			}
			if (seen.has(section.section_id)) throw writerViolation("writer-output/manifest.json", `sections[${index}].section_id`, `duplicates '${section.section_id}'`);
			seen.add(section.section_id);
			if (!section.title?.trim()) {
				throw writerViolation("writer-output/manifest.json", `sections[${index}].title`, "must be a non-empty string when Writer authors the structure");
			}
			return { section_id: section.section_id, title: section.title.trim(), claims: [] };
		}),
	};
}

export function validateWriterChapterOutput(
	manifestPath: string,
	expectedSections: readonly ExecutableReportSection[],
): WriterOutput {
	const manifest = readManifestJson(manifestPath, "Writer Chapter manifest");
	validateJsonSchema(WriterChapterManifestSchema, manifest, { stage: "report-writer:final-output", file: "writer-output/manifest.json" });
	const value = manifest as Static<typeof WriterChapterManifestSchema>;
	const outputRoot = dirname(manifestPath);
	const unexpected = readdirSync(outputRoot).filter((name) =>
		![".complete", "manifest.json", "outline.json", "prose-lint.txt", "runtime.json", "sections"].includes(name));
	if (unexpected.length > 0) throw writerViolation("writer-output", "$", `contains unexpected files ${unexpected.join(", ")}`);
	const expectedIds = expectedSections.map((section) => section.section_id);
	const actualIds = value.sections.map((section) => section.section_id);
	if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
		throw writerViolation("writer-output/manifest.json", "sections[].section_id", `order must match Outline; expected ${expectedIds.join(", ")}, received ${actualIds.join(", ")}`);
	}
	return validateWriterOutput({
		schema_version: 1,
		sections: value.sections.map((section) => {
			const expectedPath = `sections/${section.section_id}.md`;
			if (section.path !== expectedPath) {
				throw writerViolation("writer-output/manifest.json", `sections[${actualIds.indexOf(section.section_id)}].path`, `must equal '${expectedPath}', received '${section.path}'`);
			}
			return {
				section_id: section.section_id,
				body_markdown: readFileSync(safeRegularFile(join(outputRoot, expectedPath), `Writer Chapter '${section.section_id}'`), "utf-8"),
			};
		}),
	}, expectedSections);
}

function readManifestJson(path: string, label: string): unknown {
	const safe = safeRegularFile(path, label);
	try {
		return JSON.parse(readFileSync(safe, "utf-8")) as unknown;
	} catch (error) {
		throw writerViolation("writer-output/manifest.json", "$", `must be valid JSON: ${toErrorMessage(error)}`);
	}
}

function writerViolation(file: string, field: string, issue: string): Error {
	return new Error(`[report-writer:file-contract] file '${file}', field '${field}': ${issue}`);
}

function containsRuntimeOwnedHeading(markdown: string): boolean {
	const lines = markdown.split(/\r?\n/u);
	let fenced = false;
	let fenceCharacter = "";
	let previousContent = "";
	for (const line of lines) {
		const fence = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/u)?.[1];
		if (fence) {
			if (!fenced) {
				fenced = true;
				fenceCharacter = fence[0]!;
			} else if (fence[0] === fenceCharacter) {
				fenced = false;
				fenceCharacter = "";
			}
			continue;
		}
		if (fenced) continue;
		const structural = line.replace(
			/^[ \t]{0,3}(?:(?:>[ \t]*)|(?:(?:[-+*]|\d+[.)])[ \t]+))*/u,
			"",
		);
		if (/^#{1,2}(?:[ \t]+|$)/u.test(structural) || /^<h[12](?:\s|>)/iu.test(structural)) {
			return true;
		}
		if (previousContent && /^(?:=+|-+)[ \t]*$/u.test(structural)) return true;
		previousContent = structural.trim();
	}
	return false;
}

export function materializeWriterChapter(
	section: ExecutableReportSection,
	output: WriterOutput,
): string {
	const candidate = output.sections.find((item) => item.section_id === section.section_id);
	if (!candidate) throw new Error(`Writer Output is missing Section '${section.section_id}'`);
	return `## ${section.title}\n\n${candidate.body_markdown.trim()}\n`;
}
