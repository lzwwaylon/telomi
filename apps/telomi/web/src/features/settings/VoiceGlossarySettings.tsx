import { voiceApi } from "@/features/voice/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { PlusIcon as Plus } from "@/shared/ui/icons";
import {
	type VoiceGlossaryEntry,
	type VoiceGlossarySnapshot,
} from "@shared/voice-stt.js";
import { uiText } from "@/app/ui-text";
import { downloadJson } from "@/shared/lib/download";

const BUTTON =
	"inline-flex items-center justify-center gap-1.5 rounded-[0.5rem] border border-border bg-card px-3 py-1.5 text-[0.82rem] text-foreground transition-colors hover:bg-[var(--foreground-5)] disabled:opacity-50 disabled:cursor-not-allowed";
const INPUT =
	"w-full rounded-[0.5rem] border border-border bg-popover px-3 py-1.5 text-[0.85rem] text-foreground outline-none transition-colors focus-visible:border-[var(--input)] disabled:opacity-50";

interface GlossaryImportPreview {
	entries: VoiceGlossaryEntry[];
	importedCount: number;
	addedCount: number;
	duplicateCount: number;
}

export function VoiceGlossarySettings() {
	const [snapshot, setSnapshot] = useState<VoiceGlossarySnapshot | null>(null);
	const [entries, setEntries] = useState<VoiceGlossaryEntry[]>([]);
	const [canonicalDraft, setCanonicalDraft] = useState("");
	const [importDraft, setImportDraft] = useState("");
	const [importPreview, setImportPreview] =
		useState<GlossaryImportPreview | null>(null);
	const [saving, setSaving] = useState(false);
	const [autoLearnEnabled, setAutoLearnEnabled] = useState(true);
	const [savingAutoLearn, setSavingAutoLearn] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const next = await voiceApi.glossary.load();
			setSnapshot(next);
			setEntries(next.entries);
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : String(loadError));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		voiceApi.correctionLearning.load()
			.then((data) => {
				setAutoLearnEnabled(Boolean(data.enabled));
			})
			.catch((loadError) =>
				setError(
					loadError instanceof Error ? loadError.message : String(loadError),
				),
			);
	}, []);

	const dirty = useMemo(
		() => snapshot !== null && JSON.stringify(snapshot.entries) !== JSON.stringify(entries),
		[snapshot, entries],
	);

	const save = useCallback(async (nextEntries = entries) => {
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const next = await voiceApi.glossary.save(nextEntries);
			setSnapshot(next);
			setEntries(next.entries);
			setNotice(uiText("settings.voiceglossarysettings.savedCountTerms", { count: next.entries.length }));
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : String(saveError));
		} finally {
			setSaving(false);
		}
	}, [entries]);

	const addEntry = () => {
		const canonical = canonicalDraft.trim();
		if (!canonical) return;
		const key = canonical.toLocaleLowerCase();
		const existing = entries.find(
			(entry) => entry.canonical.toLocaleLowerCase() === key,
		);
		if (existing?.source === "learned") {
			setEntries((current) =>
				current.map((entry) =>
					entry.id === existing.id
						? { ...entry, source: "manual" }
						: entry,
				),
			);
			setCanonicalDraft("");
			setError(null);
			setNotice(uiText("settings.voiceglossarysettings.theLearnedTermWasPromotedToAManualTerm"));
			return;
		}
		if (existing) {
			setError(uiText("settings.voiceglossarysettings.termAlreadyExistsTerm", { term: canonical }));
			return;
		}
		const id = newGlossaryId();
		setEntries((current) => [
			...current,
			{
				id,
				canonical,
				enabled: true,
				source: "manual",
			},
		]);
		setCanonicalDraft("");
		setError(null);
		setNotice(uiText("settings.voiceglossarysettings.termAddedToTheDraftSaveTheGlossaryTo"));
	};

	const toggleAutoLearn = async (enabled: boolean) => {
		setSavingAutoLearn(true);
		setError(null);
		try {
			const data = await voiceApi.correctionLearning.setEnabled(enabled);
			setAutoLearnEnabled(Boolean(data.enabled));
			setNotice(
				data.enabled
					? uiText("settings.voiceglossarysettings.voiceDraftCorrectionLearningEnabled")
					: uiText("settings.voiceglossarysettings.voiceDraftCorrectionLearningDisabled"),
			);
		} catch (saveError) {
			setError(
				saveError instanceof Error ? saveError.message : String(saveError),
			);
		} finally {
			setSavingAutoLearn(false);
		}
	};

	const importEntries = () => {
		try {
			const imported = parseImport(importDraft);
			let addedCount = 0;
			const byCanonical = new Map(
				entries.map((entry) => [
					entry.canonical.toLocaleLowerCase(),
					entry,
				]),
			);
			for (const entry of imported) {
				const key = entry.canonical.toLocaleLowerCase();
				if (!byCanonical.has(key)) {
					byCanonical.set(key, entry);
					addedCount += 1;
				}
			}
			const next = [...byCanonical.values()];
			setImportPreview({
				entries: next,
				importedCount: imported.length,
				addedCount,
				duplicateCount: imported.length - addedCount,
			});
			setError(null);
			setNotice(null);
		} catch (importError) {
			setImportPreview(null);
			setError(importError instanceof Error ? importError.message : String(importError));
		}
	};

	const confirmImport = () => {
		if (!importPreview) return;
		setEntries(importPreview.entries);
		setImportDraft("");
		setImportPreview(null);
		setNotice(
			uiText("settings.voiceglossarysettings.mergedCountRowsSaveTheGlossaryToApplyThem", { count: importPreview.importedCount }),
		);
	};

	const exportGlossary = () => {
		downloadJson("telomi-voice-glossary.json", entries);
	};

	return (
		<div className="grid gap-4 rounded-[0.55rem] border border-border bg-card px-3 py-3" data-testid="voice-glossary-settings">
			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 max-[560px]:grid-cols-1">
				<div className="grid gap-1">
					<h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.voiceglossarysettings.customVocabulary")}</h3>
					<p className="m-0 text-[0.8rem] leading-relaxed text-muted-foreground">
						{uiText("settings.voiceglossarysettings.termsAreSuppliedAsKeywordHintsToBatchStt")}
					</p>
					{snapshot && (
						<span className="text-[0.72rem] font-mono text-muted-foreground">
							revision {snapshot.revision} · {uiText("settings.voiceglossarysettings.countEntries", { count: entries.length })}
						</span>
					)}
					<label className="mt-1 inline-flex items-start gap-2 text-[0.78rem] leading-relaxed text-muted-foreground">
						<input
							type="checkbox"
							checked={autoLearnEnabled}
							disabled={savingAutoLearn}
							onChange={(event) =>
								void toggleAutoLearn(event.target.checked)
							}
							data-testid="voice-correction-learning-toggle"
						/>
						<span>
							{uiText("settings.voiceglossarysettings.automaticallyLearnWordSpellingCorrectionsMadeToAVoice")}
						</span>
					</label>
				</div>
				<div className="flex gap-2">
					<button type="button" className={BUTTON} onClick={exportGlossary} disabled={entries.length === 0}>
						{uiText("common.exportJson")}
					</button>
					<button
						type="button"
						className={BUTTON}
						onClick={() => void save()}
						disabled={!dirty || saving}
						data-testid="voice-glossary-save"
					>
						{saving ? uiText("common.saving") : uiText("settings.voiceglossarysettings.saveVocabulary")}
					</button>
				</div>
			</div>

			<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 max-[640px]:grid-cols-1">
				<input
					value={canonicalDraft}
					onChange={(event) => setCanonicalDraft(event.target.value)}
					placeholder={uiText("settings.voiceglossarysettings.termSuchAsKubernetes")}
					className={INPUT}
					// The field sits alone above the list with no visible label of its own.
					aria-label={uiText("settings.voiceglossarysettings.termSuchAsKubernetes")}
					data-testid="voice-glossary-canonical"
				/>
				<button
					type="button"
					className={BUTTON}
					onClick={addEntry}
					disabled={!canonicalDraft.trim()}
					data-testid="voice-glossary-add"
				>
					<Plus className="h-3.5 w-3.5" aria-hidden /> {uiText("common.add")}
				</button>
			</div>

			{entries.length === 0 ? (
				<div className="rounded-[0.5rem] bg-[var(--foreground-3)] px-3 py-3 text-[0.82rem] text-muted-foreground">
					{uiText("settings.voiceglossarysettings.theVocabularyIsEmptyAddProductNamesPeopleMedications")}
				</div>
			) : (
				<div className="grid gap-2">
					{entries.map((entry, index) => (
						<div
							key={entry.id}
							className="grid grid-cols-[auto_minmax(0,1fr)_2rem] items-center gap-2 rounded-[0.5rem] bg-[var(--foreground-3)] px-2.5 py-2"
						>
							<input
								type="checkbox"
								checked={entry.enabled}
								onChange={(event) => {
									const enabled = event.target.checked;
									setEntries((current) =>
										current.map((item, itemIndex) =>
											itemIndex === index ? { ...item, enabled } : item,
										),
									);
								}}
								aria-label={uiText("settings.voiceglossarysettings.enableTerm", { term: entry.canonical })}
							/>
							<div className="grid min-w-0 gap-1">
								<input
									value={entry.canonical}
									onChange={(event) => {
										const canonical = event.target.value;
										setEntries((current) =>
											current.map((item, itemIndex) =>
												itemIndex === index
													? { ...item, canonical, source: "manual" }
													: item,
											),
										);
									}}
									className={INPUT}
									aria-label={uiText("settings.voiceglossarysettings.termNumber", { number: index + 1 })}
								/>
								{entry.source === "learned" && (
									<span className="text-[0.68rem] text-muted-foreground">
										{uiText("settings.voiceglossarysettings.learned")}
									</span>
								)}
								{entry.source === "imported" && (
									<span className="text-[0.68rem] text-muted-foreground">
										{uiText("settings.voiceglossarysettings.imported")}
									</span>
								)}
							</div>
							<button
								type="button"
								className="inline-flex h-8 w-8 items-center justify-center rounded-[0.45rem] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
								onClick={() => setEntries((current) => current.filter((item) => item.id !== entry.id))}
								aria-label={uiText("settings.voiceglossarysettings.deleteTerm", { term: entry.canonical })}
								title={uiText("common.delete")}
							>
								<Trash2 className="h-3.5 w-3.5" aria-hidden />
							</button>
						</div>
					))}
				</div>
			)}

			<div className="grid gap-2 border-t border-border pt-3">
				<label className="text-[0.8rem] font-medium text-foreground" htmlFor="voice-glossary-import">
					{uiText("common.bulkImport")}
				</label>
				<textarea
					id="voice-glossary-import"
					value={importDraft}
					onChange={(event) => {
						setImportDraft(event.target.value);
						setImportPreview(null);
					}}
					rows={4}
					placeholder={uiText("settings.voiceglossarysettings.oneTermPerLineYouCanAlsoPasteAn")}
					className={`${INPUT} resize-y font-mono text-[0.78rem] leading-relaxed`}
					data-testid="voice-glossary-import"
				/>
				<div>
					<button
						type="button"
						className={BUTTON}
						onClick={importEntries}
						disabled={!importDraft.trim()}
						data-testid="voice-glossary-import-apply"
					>
						{uiText("settings.voiceglossarysettings.previewImport")}
					</button>
				</div>
				{importPreview && (
					<div
						className="grid gap-2 rounded-[0.5rem] bg-[var(--foreground-3)] px-3 py-2 text-[0.78rem] text-muted-foreground"
						role="status"
						data-testid="voice-glossary-import-preview"
					>
						<span>
							{uiText("settings.voiceglossarysettings.totalItemsAddedNewAndDuplicatesDuplicatesMerged", { total: importPreview.importedCount, added: importPreview.addedCount, duplicates: importPreview.duplicateCount })}
						</span>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								className={BUTTON}
								onClick={confirmImport}
								data-testid="voice-glossary-import-confirm"
							>
								{uiText("settings.voiceglossarysettings.confirmMerge")}
							</button>
							<button
								type="button"
								className={BUTTON}
								onClick={() => setImportPreview(null)}
							>
								{uiText("common.cancel")}
							</button>
						</div>
					</div>
				)}
			</div>

			{notice && <div className="text-[0.78rem] text-muted-foreground">{notice}</div>}
			{error && <div className="text-[0.78rem] text-destructive">{error}</div>}
		</div>
	);
}

function parseImport(value: string): VoiceGlossaryEntry[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!Array.isArray(parsed)) throw new Error(uiText("common.importedJsonMustBeAnArray"));
		return parsed.map((raw, index) => {
			if (typeof raw === "string") {
				return { id: newGlossaryId(), canonical: raw.trim(), enabled: true };
			}
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				throw new Error(uiText("settings.voiceglossarysettings.jsonItemNumberIsNotAVocabularyObject", { number: index + 1 }));
			}
			const record = raw as Record<string, unknown>;
			if (typeof record.canonical !== "string" || !record.canonical.trim()) {
				throw new Error(uiText("settings.voiceglossarysettings.jsonItemNumberIsMissingCanonical", { number: index + 1 }));
			}
			return {
				id: typeof record.id === "string" && record.id ? record.id : newGlossaryId(),
				canonical: record.canonical.trim(),
				...(typeof record.language === "string" ? { language: record.language } : {}),
				enabled: record.enabled === undefined ? true : Boolean(record.enabled),
				source: "imported",
			};
		});
	}

	return trimmed.split(/\r?\n/).flatMap((line, index) => {
		const clean = line.trim();
		if (!clean || clean.startsWith("#")) return [];
		const [canonicalPart] = clean.split(/\s*[|\t]\s*/, 1);
		const canonical = canonicalPart?.trim() ?? "";
		if (!canonical) throw new Error(uiText("settings.voiceglossarysettings.lineNumberIsMissingACanonicalTerm", { number: index + 1 }));
		return [{
			id: newGlossaryId(),
			canonical,
			enabled: true,
			source: "imported",
		}];
	});
}

function newGlossaryId(): string {
	return `term_${crypto.randomUUID?.().replace(/-/g, "") ?? `${Date.now()}${Math.random().toString(36).slice(2)}`}`;
}
