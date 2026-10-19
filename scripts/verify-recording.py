"""Exercise the real file protocol and exports: python verify-recording.py INPUT OUTPUT_DIR."""

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import av
import websockets
from export_audio import export_audio
from transcriber_service import ClientConfig, ClientSession, Transcriber


async def verify(source: Path, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    transcriber = Transcriber()
    await asyncio.to_thread(transcriber.load)
    if transcriber.model is None:
        raise RuntimeError(transcriber.load_error)

    async def handler(socket):
        await ClientSession(socket, transcriber).run()

    segments = []
    last_percent = -5
    last_stage = None
    transcript_path = output / f"{source.stem}.txt"
    transcript_path.write_text("", encoding="utf-8")
    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}") as socket:
            await socket.send(json.dumps({"type": "configure", "sampleRate": 16000}))
            await socket.send(json.dumps({"type": "file", "path": str(source), "transcriptPath": str(transcript_path.resolve())}))
            async for raw in socket:
                message = json.loads(raw)
                if message["type"] == "segment":
                    segments.append(message["segment"])
                    if len(segments) == 1:
                        assert message["segment"]["text"] in transcript_path.read_text(encoding="utf-8"), "TXT must be saved before completion"
                elif message["type"] == "progress":
                    progress = message["progress"]
                    if progress["stage"] != last_stage:
                        last_percent = -5
                        last_stage = progress["stage"]
                    percent = int((progress["percent"] or 0) * 100)
                    if percent >= last_percent + 5:
                        print(f"{progress['stage']} {percent}% received={len(segments)} elapsed={time.monotonic() - started:.1f}s", flush=True)
                        last_percent = percent
                elif message["type"] == "file_error":
                    raise RuntimeError(message["message"])
                elif message["type"] == "file_complete":
                    assert message["segments"] == len(segments)
                    duration = message["duration"]
                    break
    assert len(segments) > 250, "Recording must exceed the old retention limit for this regression check"
    # Recordings may open with a long silent intro. Compare against recognition
    # of the opening audio rather than assuming speech starts before 01:00.
    opening_audio, _ = await asyncio.to_thread(transcriber.decode_file_audio, str(source), 16000)
    opening_end = int((segments[0]["start"] + 30) * 16000)
    reference = await asyncio.to_thread(transcriber.transcribe, opening_audio[:opening_end], ClientConfig(diarization=False))
    del opening_audio
    assert reference and abs(reference[0]["start"] - segments[0]["start"]) < 2, "Opening speech was not retained"
    assert segments[-1]["end"] > duration - 120, "Closing speech was not retained"
    assert len({segment["id"] for segment in segments}) == len(segments)
    (output / "segments.json").write_text(json.dumps(segments, ensure_ascii=False), encoding="utf-8")
    def timestamp(value):
        return f"{int(value // 60):02}:{int(value % 60):02}"
    transcript = "".join(f"[{timestamp(s['start'])} - {timestamp(s['end'])}] {s['speaker']}: {s['text']}\n" for s in segments)
    assert transcript_path.read_text(encoding="utf-8") == transcript
    speakers = sorted({s["speaker"] for s in segments})
    print(f"Transcription verified: {len(segments)} segments, {segments[0]['start']:.2f}s through {segments[-1]['end']:.2f}s of {duration:.2f}s", flush=True)
    audio_path = output / f"{source.stem}.wav"
    await asyncio.to_thread(export_audio, str(source), str(audio_path))
    with av.open(str(audio_path)) as container:
        stream = container.streams.audio[0]
        exported_duration = float(stream.duration * stream.time_base)
    assert abs(exported_duration - duration) < 0.1
    summary = {"source": str(source), "sourceBytes": source.stat().st_size, "duration": duration, "segments": len(segments), "speakers": speakers, "firstStart": segments[0]["start"], "lastEnd": segments[-1]["end"], "exportedAudioDuration": exported_duration, "elapsedSeconds": time.monotonic() - started}
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    asyncio.run(verify(Path(sys.argv[1]), Path(sys.argv[2])))
