# Livescriber

Electron + React desktop transcription shell for Windows loopback audio.

## Run

```powershell
npm install
python -m venv .venv
.\\.venv\\Scripts\\python -m pip install -r backend\\requirements.txt
npm run dev
```

The app starts a local WebSocket backend on `127.0.0.1:8765`. By default it tries `faster-whisper` with `LIVE_SCRIBER_DEVICE=cuda`, then falls back to CPU int8.

## Useful backend settings

```powershell
$env:LIVE_SCRIBER_MODEL="small.en"
$env:LIVE_SCRIBER_DEVICE="cuda"
$env:LIVE_SCRIBER_COMPUTE="float16"
$env:LIVE_SCRIBER_WINDOW_SECONDS="7.5"
```

File speaker differentiation runs locally with sherpa-onnx segmentation and
WeSpeaker embeddings. The models download on first use (about 34 MB) and are
cached in LocalAppData/Livescriber/models. No account or token is required.
Speaker labels are automatic estimates; overlapping voices and very short turns
can be ambiguous. Live capture labels desktop and microphone separately.

## File transcription and exports

File transcripts retain every segment and display results in chronological order
as they arrive. Each new file starts a fresh transcript. A uniquely named TXT file
is created immediately in the export directory and each recognized segment is
written and flushed before it is displayed. File TXT saving always runs, including
when live auto-export is disabled; no export click is required. Completed text
remains on disk after stopping or losing the connection. Export TXT and Copy also
include the full chronological transcript when search is filtering the panel.

Exports go to the folder selected in Settings (Documents/Livescriber by default).
The result appears at the bottom of the window with a **Show in folder** button.
**Folder** opens the export directory in Explorer; **Settings → Change folder**
changes the destination. The app version appears in the title bar.
File audio exports extract the first audio track as WAV, streaming directly from
the original media to disk. Live recordings export as WebM. The live automatic
export setting controls transcript/audio export when listening stops.

## Regression checks

Run `npm run test:renderer` for the Electron retention/export regression checks.
With the backend dependencies installed, run
`python -B -m unittest discover -s backend -p "test_*.py" -v` for file streaming,
failure reporting, and audio extraction checks. The optional
`python -B scripts/verify-recording.py INPUT OUTPUT_DIR` check transcribes a real
long recording and verifies the complete transcript and exported audio duration.

Builds and renderer tests use at most eight logical CPUs, including child tools.
For other local validation commands use `scripts/run-limited.ps1`.

## Releases

Commit the finished changes and publish a version tag newer than the latest
installed/released version, with package.json and package-lock.json matching the
tag. Push the commit and tag together, for example
`git push --atomic origin master v1.0.3`. The tagged GitHub Actions run verifies
the version, runs regression checks, and publishes the installer and update
metadata. Local-only versions can be replaced by a newer public release.

Speaker model sources: [sherpa-onnx diarization example](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py)
and [official model releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models).
