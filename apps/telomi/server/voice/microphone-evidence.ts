import { sha256 } from "../lib/hash.js";
import {
	VOICE_MICROPHONE_DEVICE_ID_HEADER,
	VOICE_MICROPHONE_DEVICE_LABEL_HEADER,
	VOICE_MICROPHONE_FALLBACK_HEADER,
	VOICE_MICROPHONE_SELECTION_HEADER,
	VOICE_MICROPHONE_SELECTION_STATUSES,
	type VoiceMicrophoneEvidence,
	type VoiceMicrophoneSelectionStatus,
} from "../../shared/voice-microphone.js";

const MAX_DEVICE_ID_LENGTH = 512;
const MAX_DEVICE_LABEL_LENGTH = 200;

type HeaderMap = Record<string, string | string[] | undefined>;

/**
 * Converts browser capture metadata into privacy-bounded server evidence.
 * The origin-scoped device ID is hashed immediately and is never returned.
 */
export function parseVoiceMicrophoneRequestHeaders(
	headers: HeaderMap,
): VoiceMicrophoneEvidence | null {
	try {
		const selection = singleHeader(headers, VOICE_MICROPHONE_SELECTION_HEADER);
		const fallback = singleHeader(headers, VOICE_MICROPHONE_FALLBACK_HEADER);
		if (!isSelectionStatus(selection) || (fallback !== "0" && fallback !== "1")) {
			return null;
		}

		const deviceId = decodeBoundedHeader(
			singleHeader(headers, VOICE_MICROPHONE_DEVICE_ID_HEADER),
			MAX_DEVICE_ID_LENGTH,
		);
		const deviceLabel = decodeBoundedHeader(
			singleHeader(headers, VOICE_MICROPHONE_DEVICE_LABEL_HEADER),
			MAX_DEVICE_LABEL_LENGTH,
		);
		if (deviceId === null || deviceLabel === null) return null;

		return {
			...(deviceLabel ? { deviceLabel } : {}),
			...(deviceId
				? {
						deviceFingerprint: sha256(deviceId),
					}
				: {}),
			selectionStatus: selection,
			usedFallback: fallback === "1",
		};
	} catch {
		return null;
	}
}

function singleHeader(headers: HeaderMap, name: string): string | undefined {
	const value = headers[name];
	return typeof value === "string" ? value : undefined;
}

function decodeBoundedHeader(
	value: string | undefined,
	maxLength: number,
): string | null {
	if (value === undefined) return "";
	const decoded = decodeURIComponent(value).trim();
	if (decoded.length > maxLength || /[\u0000-\u001f\u007f]/u.test(decoded)) {
		return null;
	}
	return decoded;
}

function isSelectionStatus(
	value: string | undefined,
): value is VoiceMicrophoneSelectionStatus {
	return VOICE_MICROPHONE_SELECTION_STATUSES.some(
		(candidate) => candidate === value,
	);
}
