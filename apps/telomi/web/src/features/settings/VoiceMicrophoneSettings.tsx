import { Loader2, Mic, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	getVoiceMicrophoneManager,
	type VoiceMicrophoneManager,
	type VoiceMicrophonePreference,
	type VoiceMicrophoneSnapshot,
} from "@/features/voice/VoiceMicrophoneManager";
import { uiText } from "@/app/ui-text";

const SELECT_CLS =
	"appearance-none w-full rounded-[0.55rem] border border-border bg-popover px-3 py-2 text-[0.9rem] text-foreground cursor-pointer transition-colors hover:border-[var(--input)] focus-visible:border-[var(--input)] focus-visible:outline-none disabled:opacity-50";
const BUTTON_CLS =
	"inline-flex items-center justify-center gap-1.5 rounded-[0.5rem] border border-border bg-card px-3 py-2 text-[0.82rem] font-medium text-foreground transition-colors hover:bg-[var(--foreground-5)] disabled:cursor-not-allowed disabled:opacity-50";

export function VoiceMicrophoneSettings() {
	const manager = useMemo<VoiceMicrophoneManager | null>(() => {
		try {
			return getVoiceMicrophoneManager();
		} catch {
			return null;
		}
	}, []);
	const [snapshot, setSnapshot] = useState<VoiceMicrophoneSnapshot | null>(null);
	const [loading, setLoading] = useState(Boolean(manager));
	const [warming, setWarming] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (!manager) return;
		setLoading(true);
		try {
			setSnapshot(await manager.snapshot());
			setError(null);
		} catch (nextError) {
			setError(
				uiText("settings.voicemicrophonesettings.failedToReadMicrophonesError", { error: nextError instanceof Error ? nextError.message : String(nextError) }),
			);
		} finally {
			setLoading(false);
		}
	}, [manager]);

	useEffect(() => {
		if (!manager) return;
		const unsubscribe = manager.subscribe(() => {
			void refresh();
		});
		void refresh();
		return unsubscribe;
	}, [manager, refresh]);

	const changePreference = (value: string) => {
		if (!manager || !snapshot) return;
		let preference: VoiceMicrophonePreference;
		if (value === "built-in") {
			preference = { kind: "built-in" };
		} else if (value.startsWith("device:")) {
			const deviceId = value.slice("device:".length);
			const device = snapshot.devices.find(
				(candidate) => candidate.deviceId === deviceId,
			);
			preference = {
				kind: "device",
				deviceId,
				deviceLabel: device?.label ?? "",
			};
		} else {
			preference = { kind: "default" };
		}
		manager.setPreference(preference);
		setMessage(null);
		setError(null);
	};

	const warmup = async () => {
		if (!manager) return;
		setWarming(true);
		setMessage(null);
		setError(null);
		try {
			const result = await manager.warmup();
			if (result.skippedActiveCapture) {
				setMessage(uiText("settings.voicemicrophonesettings.recordingIsActiveTheMicrophoneDoesNotNeedAnother"));
			} else if (result.alreadyWarm) {
				setMessage(uiText("settings.voicemicrophonesettings.theMicrophoneIsWarmAndReadyForVoiceInput"));
			} else {
				const label = result.deviceLabel ? uiText("settings.voicemicrophonesettings.label", { label: result.deviceLabel }) : "";
				setMessage(
					result.usedFallback
						? uiText("settings.voicemicrophonesettings.theSelectedDeviceIsUnavailableTheSystemDefaultMicrophone", { label })
						: uiText("settings.voicemicrophonesettings.microphoneCheckAndWarmupSucceededLabel", { label }),
				);
			}
			await refresh();
		} catch (nextError) {
			setError(
				uiText("settings.voicemicrophonesettings.microphoneCheckFailedError", { error: nextError instanceof Error ? nextError.message : String(nextError) }),
			);
		} finally {
			setWarming(false);
		}
	};

	if (!manager) {
		return (
			<div
				className="rounded-[0.55rem] border border-border bg-card px-3 py-3 text-[0.82rem] text-muted-foreground"
				data-testid="voice-microphone-settings"
			>
				{uiText("settings.voicemicrophonesettings.thisBrowserDoesNotSupportMicrophoneDeviceManagement")}
			</div>
		);
	}

	const selectedValue = getSelectedValue(snapshot);
	const savedPreference =
		snapshot?.preference.kind === "device" ? snapshot.preference : null;
	const savedDeviceUnavailable =
		snapshot && savedPreference
			? !snapshot.resolvedDeviceId &&
				!snapshot.devices.some(
					(device) => device.deviceId === savedPreference.deviceId,
				)
			: false;

	return (
		<div
			className="grid gap-3 rounded-[0.55rem] border border-border bg-card px-3 py-3"
			data-testid="voice-microphone-settings"
		>
			<div className="grid gap-1">
				<div className="flex items-center gap-2">
					<Mic className="h-4 w-4 text-muted-foreground" aria-hidden />
					<h3 className="m-0 text-[0.95rem] font-medium">{uiText("settings.voicemicrophonesettings.voiceInputMicrophone")}</h3>
				</div>
				<p className="m-0 text-[0.8rem] leading-relaxed text-muted-foreground">
					{uiText("settings.voicemicrophonesettings.theDeviceChoiceIsSavedInThisBrowserCapture")}
				</p>
			</div>

			<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2 max-[620px]:grid-cols-1">
				<label className="grid gap-1.5 text-[0.82rem] text-muted-foreground">
					{uiText("settings.voicemicrophonesettings.microphone")}
					<select
						className={SELECT_CLS}
						value={selectedValue}
						disabled={loading || !snapshot}
						onChange={(event) => changePreference(event.target.value)}
						data-testid="voice-microphone-select"
					>
						<option value="default">{uiText("settings.voicemicrophonesettings.systemDefault")}</option>
						<option value="built-in">{uiText("settings.voicemicrophonesettings.preferBuiltInMicrophone")}</option>
						{savedDeviceUnavailable && savedPreference && (
							<option
								value={`device:${savedPreference.deviceId}`}
								disabled
							>
								{uiText("settings.voicemicrophonesettings.labelCurrentlyUnavailable", { label: savedPreference.deviceLabel || uiText("settings.voicemicrophonesettings.savedMicrophone") })}
							</option>
						)}
						{snapshot?.devices.map((device, index) => (
							<option
								key={device.deviceId}
								value={`device:${device.deviceId}`}
							>
								{device.label || uiText("settings.voicemicrophonesettings.microphoneNumber", { number: index + 1 })}
								{device.isBuiltIn ? uiText("settings.voicemicrophonesettings.builtIn") : ""}
							</option>
						))}
					</select>
				</label>
				<button
					type="button"
					className={BUTTON_CLS}
					onClick={() => void refresh()}
					disabled={loading || warming}
					data-testid="voice-microphone-refresh"
				>
					<RefreshCcw
						className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
						aria-hidden
					/>
					{uiText("common.refresh")}
				</button>
				<button
					type="button"
					className={BUTTON_CLS}
					onClick={() => void warmup()}
					disabled={loading || warming}
					data-testid="voice-microphone-warmup"
				>
					{warming ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
					) : (
						<Mic className="h-3.5 w-3.5" aria-hidden />
					)}
					{uiText("settings.voicemicrophonesettings.checkAndWarmUp")}
				</button>
			</div>

			{snapshot && !snapshot.labelsAvailable && (
				<div className="text-[0.76rem] text-muted-foreground">
					{uiText("settings.voicemicrophonesettings.theBrowserWillShowCompleteDeviceNamesAfterMicrophone")}
				</div>
			)}
			{message && (
				<div
					className="text-[0.78rem] text-emerald-600 dark:text-emerald-400"
					data-testid="voice-microphone-message"
				>
					{message}
				</div>
			)}
			{error && (
				<div
					className="text-[0.78rem] text-destructive"
					data-testid="voice-microphone-error"
				>
					{error}
				</div>
			)}
		</div>
	);
}

function getSelectedValue(snapshot: VoiceMicrophoneSnapshot | null): string {
	if (!snapshot || snapshot.preference.kind === "default") return "default";
	if (snapshot.preference.kind === "built-in") return "built-in";
	return `device:${snapshot.resolvedDeviceId ?? snapshot.preference.deviceId}`;
}
