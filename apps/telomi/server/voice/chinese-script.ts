import OpenCC from "opencc-js";

export type VoiceChineseScriptPreference = "zh-CN" | "zh-TW";
export type VoiceChineseScriptProfile =
	| "opencc-t2s-v1"
	| "opencc-s2tw-v1";

export interface VoiceChineseScriptNormalization {
	text: string;
	preference: VoiceChineseScriptPreference | null;
	profile: VoiceChineseScriptProfile | null;
	applied: boolean;
	changed: boolean;
}

const toSimplifiedChinese = OpenCC.Converter({ from: "t", to: "cn" });
const toTraditionalTaiwan = OpenCC.Converter({ from: "cn", to: "tw" });

/**
 * Applies only an explicit regional Chinese preference. Auto detection and the
 * base Provider hint "zh" do not imply a display script.
 */
export function normalizeVoiceTranscriptScript(
	text: string,
	preference: string | null | undefined,
): VoiceChineseScriptNormalization {
	const normalized = text.normalize("NFC");
	if (preference === "zh-CN") {
		const converted = toSimplifiedChinese(normalized);
		return {
			text: converted,
			preference,
			profile: "opencc-t2s-v1",
			applied: true,
			changed: converted !== normalized,
		};
	}
	if (preference === "zh-TW") {
		const converted = toTraditionalTaiwan(normalized);
		return {
			text: converted,
			preference,
			profile: "opencc-s2tw-v1",
			applied: true,
			changed: converted !== normalized,
		};
	}
	return {
		text: normalized,
		preference: null,
		profile: null,
		applied: false,
		changed: false,
	};
}

/**
 * Script-neutral scoring projection. Both reference and hypothesis pass
 * through the same Traditional-to-Simplified OpenCC profile before CER.
 */
export function normalizeChineseContentForScoring(text: string): string {
	return toSimplifiedChinese(text.normalize("NFKC"));
}
