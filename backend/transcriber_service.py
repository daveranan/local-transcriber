import asyncio
import base64
import json
import os
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import websockets


DLL_HANDLES = []


def add_nvidia_dll_directories() -> None:
    site_packages = Path(sys.prefix) / "Lib" / "site-packages"
    dll_dirs = [
        site_packages / "nvidia" / "cublas" / "bin",
        site_packages / "nvidia" / "cudnn" / "bin",
        site_packages / "nvidia" / "cuda_runtime" / "bin",
        site_packages / "nvidia" / "cuda_nvrtc" / "bin",
    ]
    existing_dirs = [str(path) for path in dll_dirs if path.exists()]
    if not existing_dirs:
        return

    os.environ["PATH"] = os.pathsep.join(existing_dirs + [os.environ.get("PATH", "")])
    if hasattr(os, "add_dll_directory"):
        for dll_dir in existing_dirs:
            DLL_HANDLES.append(os.add_dll_directory(dll_dir))


add_nvidia_dll_directories()

try:
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
except Exception as exc:  # pragma: no cover
    WhisperModel = None
    decode_audio = None
    WHISPER_IMPORT_ERROR = exc
else:
    WHISPER_IMPORT_ERROR = None


HOST = "127.0.0.1"
PORT = int(os.environ.get("LIVE_SCRIBER_PORT", "8765"))
MODEL_NAME = os.environ.get("LIVE_SCRIBER_MODEL", "small")
MODEL_DEVICE = os.environ.get("LIVE_SCRIBER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("LIVE_SCRIBER_COMPUTE", "float16")
WINDOW_SECONDS = float(os.environ.get("LIVE_SCRIBER_WINDOW_SECONDS", "7.5"))
INTERVAL_SECONDS = float(os.environ.get("LIVE_SCRIBER_INTERVAL_SECONDS", "1.2"))
MIN_AUDIO_SECONDS = float(os.environ.get("LIVE_SCRIBER_MIN_AUDIO_SECONDS", "1.6"))


@dataclass
class ClientConfig:
    sample_rate: int = 16_000
    language: Optional[str] = None
    diarization: bool = True


@dataclass
class SourceState:
    name: str
    speaker: str
    buffer: bytearray = field(default_factory=bytearray)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_text: str = ""
    pending_text: str = ""
    pending_speaker: str = ""
    last_voice_at: float = field(default_factory=time.monotonic)
    last_commit_at: float = field(default_factory=time.monotonic)
    last_audio_status_at: float = 0.0
    last_processing_status_at: float = 0.0
    segment_count: int = 0


class SpeakerLabeler:
    def __init__(self) -> None:
        self.enabled = False

    def label(self, _audio: np.ndarray, _start: float, _end: float) -> str:
        return "Speaker 1"


class Transcriber:
    def __init__(self) -> None:
        self.model = None
        self.load_error = None
        self.loading = False
        self.speaker_labeler = SpeakerLabeler()

    def load(self) -> None:
        self.loading = True
        if WhisperModel is None:
            self.load_error = WHISPER_IMPORT_ERROR
            self.loading = False
            print(f"faster-whisper import failed: {WHISPER_IMPORT_ERROR}", flush=True)
            return

        try:
            self.model = WhisperModel(MODEL_NAME, device=MODEL_DEVICE, compute_type=COMPUTE_TYPE)
            print(f"loaded model={MODEL_NAME} device={MODEL_DEVICE} compute={COMPUTE_TYPE}", flush=True)
        except Exception as cuda_error:
            print(f"cuda model load failed: {cuda_error}", flush=True)
            try:
                self.model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
                print(f"loaded model={MODEL_NAME} device=cpu compute=int8", flush=True)
            except Exception as cpu_error:
                self.load_error = cpu_error
                print(f"cpu model load failed: {cpu_error}", flush=True)
        finally:
            self.loading = False

    def transcribe(
        self,
        audio: np.ndarray | str,
        config: ClientConfig,
        vad_filter: bool = True,
        progress=None,
        duration: float = 0.0,
    ) -> list[dict]:
        if self.model is None:
            return []

        language = config.language or None
        segments, _info = self.model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=vad_filter,
            condition_on_previous_text=False,
            word_timestamps=False,
        )

        result = []
        for segment in segments:
            if progress and duration > 0:
                progress(float(segment.end), duration)
            text = segment.text.strip()
            if not text:
                continue
            no_speech_prob = float(getattr(segment, "no_speech_prob", 0.0) or 0.0)
            if not vad_filter and no_speech_prob > 0.65:
                continue

            result.append({
                "speaker": self.speaker_labeler.label(audio, float(segment.start), float(segment.end)),
                "text": text,
                "start": float(segment.start),
                "end": float(segment.end),
                "confidence": 1.0 - float(getattr(segment, "avg_logprob", -1.0) * -1.0),
            })
        return result

    def decode_file_audio(self, file_path: str, sample_rate: int) -> tuple[np.ndarray, dict]:
        if decode_audio is None:
            raise RuntimeError(f"audio decoder unavailable: {WHISPER_IMPORT_ERROR}")
        audio = decode_audio(file_path, sampling_rate=sample_rate)
        if audio.size == 0:
            return audio, {"duration": 0.0, "peak": 0.0, "rms": 0.0}
        peak = float(np.max(np.abs(audio)))
        rms = float(np.sqrt(np.mean(np.square(audio))))
        return audio, {
            "duration": float(audio.size / sample_rate),
            "peak": peak,
            "rms": rms,
        }


class ClientSession:
    def __init__(self, websocket, transcriber: Transcriber) -> None:
        self.websocket = websocket
        self.transcriber = transcriber
        self.config = ClientConfig()
        self.sources = {
            "desktop": SourceState("desktop", "Speaker 1"),
            "mic": SourceState("mic", "Speaker 2"),
        }
        self.started_at = time.monotonic()
        self.closed = False

    async def run(self) -> None:
        processor = asyncio.create_task(self.process_loop())
        try:
            await self.send_status("connected")
            if self.transcriber.loading:
                await self.send_status("model loading")
            elif self.transcriber.model is None:
                await self.send_status(f"model unavailable: {self.transcriber.load_error}")

            async for raw_message in self.websocket:
                await self.handle_message(raw_message)
        finally:
            self.closed = True
            processor.cancel()

    async def handle_message(self, raw_message: str) -> None:
        message = json.loads(raw_message)
        message_type = message.get("type")

        if message_type == "configure":
            self.config = ClientConfig(
                sample_rate=int(message.get("sampleRate") or 16_000),
                language=message.get("language"),
                diarization=bool(message.get("diarization", True)),
            )
            await self.send_status(f"configured sample_rate={self.config.sample_rate}")
            return

        if message_type == "file":
            file_path = str(message.get("path") or "")
            source_name = str(message.get("source") or "desktop")
            source = self.sources.get(source_name) or SourceState(source_name, "Speaker 1")
            self.sources[source_name] = source
            await self.transcribe_file(file_path, source)
            return

        if message_type == "audio":
            source_name = str(message.get("source") or "desktop")
            source = self.sources.get(source_name)
            if source is None:
                source = SourceState(source_name, f"Speaker {len(self.sources) + 1}")
                self.sources[source_name] = source
            payload = base64.b64decode(message["payload"])
            chunk = np.frombuffer(payload, dtype=np.int16)
            peak = int(np.max(np.abs(chunk))) if chunk.size else 0
            if peak > 260:
                source.last_voice_at = time.monotonic()
            now = time.monotonic()
            if now - source.last_audio_status_at > 2.0:
                source.last_audio_status_at = now
                await self.send_status(f"{source.name} audio peak={peak} bytes={len(payload)}")
            async with source.lock:
                source.buffer.extend(payload)
                max_bytes = int(self.config.sample_rate * WINDOW_SECONDS * 2)
                if len(source.buffer) > max_bytes:
                    del source.buffer[: len(source.buffer) - max_bytes]

    async def transcribe_file(self, file_path: str, source: SourceState) -> None:
        if not file_path or not Path(file_path).exists():
            await self.send_status(f"file not found: {file_path}")
            return
        if self.transcriber.loading:
            await self.send_status("model still loading")
            while self.transcriber.loading:
                await asyncio.sleep(0.25)
        await self.send_status(f"transcribing file: {Path(file_path).name}")
        try:
            audio, stats = await asyncio.to_thread(self.transcriber.decode_file_audio, file_path, self.config.sample_rate)
            await self.send_progress("decode", 0.02, 0.0, stats["duration"])
            await self.send_status(
                f"file audio duration={stats['duration']:.1f}s peak={stats['peak']:.4f} rms={stats['rms']:.4f}"
            )
            if audio.size == 0 or stats["peak"] < 0.001:
                await self.send_status("file has no decodable audio or is silent")
                segments = []
            else:
                segments = await self.transcribe_audio_with_progress(audio, stats["duration"], True, "transcribe")
                if not segments:
                    await self.send_status("no speech detected with VAD; retrying without VAD")
                    await self.send_progress("retry", 0.0, 0.0, stats["duration"])
                    segments = await self.transcribe_audio_with_progress(audio, stats["duration"], False, "retry")
        except Exception as exc:
            await self.send_status(f"file transcribe error: {exc}")
            print(f"file transcribe error: {exc}", flush=True)
            return
        if not segments:
            await self.send_status("file has audio, but no speech was recognized")

        for index, segment in enumerate(segments, start=1):
            await self.websocket.send(json.dumps({
                "type": "segment",
                "segment": {
                    "id": f"file-{index}-{time.monotonic()}",
                    "speaker": source.speaker,
                    "text": segment["text"],
                    "start": segment["start"],
                    "end": segment["end"],
                    "partial": False,
                    "confidence": segment.get("confidence"),
                },
            }))
        await self.send_progress("complete", 1.0, stats["duration"] if "stats" in locals() else 0.0, stats["duration"] if "stats" in locals() else 0.0)
        await self.send_status(f"file transcription complete: {len(segments)} segments")

    async def transcribe_audio_with_progress(self, audio: np.ndarray, duration: float, vad_filter: bool, stage: str) -> list[dict]:
        progress_events = deque()

        def collect_progress(current: float, total: float) -> None:
            progress_events.append((current, total))

        task = asyncio.create_task(asyncio.to_thread(
            self.transcriber.transcribe,
            audio,
            self.config,
            vad_filter,
            collect_progress,
            duration,
        ))
        last_ping = time.monotonic()
        while not task.done():
            while progress_events:
                current, total = progress_events.popleft()
                await self.send_progress(stage, current / max(0.001, total), current, total)
                last_ping = time.monotonic()
            if time.monotonic() - last_ping > 1.0:
                await self.send_progress(stage, None, 0.0, duration)
                last_ping = time.monotonic()
            await asyncio.sleep(0.2)

        segments = await task
        while progress_events:
            current, total = progress_events.popleft()
            await self.send_progress(stage, current / max(0.001, total), current, total)
        return segments

    async def process_loop(self) -> None:
        while not self.closed:
            await asyncio.sleep(INTERVAL_SECONDS)
            for source in list(self.sources.values()):
                await self.process_source(source)

    async def process_source(self, source: SourceState) -> None:
        async with source.lock:
            audio_bytes = bytes(source.buffer)

        if self.transcriber.loading:
            await self.send_status("model still loading")
            return

        min_bytes = int(self.config.sample_rate * MIN_AUDIO_SECONDS * 2)
        if len(audio_bytes) < min_bytes:
            await self.maybe_commit(source)
            return

        pcm = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        peak = float(np.max(np.abs(pcm)))
        if peak < 0.008:
            await self.send_throttled_status(source, f"{source.name} silence peak={peak:.4f}")
            await self.maybe_commit(source)
            return

        await self.send_throttled_status(source, f"transcribing {source.name} {len(pcm) / self.config.sample_rate:.1f}s peak={peak:.3f}")
        try:
            segments = await asyncio.to_thread(self.transcriber.transcribe, pcm, self.config)
        except Exception as exc:
            await self.send_status(f"transcribe error: {exc}")
            print(f"transcribe error: {exc}", flush=True)
            return
        if not segments:
            await self.send_throttled_status(source, f"{source.name} no speech segments")
            await self.maybe_commit(source)
            return

        combined_text = " ".join(segment["text"] for segment in segments).strip()
        if not combined_text or combined_text == source.last_text:
            await self.maybe_commit(source)
            return

        source.last_text = combined_text
        source.pending_text = combined_text
        source.pending_speaker = source.speaker
        now = time.monotonic() - self.started_at
        await self.websocket.send(json.dumps({
            "type": "segment",
            "segment": {
                "id": f"{source.name}-live-partial",
                "speaker": source.pending_speaker,
                "text": combined_text,
                "start": max(0.0, now - WINDOW_SECONDS),
                "end": now,
                "partial": True,
                "confidence": segments[-1].get("confidence"),
            },
        }))
        await self.maybe_commit(source)

    async def maybe_commit(self, source: SourceState) -> None:
        if not source.pending_text:
            return

        quiet_for = time.monotonic() - source.last_voice_at
        open_for = time.monotonic() - source.last_commit_at
        if quiet_for < 1.4 and open_for < WINDOW_SECONDS:
            return

        source.segment_count += 1
        now = time.monotonic() - self.started_at
        await self.websocket.send(json.dumps({
            "type": "segment",
            "segment": {
                "id": f"{source.name}-segment-{source.segment_count}",
                "speaker": source.pending_speaker,
                "text": source.pending_text,
                "start": max(0.0, now - WINDOW_SECONDS),
                "end": now,
                "partial": False,
            },
        }))

        async with source.lock:
            source.buffer.clear()
        source.pending_text = ""
        source.last_text = ""
        source.last_commit_at = time.monotonic()

    async def send_status(self, message: str) -> None:
        await self.websocket.send(json.dumps({ "type": "status", "message": message }))

    async def send_progress(self, stage: str, percent: Optional[float], current: float, total: float) -> None:
        await self.websocket.send(json.dumps({
            "type": "progress",
            "progress": {
                "stage": stage,
                "percent": None if percent is None else max(0.0, min(1.0, float(percent))),
                "current": float(current),
                "total": float(total),
            },
        }))

    async def send_throttled_status(self, source: SourceState, message: str) -> None:
        now = time.monotonic()
        if now - source.last_processing_status_at < 2.0:
            return
        source.last_processing_status_at = now
        await self.send_status(message)


async def main() -> None:
    transcriber = Transcriber()
    transcriber.loading = True
    load_task = asyncio.create_task(asyncio.to_thread(transcriber.load))

    async def handler(websocket):
        session = ClientSession(websocket, transcriber)
        await session.run()

    print(f"listening ws://{HOST}:{PORT}/transcribe", flush=True)
    async with websockets.serve(handler, HOST, PORT, max_size=8 * 1024 * 1024):
        try:
            await asyncio.Future()
        finally:
            load_task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
