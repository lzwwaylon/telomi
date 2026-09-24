import { apiClient } from "@/shared/lib/api-client";
import { useEffect, useState } from "react";
import ExcelJS, { type CellValue, type Worksheet } from "exceljs";
import { uiText } from "@/app/ui-text";

interface SheetData {
	name: string;
	rows: unknown[][];
}

const TABLE_FRAME =
	"overflow-auto rounded-[8px] border border-[var(--border)] bg-[var(--background)] max-h-[600px]";
const TABLE_CELLS =
	"[&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-[var(--foreground)] [&_th]:whitespace-nowrap [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1 [&_td]:text-left [&_td]:text-[var(--foreground)] [&_td]:whitespace-nowrap [&_thead_th]:bg-[var(--muted)] [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]";

const GRID_HEADER_CELL =
	"!bg-[var(--foreground-10)] !text-[var(--foreground-50)] !font-semibold !text-center";
const GRID_ROW_NUM = `${GRID_HEADER_CELL} min-w-[40px] select-none`;
const GRID_COL_LETTER = `${GRID_HEADER_CELL} !text-[0.7rem]`;

const TAB_BASE =
	"px-2.5 py-[3px] text-[0.75rem] rounded-full border border-[var(--border)] bg-[var(--background)] text-[var(--foreground-50)] cursor-pointer transition-colors hover:text-[var(--foreground)] hover:bg-[var(--foreground-3)]";
const TAB_ACTIVE =
	"!bg-[color-mix(in_oklch,var(--accent)_5%,transparent)] !border-[color-mix(in_oklch,var(--accent)_20%,transparent)] !text-[var(--accent)] font-medium";

function colLetter(index: number): string {
	let n = index;
	let result = "";
	while (n >= 0) {
		result = String.fromCharCode(65 + (n % 26)) + result;
		n = Math.floor(n / 26) - 1;
	}
	return result;
}

export function XlsxArtifact({ url }: { url: string }) {
	const [sheets, setSheets] = useState<SheetData[]>([]);
	const [active, setActive] = useState<number>(0);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				// ExcelJS consumes the workbook as a binary ArrayBuffer.
				const resp = await apiClient.response(url);
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
				const buf = await resp.arrayBuffer();
				const workbook = new ExcelJS.Workbook();
				await workbook.xlsx.load(buf as unknown as Parameters<typeof workbook.xlsx.load>[0]);
				const data: SheetData[] = workbook.worksheets.map((sheet) => ({ name: sheet.name, rows: worksheetRows(sheet) }));
				if (!cancelled) {
					setSheets(data);
					setActive(0);
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url]);

	if (error)
		return (
			<div className="rounded-[8px] border border-[color-mix(in_oklab,var(--destructive)_22%,var(--border))] bg-[color-mix(in_oklab,var(--destructive)_5%,var(--background))] px-2.5 py-2 text-[0.78rem] text-[color-mix(in_oklab,var(--destructive)_70%,var(--foreground))]">
				{uiText("artifacts.xlsxartifact.failedToLoadXlsx")} {error}
			</div>
		);
	if (sheets.length === 0)
		return (
			<div className="italic text-[0.82rem] text-[var(--foreground-50)] py-2">
				{uiText("artifacts.xlsxartifact.loadingWorkbook")}
			</div>
		);

	const current = sheets[active];
	const maxCols = current.rows.reduce((max, row) => Math.max(max, row.length), 0);

	return (
		<div className="flex flex-col gap-2">
			{sheets.length > 1 && (
				<div className="flex flex-wrap gap-1.5 mb-1">
					{sheets.map((s, i) => (
						<button
							type="button"
							key={s.name}
							className={`${TAB_BASE}${i === active ? ` ${TAB_ACTIVE}` : ""}`}
							onClick={() => setActive(i)}
						>
							{s.name}
						</button>
					))}
				</div>
			)}
			<div className={TABLE_FRAME}>
				<table className={`w-full border-collapse text-[0.78rem] ${TABLE_CELLS}`}>
					<thead>
						<tr>
							<th className={GRID_HEADER_CELL} scope="col" aria-label={uiText("common.rowNumber")} />
							{Array.from({ length: maxCols }, (_, i) => (
								<th key={`c-${i}`} scope="col" className={GRID_COL_LETTER}>
									{colLetter(i)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{current.rows.map((row, ri) => (
							<tr key={`r-${ri}`}>
								<th scope="row" className={GRID_ROW_NUM}>{ri + 1}</th>
								{Array.from({ length: maxCols }, (_, ci) => (
									<td key={`c-${ri}-${ci}`}>{String(row[ci] ?? "")}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function worksheetRows(sheet: Worksheet): unknown[][] {
	const rows: unknown[][] = [];
	for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
		const row: unknown[] = [];
		for (let column = 1; column <= sheet.columnCount; column += 1) row.push(displayCellValue(sheet.getCell(rowNumber, column).value));
		while (row.length > 0 && row.at(-1) === "") row.pop();
		rows.push(row);
	}
	while (rows.length > 0 && rows.at(-1)?.length === 0) rows.pop();
	return rows;
}

function displayCellValue(value: CellValue): unknown {
	if (value == null) return "";
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== "object") return value;
	if ("result" in value && value.result !== undefined) return value.result;
	if ("richText" in value) return value.richText.map((part) => part.text).join("");
	if ("text" in value) return value.text;
	return JSON.stringify(value);
}
