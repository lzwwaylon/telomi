import { useMemo } from "react";
import { uiText } from "@/app/ui-text";

interface Column {
	key: string;
	label: string;
}

interface Spreadsheet {
	title?: string;
	columns: Column[];
	rows: Record<string, unknown>[];
}

const TABLE_FRAME =
	"overflow-auto rounded-[8px] border border-[var(--border)] bg-[var(--background)] max-h-[600px]";
const TABLE_CELLS =
	"[&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-[var(--foreground)] [&_th]:whitespace-nowrap [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1 [&_td]:text-left [&_td]:text-[var(--foreground)] [&_td]:whitespace-nowrap [&_thead_th]:bg-[var(--muted)] [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]";

const GRID_HEADER_CELL =
	"!bg-[var(--foreground-10)] !text-[var(--foreground-50)] !font-semibold !text-center";
const GRID_ROW_NUM = `${GRID_HEADER_CELL} min-w-[40px] select-none`;
const GRID_COL_LETTER = `${GRID_HEADER_CELL} !text-[0.7rem]`;

function colLetter(index: number): string {
	let n = index;
	let result = "";
	while (n >= 0) {
		result = String.fromCharCode(65 + (n % 26)) + result;
		n = Math.floor(n / 26) - 1;
	}
	return result;
}

export function SpreadsheetArtifact({ content }: { content: string }) {
	const parsed = useMemo<{ ok: true; data: Spreadsheet } | { ok: false; error: string }>(() => {
		try {
			const data = JSON.parse(content);
			if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
				return { ok: false, error: uiText("common.invalidFormatExpectedColumnsRows") };
			}
			return { ok: true, data };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}, [content]);

	if (!parsed.ok) {
		return (
			<div className="rounded-[8px] border border-[color-mix(in_oklab,var(--destructive)_22%,var(--border))] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] px-2.5 py-2 text-[0.78rem] text-[color-mix(in_oklab,var(--destructive)_70%,var(--foreground))]">
{uiText("artifacts.spreadsheetartifact.spreadsheetParsingFailed")} {parsed.error}
			</div>
		);
	}

	const { title, columns, rows } = parsed.data;

	return (
		<div className="flex flex-col gap-2">
			{title && (
				<h3 className="m-0 text-[0.95rem] text-[var(--foreground)]">{title}</h3>
			)}
			<div className={TABLE_FRAME}>
				<table className={`w-full border-collapse text-[0.78rem] ${TABLE_CELLS}`}>
					<thead>
						<tr>
							<th className={GRID_HEADER_CELL} scope="col" aria-label={uiText("common.rowNumber")} />
							{columns.map((col, i) => (
								<th key={col.key} scope="col" className={GRID_COL_LETTER}>
									<div>{colLetter(i)}</div>
									<div className="text-[0.68rem] font-normal text-[var(--foreground-50)]">{col.label}</div>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, ri) => (
							<tr key={`r-${ri}`}>
								<th scope="row" className={GRID_ROW_NUM}>{ri + 1}</th>
								{columns.map((col) => (
									<td key={col.key}>{String(row[col.key] ?? "")}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
