import type { Nodes } from "mdast";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";

/**
 * Shared remark-math configuration for markdown rendering.
 *
 * We intentionally disable single-dollar inline math so currency strings
 * (e.g. $100, $2M–$4M) remain plain text.
 */
export const MARKDOWN_MATH_OPTIONS = {
  singleDollarTextMath: false,
} as const

const parser = unified().use(remarkParse).use(remarkGfm);

/** Accept TeX delimiters while keeping Markdown code literal. */
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  const codeRanges: Array<{ start: number; end: number }> = [];
  const paragraphs: Array<{ start: number; end: number; prefix: string }> = [];
  function collect(node: Nodes): void {
    if (node.type === "paragraph") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const lineStart = text.lastIndexOf("\n", start - 1) + 1;
        paragraphs.push({ start, end, prefix: text.slice(lineStart, start).replace(/[^\s>]/gu, " ") });
      }
    }
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) codeRanges.push({ start, end });
    } else if ("children" in node) {
      for (const child of node.children) collect(child);
    }
  }
  collect(parser.parse(text));
  return text.replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/gu,
    (match, inline: string | undefined, display: string | undefined, offset: number) => {
      if (codeRanges.some((range) => offset < range.end && offset + match.length > range.start)) return match;
      if (display === undefined) return `$$${inline}$$`;
      const paragraph = paragraphs.find((range) => offset >= range.start && offset < range.end);
      // Headings and table cells retain their inline structure.
      if (!paragraph) return `$$${display}$$`;
      const prefix = paragraph.prefix;
      const body = display.split("\n").map((line) => line.startsWith(prefix) ? line.slice(prefix.length) : line).join("\n").trim();
      return `\n${prefix}$$\n${prefix}${body.replaceAll("\n", `\n${prefix}`)}\n${prefix}$$\n${prefix}`;
    });
}
