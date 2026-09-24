import { apiClient } from "@/shared/lib/api-client";
import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { uiText } from "@/app/ui-text";

interface ModelOption {
	id: string;
	name: string;
	provider?: string;
}

interface ModelPickerProps {
	/** Compound `<provider>/<modelId>`. */
	currentModelId?: string;
	onChange: (modelId: string) => Promise<void>;
	disabled?: boolean;
	connectionUnavailable?: boolean;
}

/**
 * Build the `<option value>` shown in the picker. Custom-provider models
 * may collide with built-in ids (e.g. openai-codex AND tabcode both have
 * `gpt-5.4-mini`), so we always emit `<provider>/<id>` when provider is
 * known and let the server parse it back.
 */
function optionValue(m: ModelOption): string {
	return m.provider ? `${m.provider}/${m.id}` : m.id;
}

// Settings can change `enabledModels` at any time, so we re-fetch on every
// mount and on the `mom:models-invalidate` window event (dispatched by
// SettingsPage when the user edits enabled models). A short in-memory cache
// keeps repeated mounts during the same session cheap, but it gets cleared
// the moment settings change.
let cachedModels: ModelOption[] | null = null;
let pendingFetch: Promise<ModelOption[]> | null = null;
const MODELS_INVALIDATE_EVENT = "mom:models-invalidate";

if (typeof window !== "undefined") {
	window.addEventListener(MODELS_INVALIDATE_EVENT, () => {
		cachedModels = null;
		pendingFetch = null;
	});
}

async function fetchModels(force = false): Promise<ModelOption[]> {
	if (force) {
		cachedModels = null;
		pendingFetch = null;
	}
	if (cachedModels) return cachedModels;
	if (pendingFetch) return pendingFetch;
	pendingFetch = (async () => {
		const data = await apiClient.get<{ models: ModelOption[] }>("/api/models");
		cachedModels = data.models;
		return data.models;
	})();
	try {
		return await pendingFetch;
	} finally {
		pendingFetch = null;
	}
}

export function ModelPicker({ currentModelId, onChange, disabled, connectionUnavailable }: ModelPickerProps) {
	const [models, setModels] = useState<ModelOption[]>(cachedModels ?? []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		const load = (force: boolean) => {
			fetchModels(force)
				.then((m) => {
					if (active) setModels(m);
				})
				.catch((err) => {
					if (active) setError(err instanceof Error ? err.message : String(err));
				});
		};
		load(false);
		const onInvalidate = () => load(true);
		window.addEventListener(MODELS_INVALIDATE_EVENT, onInvalidate);
		return () => {
			active = false;
			window.removeEventListener(MODELS_INVALIDATE_EVENT, onInvalidate);
		};
	}, []);

	const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
		const next = e.target.value;
		if (!next || next === currentModelId) return;
		setBusy(true);
		setError(null);
		try {
			await onChange(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const value = currentModelId ?? "";
	const known = value && models.some((m) => optionValue(m) === value);

	// Group by provider so users can visually scan custom and built-in models
	// in the dropdown. Single-provider configs (most users on day 1) collapse to a
	// flat list with no group header — matches the pre-custom-providers UX.
	const grouped = (() => {
		const map = new Map<string, ModelOption[]>();
		for (const m of models) {
			const key = m.provider ?? "";
			let bag = map.get(key);
			if (!bag) {
				bag = [];
				map.set(key, bag);
			}
			bag.push(m);
		}
		return map;
	})();
	const useOptgroups = grouped.size > 1;

	return (
		<span
			className="relative inline-flex flex-none items-center"
			title={error ?? (connectionUnavailable ? uiText("settings.modelpicker.connectionUnavailable") : undefined)}
		>
			<Cpu
				className={cn(
					"absolute left-[0.5rem] top-1/2 -translate-y-1/2 h-[0.95rem] w-[0.95rem] @max-[420px]:left-1/2 @max-[420px]:-translate-x-1/2 max-[520px]:left-1/2 max-[520px]:-translate-x-1/2 text-[var(--foreground-50)] pointer-events-none",
					connectionUnavailable && "text-[var(--destructive)]",
				)}
				aria-hidden
			/>
			<select
				className={cn(
					"appearance-none h-7 bg-transparent text-[var(--foreground-50)] border border-transparent rounded-[6px] pr-[1.1rem] pl-[1.6rem] font-[inherit] text-[13px] leading-[1.1] cursor-pointer max-w-[180px] @max-[420px]:h-9 @max-[420px]:w-9 @max-[420px]:p-0 @max-[420px]:text-transparent max-[520px]:!h-[44px] max-[520px]:!w-[44px] max-[520px]:!p-0 max-[520px]:text-transparent overflow-hidden text-ellipsis transition-colors duration-[120ms] ease-[ease] [&:hover:not(:disabled)]:text-[var(--foreground)] @max-[420px]:[&:hover:not(:disabled)]:text-transparent max-[520px]:[&:hover:not(:disabled)]:text-transparent [&:hover:not(:disabled)]:bg-[var(--foreground-5)] focus-visible:outline-2 focus-visible:outline-[var(--input)] focus-visible:outline-offset-1 disabled:opacity-50 disabled:cursor-default",
					connectionUnavailable && "text-[var(--destructive)]",
				)}
				value={value}
				onChange={handleChange}
				disabled={disabled || busy || models.length === 0}
				aria-label={uiText("common.model")}
				aria-busy={busy}
			>
				{!known && value && <option value={value}>{value}</option>}
				{useOptgroups
					? Array.from(grouped.entries()).map(([provider, items]) => (
							<optgroup key={provider || "(unknown)"} label={provider || uiText("settings.modelpicker.unknown")}>
								{items.map((m) => (
									<option key={optionValue(m)} value={optionValue(m)}>
										{m.name}
									</option>
								))}
							</optgroup>
					  ))
					: models.map((m) => (
							<option key={optionValue(m)} value={optionValue(m)}>
								{m.name}
							</option>
					  ))}
			</select>
			<span
				className="absolute right-[0.35rem] top-1/2 -translate-y-1/2 text-[0.55rem] text-[var(--foreground-30)] pointer-events-none @max-[420px]:hidden max-[520px]:hidden"
				aria-hidden
			>
				▾
			</span>
		</span>
	);
}
