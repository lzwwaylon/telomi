import unittest
from unittest.mock import patch

import numpy as np

import app as audio_app


class TtsChunkTests(unittest.IsolatedAsyncioTestCase):
    def test_chunks_keep_every_character_within_the_limit(self):
        text = "第一句话。第二句话！" + "很长的一句没有句号，" * 40 + "结尾。" + "无标点" * 100
        chunks = audio_app._tts_chunks(text, 200)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(0 < len(chunk) <= 200 for chunk in chunks))
        self.assertTrue(chunks[0].endswith("，"))

    def test_english_breaks_at_sentences_and_words(self):
        chunks = audio_app._tts_chunks(
            "Hello there. It costs 3.5 dollars and more words here. How are you? Fine.", 20
        )
        self.assertEqual(
            chunks,
            ["Hello there.", "It costs 3.5 dollars", "and more words", "here. How are you?", "Fine."],
        )

    async def test_speech_generates_each_chunk_with_its_own_token_budget(self):
        calls = []

        class Result:
            audio = np.zeros(240, dtype=np.float32)
            sample_rate = 24000

        class Tts:
            sample_rate = 24000

            def generate(self, **kwargs):
                calls.append(kwargs)
                yield Result()

        async def ensure_tts():
            return Tts()

        text = "一句话。" * 120
        with patch.object(audio_app, "_ensure_tts", side_effect=ensure_tts):
            await audio_app.speech(audio_app.SpeechRequest(input=text), None)

        self.assertEqual("".join(call["text"] for call in calls), text)
        self.assertTrue(all(len(call["text"]) <= audio_app.TTS_CHUNK_CHARS for call in calls))
        self.assertEqual(
            [call["max_tokens"] for call in calls],
            [audio_app._tts_max_tokens(call["text"]) for call in calls],
        )
        self.assertTrue(all(call["repetition_penalty"] == audio_app.TTS_REP_PENALTY for call in calls))


if __name__ == "__main__":
    unittest.main()
