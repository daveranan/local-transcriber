import asyncio
import json
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import av
import numpy as np

from export_audio import export_audio
from transcriber_service import ClientConfig, ClientSession, Transcriber
from speaker_diarization import SpeakerTimeline


class Socket:
    def __init__(self):
        self.messages = []
        self.first_segment = threading.Event()

    async def send(self, raw):
        message = json.loads(raw)
        self.messages.append(message)
        if message["type"] == "segment":
            self.first_segment.set()

    async def wait_closed(self):
        await asyncio.Future()


class Model:
    def __init__(self, socket):
        self.socket = socket

    def transcribe(self, audio, **kwargs):
        def segments():
            for i in range(1200):
                if i == 1 and not self.socket.first_segment.wait(5):
                    raise RuntimeError("First segment was not streamed before completion")
                yield SimpleNamespace(start=i * 2.4, end=(i + 1) * 2.4, text=f"Sentence {i}", avg_logprob=-0.1)
        return segments(), None


class FileTranscriptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_entire_long_transcript_streamed_before_completion(self):
        socket = Socket()
        transcriber = Transcriber()
        transcriber.model = Model(socket)
        # This test isolates streaming; real model detection is exercised by
        # verify-recording.py against a conversation.
        transcriber.decode_file_audio = lambda *_: (np.ones(16000, dtype=np.float32), {"duration": 2880, "peak": 1, "rms": 1})
        session = ClientSession(socket, transcriber)
        session.identify_file_speakers = AsyncMock(return_value=SpeakerTimeline([(0, 1440, 7), (1440, 2880, 2)]))
        with tempfile.TemporaryDirectory() as directory:
            transcript_path = Path(directory) / "automatic.txt"
            await session.transcribe_file(__file__, session.sources["desktop"], str(transcript_path))
            saved = transcript_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(saved), 1200)
            self.assertTrue(saved[0].startswith("[00:00"))
            self.assertIn("Speaker 2: Sentence 1199", saved[-1])
        segments = [m["segment"] for m in socket.messages if m["type"] == "segment"]
        self.assertEqual(len(segments), 1200)
        self.assertEqual(segments[0]["start"], 0)
        self.assertEqual(segments[-1]["end"], 2880)
        self.assertEqual(len({s["id"] for s in segments}), 1200)
        self.assertEqual(socket.messages[-1]["type"], "file_complete")
        self.assertEqual(socket.messages[-1]["speakers"], 2)

    async def test_sentence_splits_at_word_level_speaker_change(self):
        socket = Socket()
        transcriber = Transcriber()
        timeline = SpeakerTimeline([(0, 1, 42), (1, 2, 8)])
        words = [SimpleNamespace(start=0, end=0.5, word=" Hello"), SimpleNamespace(start=1, end=2, word=" there")]
        segment = SimpleNamespace(start=0, end=2, text="Hello there", avg_logprob=-0.1, words=words)
        transcriber.model = SimpleNamespace(transcribe=lambda *args, **kwargs: (iter([segment]), None))
        result = transcriber.transcribe(np.ones(32000, dtype=np.float32), ClientConfig(), speaker_timeline=timeline)
        self.assertEqual([(s["speaker"], s["text"]) for s in result], [("Speaker 1", "Hello"), ("Speaker 2", "there")])

    async def test_missing_file_and_unavailable_model_report_terminal_error(self):
        for file in ("nonexistent-recording.mp4", __file__):
            socket = Socket()
            session = ClientSession(socket, Transcriber())
            await session.transcribe_file(file, session.sources["desktop"])
            self.assertEqual(socket.messages[-1]["type"], "file_error")
            self.assertFalse(any(m["type"] == "file_complete" for m in socket.messages))

    async def test_decode_failure_reports_terminal_error(self):
        socket = Socket()
        transcriber = Transcriber()
        transcriber.model = Model(socket)
        session = ClientSession(socket, transcriber)
        await session.transcribe_file(__file__, session.sources["desktop"])
        self.assertEqual(socket.messages[-1]["type"], "file_error")


class AudioExportTests(unittest.TestCase):
    def test_preserves_entire_stereo_recording_and_sample_rate(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.wav"
            target = Path(directory) / "export.wav"
            samples = np.column_stack((np.arange(100003, dtype=np.int16), -np.arange(100003, dtype=np.int16)))
            with wave.open(str(source), "wb") as output:
                output.setnchannels(2)
                output.setsampwidth(2)
                output.setframerate(44100)
                output.writeframes(samples.tobytes())
            export_audio(str(source), str(target))
            with av.open(str(target)) as audio:
                self.assertEqual(audio.streams.audio[0].codec_context.sample_rate, 44100)
                decoded = np.concatenate([frame.to_ndarray().reshape(-1) for frame in audio.decode(audio=0)])
            np.testing.assert_array_equal(decoded, samples.reshape(-1))
            self.assertFalse(target.with_suffix(".wav.partial").exists())

    def test_failed_export_does_not_leave_an_output(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "export.wav"
            with self.assertRaises(Exception):
                export_audio(__file__, str(target))
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix(".wav.partial").exists())


if __name__ == "__main__":
    unittest.main()
