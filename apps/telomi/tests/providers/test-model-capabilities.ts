import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesFor, classifyModel } from "../../shared/model-capabilities.js";

test("structured modality hints decide before the id does", () => {
	assert.deepEqual(classifyModel({ id: "x", architecture: { input_modalities: ["text"], output_modalities: ["speech"] } })?.capabilities, ["tts"]);
	assert.deepEqual(classifyModel({ id: "x", architecture: { input_modalities: ["audio"], output_modalities: ["text"] } })?.capabilities, ["stt"]);
	// OpenRouter's main catalog lists multimodal LLMs that also hear audio; they chat, they are not recognizers.
	assert.deepEqual(classifyModel({ id: "google/gemini-2.5-flash", architecture: { modality: "text+image+file+audio+video->text", input_modalities: ["text", "image", "file", "audio", "video"], output_modalities: ["text"] } })?.capabilities, ["chat"]);
	assert.deepEqual(classifyModel({ id: "openrouter/auto", architecture: { input_modalities: ["text", "image", "audio", "file", "video"], output_modalities: ["text", "image"] } })?.capabilities, ["chat"]);
	assert.deepEqual(classifyModel({ id: "x", architecture: { output_modalities: ["embeddings"] } })?.capabilities, ["embedding"]);
	assert.deepEqual(classifyModel({ id: "gpt-x", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } })?.capabilities, ["chat"]);
	assert.deepEqual(classifyModel({ id: "Qwen3-TTS-0.6B", supported_voices: ["vivian"] }), { id: "Qwen3-TTS-0.6B", name: undefined, capabilities: ["tts"], supportedVoices: ["vivian"] });
	// OpenRouter's speech, transcription and embedding catalogs name their own output modality.
	assert.deepEqual(classifyModel({ id: "fish-audio/s1", architecture: { modality: "text->speech", input_modalities: ["text"], output_modalities: ["speech"] } })?.capabilities, ["tts"]);
	assert.deepEqual(classifyModel({ id: "deepgram/nova-3", architecture: { modality: "audio->transcription", input_modalities: ["audio"], output_modalities: ["transcription"] } })?.capabilities, ["stt"]);
	assert.deepEqual(classifyModel({ id: "voyageai/voyage-4", architecture: { modality: "text->embeddings", input_modalities: ["text"], output_modalities: ["embeddings"] } })?.capabilities, ["embedding"]);
});

test("audio that is not speech is offered for nothing, not guessed into speech or chat", () => {
	// OpenRouter's music generation and spoken chat models answer with audio, not through a speech endpoint.
	assert.deepEqual(classifyModel({ id: "google/lyria-3-pro-preview", architecture: { modality: "text+image->text+audio", input_modalities: ["text", "image"], output_modalities: ["text", "audio"] } })?.capabilities, []);
	assert.deepEqual(classifyModel({ id: "openai/gpt-audio", architecture: { modality: "text+audio->text+audio", input_modalities: ["text", "audio"], output_modalities: ["text", "audio"] } })?.capabilities, []);
	// Once stored, that empty classification stays empty instead of being guessed from the id.
	assert.deepEqual(capabilitiesFor({ id: "google/lyria-3-pro-preview", capabilities: [] }), []);
});

test("ids classify when a listing has no hints", () => {
	const of = (id: string) => classifyModel({ id })?.capabilities;
	assert.deepEqual(of("openai/gpt-4o-mini-tts"), ["tts"]);
	assert.deepEqual(of("x-ai/grok-voice-tts-1.0"), ["tts"]);
	assert.deepEqual(of("Qwen3-ASR-0.6B-MLX-4bit"), ["stt"]);
	assert.deepEqual(of("openai/whisper-1"), ["stt"]);
	assert.deepEqual(of("nvidia/parakeet-tdt"), ["stt"]);
	assert.deepEqual(of("qwen/qwen3-embedding-4b"), ["embedding"]);
	assert.deepEqual(of("BAAI/bge-m3"), ["embedding"]);
	assert.deepEqual(of("text-embedding-3-large"), ["embedding"]);
	assert.deepEqual(of("anthropic/claude-sonnet-4"), ["chat"]);
	assert.deepEqual(of("gpt-5.4-mini"), ["chat"]);
	assert.deepEqual(of("openai/gpt-4o-mini-transcribe"), ["stt"]);
	assert.deepEqual(of("cohere/rerank-v3"), []);
	assert.deepEqual(of("openai/sora-2"), []);
	assert.equal(classifyModel({ id: "  " }), undefined);
});

test("stored capabilities are trusted; unknown values fall back to the id", () => {
	assert.deepEqual(capabilitiesFor({ id: "whisper-1", capabilities: ["tts"] }), ["tts"]);
	assert.deepEqual(capabilitiesFor({ id: "whisper-1", capabilities: ["bogus"] }), ["stt"]);
	assert.deepEqual(capabilitiesFor({ id: "whisper-1" }), ["stt"]);
});

test("a listing's declared task decides, and its voice objects are the model's voices", () => {
	// Speaches lists models with a Hugging Face task and voices as objects; the id names no capability.
	assert.deepEqual(classifyModel({ id: "speaches-ai/Kokoro-82M-v1.0-ONNX", task: "text-to-speech", voices: [{ id: "af_heart", name: "af_heart" }, { id: "zf_xiaobei" }] }),
		{ id: "speaches-ai/Kokoro-82M-v1.0-ONNX", name: undefined, capabilities: ["tts"], supportedVoices: ["af_heart", "zf_xiaobei"] });
	assert.deepEqual(classifyModel({ id: "Systran/faster-distil-small.en", task: "automatic-speech-recognition" })?.capabilities, ["stt"]);
	// A declared task Telomi selects nothing for is not guessed into chat from the id.
	assert.deepEqual(classifyModel({ id: "silero_vad_v5", task: "voice-activity-detection" })?.capabilities, []);
	assert.deepEqual(classifyModel({ id: "x", voices: ["alloy"] })?.supportedVoices, ["alloy"]);
	assert.deepEqual(classifyModel({ id: "x", supported_voices: [], voices: [{ id: "alloy" }] })?.supportedVoices, ["alloy"]);
});
