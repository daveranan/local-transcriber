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

Speaker diarization is currently a backend hook that labels everything as `Speaker 1`. Real multi-speaker diarization from mixed desktop audio needs pyannote/WhisperX-style integration and will be best-effort unless speakers are separated by channel or app source.
