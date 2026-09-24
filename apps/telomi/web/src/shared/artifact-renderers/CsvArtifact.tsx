import { useMemo } from "react";
import Papa from "papaparse";
import { uiText } from "@/app/ui-text";

const TABLE_FRAME =
	"overflow-auto rounded-[8px] border border-[var(--border)] bg-[var(--background)] max-h-[600px]";
const TABLE_CELLS =
	"[&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-[var(--foreground)] [&_th]:whitespace-nowrap [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1 [&_td]:text-left [&_td]:text-[var(--foreground)] [&_td]:whitespace-nowrap [&_thead_th]:bg-[var(--muted)] [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]";

export function CsvArtifact({
	content,
	delimiter,
}: { content: string; delimiter: "," | "\t" }) {
	const parsed = useMemo(() => {
		const result = Papa.parse<string[]>(content, {
			delimiter,
			skipEmptyLines: true,
		});
		return result.data;
	}, [content, delimiter]);

	if (parsed.length === 0) {
		return (
			<div className="italic text-[0.82rem] text-[var(--foreground-50)] py-2">
				{uiText("artifacts.csvartifact.emptyFile")}
			</div>
		);
	}

	const [header, ...rows] = parsed;

	return (
		<div className={TABLE_FRAME}>
			<table
				className={`w-full border-collapse text-[0.78rem] ${TABLE_CELLS}`}
			>
				<thead>
					<tr>
						{header.map((cell, i) => (
							<th key={`h-${i}`} scope="col">{cell}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, ri) => (
						<tr key={`r-${ri}`}>
							{row.map((cell, ci) => (
								<td key={`c-${ri}-${ci}`}>{cell}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
