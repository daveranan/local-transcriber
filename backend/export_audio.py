"""Extract the first audio track without loading the video or audio into memory."""

import itertools
import sys
from pathlib import Path

import av


def export_audio(source_path: str, destination_path: str) -> None:
    destination = Path(destination_path)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        with av.open(source_path, metadata_errors="ignore") as source:
            if not source.streams.audio:
                raise ValueError("The selected file has no audio track.")
            audio = source.streams.audio[0]
            rate = audio.codec_context.sample_rate or 48_000
            layout = "mono" if len(audio.codec_context.layout.channels) == 1 else "stereo"
            resampler = av.AudioResampler(format="s16", layout=layout, rate=rate)
            # RF64 also supports recordings whose extracted PCM exceeds 4 GB.
            with av.open(str(temporary), "w", format="wav", options={"rf64": "auto"}) as output:
                stream = output.add_stream("pcm_s16le", rate=rate)
                stream.layout = layout
                samples = 0
                for frame in itertools.chain(source.decode(audio=0), [None]):
                    if frame is not None:
                        frame.pts = None
                    for converted in resampler.resample(frame):
                        converted.pts = samples
                        samples += converted.samples
                        for packet in stream.encode(converted):
                            output.mux(packet)
                for packet in stream.encode(None):
                    output.mux(packet)
                if not samples:
                    raise ValueError("The selected file contains no decodable audio.")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        export_audio(sys.argv[1], sys.argv[2])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
