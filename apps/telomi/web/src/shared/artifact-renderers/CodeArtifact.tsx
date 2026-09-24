import { CodeBlock } from "@/shared/markdown/CodeBlock";
import { languageForArtifact } from "@/shared/artifact-preview/artifact-type";

export function CodeArtifact({
	filename,
	content,
	highlightLine,
}: {
	filename: string;
	content: string;
	highlightLine?: number;
}) {
	return (
		<CodeBlock
			code={content}
			language={languageForArtifact(filename)}
			showLineNumbers
			highlightLine={highlightLine}
			scrollToHighlight
		/>
	);
}
