"""Local speaker segmentation and embeddings using sherpa-onnx."""

import hashlib
import os
import json
import sys
import tarfile
import urllib.request
from pathlib import Path


MODEL_ROOT = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
SEGMENTATION_SHA256 = "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"
ARCHIVE_SHA256 = "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"
EMBEDDING_SHA256 = "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94"


def valid_model(path: Path, digest: str) -> bool:
    return path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest


def download(url: str, target: Path, digest: str) -> None:
    temporary = target.with_suffix(target.suffix + ".download")
    try:
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
            while data := response.read(1024 * 1024):
                output.write(data)
        if not valid_model(temporary, digest):
            raise RuntimeError(f"Speaker model checksum failed: {target.name}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def ensure_models(cache: Path) -> tuple[Path, Path]:
    cache.mkdir(parents=True, exist_ok=True)
    segmentation = cache / "segmentation.onnx"
    embedding = cache / "wespeaker_en_voxceleb_resnet34.onnx"
    if not valid_model(segmentation, SEGMENTATION_SHA256):
        archive = cache / "segmentation.tar.bz2"
        if not valid_model(archive, ARCHIVE_SHA256):
            download(f"{MODEL_ROOT}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", archive, ARCHIVE_SHA256)
        with tarfile.open(archive) as bundle:
            # Read only the known model and license, never extract arbitrary paths.
            for member, destination in [("model.onnx", segmentation), ("LICENSE", cache / "SEGMENTATION-LICENSE")]:
                source = bundle.extractfile(f"sherpa-onnx-pyannote-segmentation-3-0/{member}")
                if source is None:
                    raise RuntimeError(f"Speaker model archive is missing {member}")
                destination.write_bytes(source.read())
        if not valid_model(segmentation, SEGMENTATION_SHA256):
            raise RuntimeError("Speaker segmentation model checksum failed")
    if not valid_model(embedding, EMBEDDING_SHA256):
        download(f"{MODEL_ROOT}/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx", embedding, EMBEDDING_SHA256)
    return segmentation, embedding


class SpeakerTimeline:
    def __init__(self, turns):
        self.turns = sorted(turns, key=lambda turn: (turn[0], turn[1]))
        names = {}
        self.turns = [(start, end, names.setdefault(speaker, f"Speaker {len(names) + 1}")) for start, end, speaker in self.turns]
        self.speaker_count = len(names)

    def label(self, start: float, end: float) -> str:
        overlaps = {}
        nearest = (float("inf"), "Unknown speaker")
        for turn_start, turn_end, speaker in self.turns:
            if turn_start > end + 1:
                break
            overlap = max(0, min(end, turn_end) - max(start, turn_start))
            overlaps[speaker] = overlaps.get(speaker, 0) + overlap
            distance = max(turn_start - end, start - turn_end, 0)
            if distance < nearest[0]:
                nearest = (distance, speaker)
        if overlaps and max(overlaps.values()) > 0:
            return max(overlaps, key=overlaps.get)
        return nearest[1] if nearest[0] <= 1 else "Unknown speaker"


class SpeakerDiarizer:
    def __init__(self, cache: Path | None = None):
        self.cache = cache or Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".cache"))) / "Livescriber" / "models" / "speaker-diarization"
        self.model = None

    def process(self, audio, sample_rate: int, progress, cancelled) -> SpeakerTimeline:
        import sherpa_onnx as sherpa

        if sample_rate != 16000:
            raise ValueError("Speaker differentiation requires 16 kHz audio")
        if self.model is None:
            segmentation, embedding = ensure_models(self.cache)
            config = sherpa.OfflineSpeakerDiarizationConfig(
                segmentation=sherpa.OfflineSpeakerSegmentationModelConfig(
                    pyannote=sherpa.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation)),
                    num_threads=4,
                    provider="cpu",
                ),
                embedding=sherpa.SpeakerEmbeddingExtractorConfig(model=str(embedding), num_threads=4, provider="cpu"),
                clustering=sherpa.FastClusteringConfig(num_clusters=-1, threshold=0.5),
                min_duration_on=0.3,
                min_duration_off=0.5,
            )
            if not config.validate():
                raise RuntimeError("Speaker model configuration is invalid")
            self.model = sherpa.OfflineSpeakerDiarization(config)
        def callback(processed, total):
            progress(processed, total)
            return int(cancelled.is_set())
        result = self.model.process(audio, callback=callback).sort_by_start_time()
        if cancelled.is_set():
            raise InterruptedError("Speaker differentiation cancelled")
        return SpeakerTimeline([(turn.start, turn.end, turn.speaker) for turn in result])


if __name__ == "__main__":
    import threading
    import numpy as np
    try:
        samples = np.load(sys.argv[1], mmap_mode="r")
        def report(processed, total):
            print(json.dumps({"type": "progress", "processed": processed, "total": total}), flush=True)
        timeline = SpeakerDiarizer().process(samples, 16000, report, threading.Event())
        print(json.dumps({"type": "speakers", "turns": timeline.turns}), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
