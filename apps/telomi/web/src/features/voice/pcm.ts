/**
 * The AudioWorklet buffering strategy is adapted from OpenWhispr.
 * Source: docs/openwhispr/src/helpers/audioManager.js
 * Source commit: e1cb8301d898881e28372e61ba15a8fd57f4f25b
 * License details: apps/telomi/THIRD_PARTY_NOTICES.md
 */

export const PCM_WORKLET_NAME = "telomi-pcm-streaming-processor";
export const PCM_WORKLET_BUFFER_SAMPLES = 800;

export function createPcmWorkletSource(): string {
	return `
const BUFFER_SIZE = ${PCM_WORKLET_BUFFER_SAMPLES};
class TelomiPcmStreamingProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buffer = new Int16Array(BUFFER_SIZE);
		this.offset = 0;
		this.stopped = false;
		this.port.onmessage = (event) => {
			if (event.data !== "stop") return;
			if (this.offset > 0) {
				const partial = this.buffer.slice(0, this.offset);
				this.port.postMessage(partial.buffer, [partial.buffer]);
				this.buffer = new Int16Array(BUFFER_SIZE);
				this.offset = 0;
			}
			this.port.postMessage("flushed");
			this.stopped = true;
		};
	}
	process(inputs) {
		if (this.stopped) return false;
		const input = inputs[0]?.[0];
		if (!input) return true;
		for (let i = 0; i < input.length; i += 1) {
			const sample = Math.max(-1, Math.min(1, input[i]));
			this.buffer[this.offset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
			this.offset += 1;
			if (this.offset >= BUFFER_SIZE) {
				this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
				this.buffer = new Int16Array(BUFFER_SIZE);
				this.offset = 0;
			}
		}
		return true;
	}
}
registerProcessor("${PCM_WORKLET_NAME}", TelomiPcmStreamingProcessor);
`;
}

export function measurePcm16Window(samples: Int16Array): { rms: number; peak: number } {
	if (samples.length === 0) return { rms: 0, peak: 0 };
	let sumSquares = 0;
	let peak = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const normalized = samples[index]! / 32_768;
		const amplitude = Math.abs(normalized);
		sumSquares += normalized * normalized;
		peak = Math.max(peak, amplitude);
	}
	return { rms: Math.sqrt(sumSquares / samples.length), peak };
}
