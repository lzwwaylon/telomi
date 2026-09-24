import { formatDate } from "@/shared/lib/format";
import { useMemo, useState } from "react";
import { Input } from "@/shared/ui/input";
import { cn } from "@/shared/lib/utils";
import { currentUiLocale } from "@/app/i18n";
import { uiText } from "@/app/ui-text";

type ColumnType = "text" | "number" | "currency" | "percent" | "boolean" | "date" | "badge";

interface Column {
	key: string;
	label: string;
	type?: ColumnType;
}

interface Datatable {
	title?: string;
	columns: Column[];
	rows: Record<string, unknown>[];
}

const TABLE_FRAME =
	"overflow-auto rounded-[8px] border border-[var(--border)] bg-[var(--background)] max-h-[600px]";
const TABLE_CELLS =
	"[&_th]:border [&_th]:border-[var(--border)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-[var(--foreground)] [&_th]:whitespace-nowrap [&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1 [&_td]:text-left [&_td]:text-[var(--foreground)] [&_td]:whitespace-nowrap [&_thead_th]:bg-[var(--muted)] [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-[1]";

function formatCell(value: unknown, type?: ColumnType): string {
	if (value === null || value === undefined) return "";
	switch (type) {
		case "currency": {
			const n = Number(value);
			if (Number.isNaN(n)) return String(value);
			return n.toLocaleString(currentUiLocale(), { style: "currency", currency: "USD" });
		}
		case "percent": {
			const n = Number(value);
			if (Number.isNaN(n)) return String(value);
			return `${(n * 100).toFixed(2)}%`;
		}
		case "number": {
			const n = Number(value);
			if (Number.isNaN(n)) return String(value);
			return n.toLocaleString(currentUiLocale());
		}
		case "boolean":
			return value ? "✓" : "✗";
		case "date": {
			const d = new Date(value as string | number);
			return Number.isNaN(d.getTime()) ? String(value) : formatDate(d);
		}
		default:
			return String(value);
	}
}

/** Cells wrap within a bounded width instead of one line, for tables that hold prose such as search snippets. */
const WRAPPED_CELLS =
	"[&_td]:whitespace-normal [&_td]:min-w-[72px] [&_td]:max-w-[360px] [&_td]:break-words [&_td]:align-top";

export function DatatableArtifact({ content, wrapCells = false }: { content: string; wrapCells?: boolean }) {
	const [filter, setFilter] = useState("");
	const [sortKey, setSortKey] = useState<string | null>(null);
	const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

	const parsed = useMemo<{ ok: true; data: Datatable } | { ok: false; error: string }>(() => {
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
					{uiText("artifacts.datatableartifact.dataTableParsingFailed")} {parsed.error}
			</div>
		);
	}

	const { title, columns, rows } = parsed.data;

	const visible = useMemo(() => {
		const lower = filter.toLowerCase();
		const filtered = lower
			? rows.filter((row) =>
					columns.some((col) => String(row[col.key] ?? "").toLowerCase().includes(lower)),
				)
			: rows.slice();
		if (sortKey) {
			const col = columns.find((c) => c.key === sortKey);
			filtered.sort((a, b) => {
				const av = a[sortKey];
				const bv = b[sortKey];
				if (av == null && bv == null) return 0;
				if (av == null) return 1;
				if (bv == null) return -1;
				if (col?.type === "number" || col?.type === "currency" || col?.type === "percent") {
					return sortDir === "asc" ? Number(av) - Number(bv) : Number(bv) - Number(av);
				}
				return sortDir === "asc"
					? String(av).localeCompare(String(bv))
					: String(bv).localeCompare(String(av));
			});
		}
		return filtered;
	}, [rows, columns, filter, sortKey, sortDir]);

	return (
		<div className="flex flex-col gap-2">
			{title && (
				<h3 className="m-0 text-[0.95rem] text-[var(--foreground)]">{title}</h3>
			)}
			<Input
				type="text"
				className="h-auto rounded-[4px] border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[0.78rem] text-[var(--foreground)] max-w-[240px] shadow-none"
					placeholder={uiText("artifacts.datatableartifact.filter")}
					aria-label={uiText("artifacts.datatableartifact.filterDataTable")}
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
			/>
			<div className={TABLE_FRAME}>
				<table className={cn("w-full border-collapse text-[0.78rem]", TABLE_CELLS, wrapCells && WRAPPED_CELLS)}>
					<thead>
						<tr>
							{columns.map((col) => {
								const isSorted = sortKey === col.key;
								const ariaSort = isSorted
									? sortDir === "asc"
										? "ascending"
										: "descending"
									: "none";
								const nextDir = !isSorted
					? uiText("artifacts.datatableartifact.ascending")
									: sortDir === "asc"
						? uiText("artifacts.datatableartifact.descending")
						: uiText("artifacts.datatableartifact.ascending");
								return (
									<th
										key={col.key}
										scope="col"
										aria-sort={ariaSort}
										className="cursor-pointer select-none"
									>
										<button
											type="button"
											onClick={() => {
												if (sortKey === col.key) {
													setSortDir((d) => (d === "asc" ? "desc" : "asc"));
												} else {
													setSortKey(col.key);
													setSortDir("asc");
												}
											}}
							aria-label={uiText("artifacts.datatableartifact.sortByLabelCurrentlyCurrentClickToSwitchTo", { label: col.label, current:
								isSorted
									? sortDir === "asc"
										? uiText("artifacts.datatableartifact.ascending")
										: uiText("artifacts.datatableartifact.descending")
									: uiText("artifacts.datatableartifact.notSorted"), next: nextDir })}
											className="m-0 p-0 bg-transparent border-0 font-inherit text-inherit text-left w-full cursor-pointer"
										>
											{col.label}
											{isSorted && (
												<span aria-hidden="true">{sortDir === "asc" ? " ▲" : " ▼"}</span>
											)}
										</button>
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody>
						{visible.map((row, ri) => (
							<tr key={`r-${ri}`}>
								{columns.map((col) => {
									const formatted = formatCell(row[col.key], col.type);
									if (col.type === "badge") {
										return (
											<td key={col.key}>
												<span className="inline-block px-2 py-px rounded-full text-[0.72rem] bg-[color-mix(in_oklch,var(--accent)_5%,transparent)] text-[var(--accent)] border border-[color-mix(in_oklch,var(--accent)_20%,transparent)] font-medium">
													{formatted}
												</span>
											</td>
										);
									}
									return <td key={col.key}>{formatted}</td>;
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="text-[0.72rem] text-[var(--foreground-50)]" aria-live="polite">
				{uiText("artifacts.datatableartifact.visibleTotalRows", { visible: visible.length, total: rows.length })}
			</div>
		</div>
	);
}
