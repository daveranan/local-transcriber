import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  Activity,
  Captions,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clipboard,
  Cpu,
  Download,
  FileAudio,
  FileText,
  FileUp,
  Maximize2,
  Mic2,
  Minus,
  PanelRight,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  SquareActivity,
  X,
} from "lucide-react";
import { arrayBufferToBase64, downsampleFloat32, floatToPcm16 } from "./lib/audio";
import { getBridge } from "./lib/bridge";
import type { AudioInputDevice, AudioStats, CaptureSource, MediaFile, ServiceLog, ServiceStatus, TranscriptSegment } from "./types";

const TARGET_SAMPLE_RATE = 16_000;

type CaptureState = "idle" | "starting" | "running" | "stopping";
type SocketState = "offline" | "connecting" | "online" | "error";
type FileProgress = {
  stage: string;
  percent: number | null;
  current: number;
  total: number;
};

type RuntimeRefs = {
  streams?: MediaStream[];
  socket?: WebSocket;
  audioContext?: AudioContext;
  nodes?: AudioNode[];
  recorder?: MediaRecorder;
  recordingChunks?: Blob[];
  packets?: number;
  lastStatsAt?: number;
};

const defaultStatus: ServiceStatus = { running: false, port: 8765, pid: null };
const emptyAudioStats = (): AudioStats => ({ tracks: 0, peak: 0, rms: 0, packets: 0 });
const bridge = getBridge();

export function App() {
  const [appVersion, setAppVersion] = useState("");
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>(defaultStatus);
  const [captureState, setCaptureState] = useState<CaptureState>("idle");
  const [socketState, setSocketState] = useState<SocketState>("offline");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [logs, setLogs] = useState<ServiceLog[]>([]);
  const [language, setLanguage] = useState("auto");
  const [audioInputs, setAudioInputs] = useState<AudioInputDevice[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState("default");
  const [exportDirectory, setExportDirectory] = useState(() => localStorage.getItem("exportDirectory") || "");
  const [autoExport, setAutoExport] = useState(() => localStorage.getItem("autoExport") !== "false");
  const [recordAudio, setRecordAudio] = useState(() => localStorage.getItem("recordAudio") !== "false");
  const [fileSpeakers, setFileSpeakers] = useState(() => localStorage.getItem("fileSpeakers") !== "false");
  const [updateStatus, setUpdateStatus] = useState<Record<string, unknown>>({ status: "idle" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeHitIndex, setActiveHitIndex] = useState(0);
  const [lastAudioChunks, setLastAudioChunks] = useState<Blob[]>([]);
  const [fileProgress, setFileProgress] = useState<FileProgress | null>(null);
  const [mediaFile, setMediaFile] = useState<MediaFile | null>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean; path?: string } | null>(null);
  const [audioStats, setAudioStats] = useState({
    desktop: emptyAudioStats(),
    mic: emptyAudioStats(),
  });
  const runtime = useRef<RuntimeRefs>({});
  // Keep the complete session, including messages received before React renders.
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const mediaFileRef = useRef<MediaFile | null>(null);
  const fileTranscriptPath = useRef<string | null>(null);
  const exportBusy = useRef(false);
  const exportSettings = useRef({ autoExport, exportDirectory });
  exportSettings.current = { autoExport, exportDirectory };

  useEffect(() => {
    bridge.getAppVersion().then(setAppVersion);
    refreshSources();
    refreshAudioInputs();
    bridge.getServiceStatus().then(setServiceStatus);
    if (!exportDirectory) {
      bridge.getDefaultExportDirectory().then((directory) => {
        if (!directory) return;
        setExportDirectory(directory);
        localStorage.setItem("exportDirectory", directory);
      });
    }

    const offLog = bridge.onServiceLog((log) => {
      setLogs((current) => [...current.slice(-120), log]);
    });
    const offStatus = bridge.onServiceStatus(setServiceStatus);
    const offUpdate = bridge.onUpdateStatus(setUpdateStatus);

    return () => {
      offLog();
      offStatus();
      offUpdate();
      stopCapture();
    };
  }, []);

  async function refreshSources() {
    const nextSources = await bridge.getSources();
    setSources(nextSources);
    setSelectedSourceId((current) => current || nextSources.find((source) => source.id.startsWith("screen:"))?.id || nextSources[0]?.id || "");
  }

  async function refreshAudioInputs() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
      }));

    setAudioInputs(inputs);
    setSelectedAudioInputId((current) => current || inputs[0]?.id || "default");
  }

  async function startService() {
    const status = await bridge.startService();
    setServiceStatus(status);
  }

  async function toggleService() {
    if (serviceStatus.running) {
      await stopCapture();
      setServiceStatus(await bridge.stopService());
      return;
    }

    await startService();
  }

  async function chooseExportDirectory() {
    const directory = await bridge.chooseExportDirectory();
    if (!directory) return;
    setExportDirectory(directory);
    localStorage.setItem("exportDirectory", directory);
  }

  async function openExportDirectory() {
    try {
      await bridge.openExportDirectory(exportDirectory);
    } catch (error) {
      setNotice({ text: `Could not open export folder: ${String(error)}`, error: true });
    }
  }

  function updateAutoExport(enabled: boolean) {
    setAutoExport(enabled);
    localStorage.setItem("autoExport", String(enabled));
  }

  function updateRecordAudio(enabled: boolean) {
    setRecordAudio(enabled);
    localStorage.setItem("recordAudio", String(enabled));
  }

  async function startConfiguredSocket(fileSession = false) {
    let activeStatus = serviceStatus;
    if (!activeStatus.running) {
      activeStatus = await bridge.startService();
      setServiceStatus(activeStatus);
    }

    const socket = await connectTranscriptionSocket(activeStatus.port || 8765);
    runtime.current.socket = socket;

    socket.onmessage = (event) => {
      if (runtime.current.socket !== socket) return;
      const message = JSON.parse(event.data);
      if (message.type === "segment") {
        upsertSegment(message.segment);
      }
      if (message.type === "progress") {
        setFileProgress(message.progress);
      }
      if (message.type === "status") {
        setLogs((current) => [...current.slice(-120), { stream: "status", text: message.message }]);
      }
      if (message.type === "file_complete" || message.type === "file_error") {
        runtime.current.socket = undefined;
        setCaptureState("idle");
        socket.close();
        if (message.type === "file_error") {
          setFileProgress((current) => current && { ...current, stage: "error", percent: null });
          setNotice({ text: `${message.message}${fileTranscriptPath.current ? " Completed text is saved to the TXT file." : ""}`, error: true, path: fileTranscriptPath.current ?? undefined });
        } else if (message.transcriptPath) {
          setNotice({ text: `Saved ${message.transcriptPath} · ${message.segments} segments · ${message.speakers ?? 1} speakers`, path: message.transcriptPath });
        } else {
          void exportSession({ includeText: true, includeAudio: false });
        }
      }
    };

    socket.onerror = () => setSocketState("error");
    socket.onclose = () => {
      setSocketState("offline");
      if (fileSession && runtime.current.socket === socket) {
        runtime.current.socket = undefined;
        setCaptureState("idle");
        setFileProgress((current) => current && { ...current, stage: "error", percent: null });
        setNotice({ text: "File transcription was interrupted. Completed text is saved in the TXT file.", path: fileTranscriptPath.current ?? undefined, error: true });
      }
    };

    setSocketState("online");
    socket.send(JSON.stringify({
      type: "configure",
      sampleRate: TARGET_SAMPLE_RATE,
      language: language === "auto" ? null : language,
      diarization: fileSession && fileSpeakers,
    }));

    return socket;
  }

  async function startCapture() {
    if (!selectedSourceId || captureState !== "idle") return;

    setFileProgress(null);
    setCaptureState("starting");
    setSocketState("connecting");
    await bridge.setCaptureSource(selectedSourceId);

    try {
      await startConfiguredSocket();
      clearTranscript();

      const desktopStream = await captureDesktopStream(selectedSourceId, (text) => {
        setLogs((current) => [...current.slice(-120), { stream: "status", text }]);
      });
      let micStream: MediaStream | undefined;
      if (selectedAudioInputId !== "none") {
        try {
          micStream = await captureMicrophoneStream(selectedAudioInputId);
        } catch (error) {
          setLogs((current) => [...current.slice(-120), { stream: "stderr", text: `microphone capture failed: ${String(error)}` }]);
        }
      }
      const streams = [desktopStream, micStream].filter((stream): stream is MediaStream => Boolean(stream));
      runtime.current.streams = streams;

      const desktopTrackCount = desktopStream.getAudioTracks().length;
      const micTrackCount = micStream?.getAudioTracks().length ?? 0;
      setAudioStats({ desktop: emptyAudioStats(), mic: emptyAudioStats() });
      setLogs((current) => [...current.slice(-120), { stream: "status", text: `capture desktop tracks=${desktopTrackCount} mic tracks=${micTrackCount}` }]);
      if (desktopTrackCount === 0) {
        throw new Error("Desktop capture returned no audio track. Pick a full screen source and make sure system audio is playing.");
      }

      const audioContext = new AudioContext();
      const nodes = [
        ...attachAudioPipeline("desktop", desktopStream, audioContext, desktopTrackCount, () => runtime.current.socket, setAudioStats),
        ...(micStream ? attachAudioPipeline("mic", micStream, audioContext, micTrackCount, () => runtime.current.socket, setAudioStats) : []),
      ];
      const recordingChunks: Blob[] = [];
      const recorder = recordAudio ? startStereoRecording(audioContext, desktopStream, micStream, nodes, recordingChunks) : undefined;

      runtime.current = { ...runtime.current, audioContext, nodes, recorder, recordingChunks };
      setCaptureState("running");
    } catch (error) {
      setLogs((current) => [...current.slice(-120), { stream: "stderr", text: String(error) }]);
      await stopCapture();
    }
  }

  async function transcribeMediaFile() {
    if (captureState !== "idle") return;
    const file = await bridge.chooseMediaFile();
    if (!file) return;

    setFileProgress({ stage: "starting", percent: 0, current: 0, total: 0 });
    setCaptureState("starting");
    setSocketState("connecting");
    setLogs((current) => [...current.slice(-120), { stream: "status", text: `selected file: ${file.name}` }]);

    try {
      const output = await bridge.createFileTranscript({ directory: exportSettings.current.exportDirectory, fileName: file.name });
      const socket = await startConfiguredSocket(true);
      clearTranscript();
      fileTranscriptPath.current = output.transcriptPath;
      setExportDirectory(output.directory);
      localStorage.setItem("exportDirectory", output.directory);
      setNotice({ text: `Saving TXT automatically: ${output.transcriptPath}`, path: output.transcriptPath });
      mediaFileRef.current = file;
      setMediaFile(file);
      setCaptureState("running");
      socket.send(JSON.stringify({
        type: "file",
        source: "desktop",
        path: file.path,
        transcriptPath: output.transcriptPath,
      }));
    } catch (error) {
      setNotice({ text: `Could not transcribe file: ${String(error)}`, error: true });
      setFileProgress((current) => current && { ...current, stage: "error", percent: null });
      setLogs((current) => [...current.slice(-120), { stream: "stderr", text: String(error) }]);
      await stopCapture();
    }
  }

  async function stopCapture() {
    if (captureState === "stopping") return;
    setCaptureState("stopping");

    const stoppedRuntime = runtime.current;
    const stoppedSegments = [...segmentsRef.current];
    await stopRecorder(stoppedRuntime.recorder);
    setLastAudioChunks([...(stoppedRuntime.recordingChunks ?? [])]);
    runtime.current.nodes?.forEach((node) => node.disconnect());
    runtime.current.streams?.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    const stoppedSocket = runtime.current.socket;
    runtime.current.socket = undefined;
    stoppedSocket?.close();
    await runtime.current.audioContext?.close().catch(() => undefined);

    runtime.current = {};
    setSocketState("offline");
    setCaptureState("idle");
    setFileProgress((current) => current && current.stage !== "complete" && current.stage !== "error" ? { ...current, stage: "stopped", percent: null } : current);

    if (!mediaFileRef.current && autoExport && exportDirectory && stoppedSegments.some((segment) => !segment.partial)) {
      await exportSession({ sourceSegments: stoppedSegments, audioChunks: stoppedRuntime.recordingChunks ?? [], includeText: true, includeAudio: true });
    }
  }

  function upsertSegment(segment: TranscriptSegment) {
    const current = segmentsRef.current;
    const index = current.findIndex((item) => item.id === segment.id);
    const next = [...current];
    if (index === -1) next.push(segment);
    else next[index] = segment;
    segmentsRef.current = next;
    setSegments(next);
  }

  function clearTranscript() {
    segmentsRef.current = [];
    setSegments([]);
    mediaFileRef.current = null;
    fileTranscriptPath.current = null;
    setMediaFile(null);
    setNotice(null);
    setSearchQuery("");
    setActiveHitIndex(0);
    setLastAudioChunks([]);
  }

  async function copyTranscript() {
    await bridge.writeClipboardText(buildTranscriptText(segments));
    setLogs((current) => [...current.slice(-120), { stream: "status", text: "transcript copied" }]);
  }

  async function exportSession({
    sourceSegments = segmentsRef.current,
    audioChunks = runtime.current.recordingChunks ?? lastAudioChunks,
    includeText = true,
    includeAudio = true,
  }: {
    sourceSegments?: TranscriptSegment[];
    audioChunks?: Blob[];
    includeText?: boolean;
    includeAudio?: boolean;
  } = {}) {
    if (exportBusy.current) return;
    exportBusy.current = true;
    setExporting(true);
    setNotice({ text: "Exporting…" });
    try {
      const directory = exportSettings.current.exportDirectory || await bridge.getDefaultExportDirectory();
      if (!directory) throw new Error("Choose an export folder first.");
      const finalText = includeText ? buildTranscriptText(sourceSegments) : undefined;
      const audioSourcePath = includeAudio ? mediaFileRef.current?.path : undefined;
      const hasAudio = Boolean(audioSourcePath || audioChunks.length);
      if (includeText && !finalText) throw new Error("There is no finalized transcript to export yet.");
      if (includeAudio && !includeText && !hasAudio) throw new Error("No audio is available. Transcribe a file or enable audio recording before listening.");
      const audioBase64 = includeAudio && !audioSourcePath && audioChunks.length > 0 ? await blobToBase64(new Blob(audioChunks, { type: "audio/webm" })) : undefined;
      const result = await bridge.saveSessionExport({
        directory,
        baseName: `livescriber-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        transcriptText: finalText,
        audioBase64,
        audioSourcePath,
        includeText,
        includeAudio: includeAudio && hasAudio,
      });
      const paths = [result.textPath, result.audioPath].filter(Boolean);
      if (!paths.length) throw new Error("No files were exported.");
      const text = `Saved ${paths.join(" and ")}${result.audioError ? `. Audio export failed: ${result.audioError}` : ""}`;
      setNotice({ text, path: paths[0]!, error: Boolean(result.audioError) });
      setLogs((current) => [...current.slice(-120), { stream: result.audioError ? "stderr" : "status", text }]);
    } catch (error) {
      const text = `Export failed: ${String(error)}`;
      setNotice({ text, error: true });
      setLogs((current) => [...current.slice(-120), { stream: "stderr", text }]);
    } finally {
      exportBusy.current = false;
      setExporting(false);
    }
  }

  const livePartials = [...segments]
    .filter((segment) => segment.partial)
    .reduce<Record<string, TranscriptSegment>>((current, segment) => {
      current[segment.speaker] = segment;
      return current;
    }, {});
  const finalSegments = segments
    .filter((segment) => !segment.partial)
    .sort((a, b) => mediaFile ? a.start - b.start || a.end - b.end : b.end - a.end);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  let runningHitCount = 0;
  const searchRows = finalSegments.map((segment) => {
    const hitCount = normalizedSearch ? countMatches(segment.text, normalizedSearch) : 0;
    const startHitIndex = runningHitCount;
    runningHitCount += hitCount;
    return { segment, hitCount, startHitIndex };
  });
  const visibleRows = normalizedSearch ? searchRows.filter((row) => row.hitCount > 0) : searchRows;
  const totalHits = runningHitCount;

  useEffect(() => {
    setActiveHitIndex((current) => Math.min(Math.max(current, 0), Math.max(totalHits - 1, 0)));
  }, [totalHits]);

  useEffect(() => {
    document.querySelector("[data-active-search='true']")?.scrollIntoView({ block: "center" });
  }, [activeHitIndex, searchQuery]);

  return (
    <div className="app-root">
      <header className="window-bar">
        <div className="window-drag">
          <Captions size={15} />
          <span>Livescriber {appVersion}</span>
        </div>
        <div className="window-actions">
          <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Settings">
            <Settings size={15} />
          </button>
          <button type="button" onClick={() => setLogOpen((open) => !open)} aria-label="Toggle engine log">
            <PanelRight size={15} />
          </button>
          <button type="button" onClick={() => bridge.minimizeWindow()} aria-label="Minimize">
            <Minus size={15} />
          </button>
          <button type="button" onClick={() => bridge.maximizeWindow()} aria-label="Maximize">
            <Maximize2 size={14} />
          </button>
          <button type="button" onClick={() => bridge.closeWindow()} aria-label="Close">
            <X size={15} />
          </button>
        </div>
      </header>

      <main className={`app-shell ${logOpen ? "log-open" : "log-closed"}`}>
      <section className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Captions size={21} />
          </div>
          <div>
            <h1>Livescriber</h1>
            <p>Local desktop transcription</p>
          </div>
          <button className="ghost-icon-button brand-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
            <Settings size={16} />
          </button>
        </div>

        <div className="control-group">
          <label htmlFor="source">Audio source</label>
          <div className="select-wrap">
            <select
              id="source"
              value={selectedSourceId}
              onChange={(event) => setSelectedSourceId(event.target.value)}
              disabled={captureState !== "idle"}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.name}</option>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
          <button className="ghost-button" type="button" onClick={refreshSources}>
            <RefreshCw size={16} />
            Refresh sources
          </button>
        </div>

        <div className="control-group">
          <label htmlFor="microphone">Microphone</label>
          <div className="select-wrap">
            <select
              id="microphone"
              value={selectedAudioInputId}
              onChange={(event) => setSelectedAudioInputId(event.target.value)}
              disabled={captureState !== "idle"}
            >
              <option value="none">No microphone</option>
              <option value="default">Default microphone</option>
              {audioInputs.map((device) => (
                <option key={device.id} value={device.id}>{device.label}</option>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
        </div>

        <div className="control-group">
          <label htmlFor="language">Language</label>
          <div className="select-wrap">
            <select id="language" value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="auto">Auto detect</option>
              <option value="en">English</option>
              <option value="ru">Russian</option>
              <option value="de">German</option>
            </select>
            <ChevronDown size={16} />
          </div>
        </div>

        <div className="action-stack">
          <button className="primary-button" type="button" onClick={captureState === "running" ? stopCapture : startCapture} disabled={exporting || captureState === "starting" || captureState === "stopping"}>
            {captureState === "running" ? <CircleStop size={18} /> : <Play size={18} />}
            {captureState === "running" ? mediaFile ? "Stop transcription" : "Stop listening" : "Start listening"}
          </button>
          <button className="secondary-button" type="button" onClick={transcribeMediaFile} disabled={captureState !== "idle" || exporting}>
            <FileUp size={18} />
            Transcribe file
          </button>
          {fileProgress && (
            <div className="file-progress">
              <div>
                <span>{fileProgressLabel(fileProgress)}</span>
                <strong>{["error", "stopped"].includes(fileProgress.stage) ? "" : fileProgress.percent === null ? "Working" : `${Math.round(fileProgress.percent * 100)}%`}</strong>
              </div>
              <div className={fileProgress.percent === null && !["error", "stopped"].includes(fileProgress.stage) ? "progress-track indeterminate" : "progress-track"}>
                <i style={{ width: `${Math.max(3, Math.round((fileProgress.percent ?? 0.08) * 100))}%` }} />
              </div>
            </div>
          )}
          <button className="secondary-button" type="button" onClick={toggleService}>
            <Cpu size={18} />
            {serviceStatus.running ? "Stop model" : "Start model"}
          </button>
        </div>

        <div className="sidebar-export">
          <p className="eyebrow">Export</p>
          <button className="secondary-button" type="button" onClick={() => exportSession({ includeText: true, includeAudio: false })} disabled={exporting}>
            <FileText size={16} />
            Export TXT
          </button>
          <button className="secondary-button" type="button" onClick={() => exportSession({ includeText: false, includeAudio: true })} disabled={exporting}>
            <FileAudio size={16} />
            Export audio
          </button>
          <button className="ghost-button" type="button" onClick={openExportDirectory}>
            <Save size={16} />
            Folder
          </button>
        </div>

        <div className="status-grid">
          <StatusTile icon={<Cpu size={17} />} label="Model" value={serviceStatus.installing ? "Installing backend" : serviceStatus.running ? `PID ${serviceStatus.pid}` : "Stopped"} tone={serviceStatus.running ? "good" : serviceStatus.installing ? "warn" : "muted"} />
          <StatusTile icon={<Activity size={17} />} label="Socket" value={socketState} tone={socketState === "online" ? "good" : socketState === "error" ? "bad" : "muted"} />
          <StatusTile icon={<Mic2 size={17} />} label="Capture" value={captureState} tone={captureState === "running" ? "good" : "muted"} />
        </div>

        <div className="audio-meter">
          <AudioMeter label="Desktop" stats={audioStats.desktop} />
          <AudioMeter label="Mic" stats={audioStats.mic} />
        </div>
      </section>

      <section className="transcript-panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">{mediaFile ? "File transcript" : "Live transcript"} · {finalSegments.length} segments</p>
            <h2 className="transcript-title" title={mediaFile?.name}>{mediaFile?.name || "Desktop audio"}</h2>
          </div>
          <div className="transcript-tools">
            <div className="search-box">
              <Search size={15} />
              <input
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setActiveHitIndex(0);
                }}
                placeholder="Search transcript"
              />
              {normalizedSearch && <span>{totalHits}</span>}
              <button type="button" onClick={() => setActiveHitIndex((current) => totalHits ? (current + totalHits - 1) % totalHits : 0)} disabled={!totalHits} aria-label="Previous search result">
                <ChevronLeft size={14} />
              </button>
              <button type="button" onClick={() => setActiveHitIndex((current) => totalHits ? (current + 1) % totalHits : 0)} disabled={!totalHits} aria-label="Next search result">
                <ChevronRight size={14} />
              </button>
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery("")} aria-label="Clear search">
                  <X size={14} />
                </button>
              )}
            </div>
            <button className="ghost-icon-button" type="button" onClick={clearTranscript} aria-label="Clear transcript" disabled={captureState !== "idle" || exporting}>
              <SquareActivity size={18} />
            </button>
            <button className="ghost-icon-button" type="button" onClick={copyTranscript} aria-label="Copy transcript">
              <Clipboard size={18} />
            </button>
          </div>
        </header>

        {!normalizedSearch && !mediaFile && (
          <div className="live-pair">
            <LiveLane speaker="Speaker 1" segment={livePartials["Speaker 1"]} />
            <LiveLane speaker="Speaker 2" segment={livePartials["Speaker 2"]} />
          </div>
        )}

        <div className="transcript-list">
          {visibleRows.length === 0 ? (
            <div className="empty-state">
              <Captions size={34} />
              <p>{normalizedSearch ? "No matching transcript segments." : "No finalized transcript segments yet."}</p>
            </div>
          ) : (
            visibleRows.map(({ segment, startHitIndex, hitCount }) => (
              <article
                className={`segment ${speakerClass(segment.speaker)}`}
                key={segment.id}
                data-active-search={normalizedSearch && activeHitIndex >= startHitIndex && activeHitIndex < startHitIndex + hitCount ? "true" : undefined}
              >
                <div className="speaker-pill">{segment.speaker}</div>
                <p>{renderHighlightedText(segment.text, normalizedSearch, startHitIndex, activeHitIndex)}</p>
                <time>{formatTime(segment.start)} - {formatTime(segment.end)}</time>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="log-panel">
        <header className="panel-header compact">
          <div>
            <p className="eyebrow">Runtime</p>
            <h2>Engine log</h2>
          </div>
          <button className="ghost-icon-button" type="button" onClick={() => setLogOpen(false)} aria-label="Close engine log">
            <X size={16} />
          </button>
        </header>
        <div className="log-list">
          {logs.length === 0 ? (
            <p className="muted-text">No backend messages.</p>
          ) : (
            logs.map((log, index) => (
              <pre key={`${log.stream}-${index}`} className={log.stream}>{log.text.trim()}</pre>
            ))
          )}
        </div>
      </section>
      </main>
      {notice && (
        <div className={`session-notice ${notice.error ? "error" : ""}`} role={notice.error ? "alert" : "status"}>
          <p>{notice.text}</p>
          {notice.path && <button className="secondary-button" type="button" onClick={() => bridge.showExportInFolder(notice.path!)}>Show in folder</button>}
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Livescriber</p>
                <h2 id="settings-title">Settings</h2>
              </div>
              <button className="ghost-icon-button" type="button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
                <X size={16} />
              </button>
            </header>

            <div className="modal-section">
              <h3>Export</h3>
              <p className="path-text">File transcripts always save to TXT automatically as speech is transcribed.</p>
              <label className="check-row">
                <input type="checkbox" checked={fileSpeakers} disabled={captureState !== "idle"} onChange={(event) => { setFileSpeakers(event.target.checked); localStorage.setItem("fileSpeakers", String(event.target.checked)); }} />
                Identify speakers in files
              </label>
              <label className="check-row">
                <input type="checkbox" checked={recordAudio} onChange={(event) => updateRecordAudio(event.target.checked)} disabled={captureState !== "idle"} />
                Record stereo audio
              </label>
              <label className="check-row">
                <input type="checkbox" checked={autoExport} onChange={(event) => updateAutoExport(event.target.checked)} />
                Export live transcript and audio on stop
              </label>
              <div className="folder-row">
                <button className="ghost-button" type="button" onClick={chooseExportDirectory}>
                  <Save size={16} />
                  Change folder
                </button>
                <p className="path-text">{exportDirectory}</p>
              </div>
            </div>

            <div className="modal-section">
              <h3>Updates</h3>
              <div className="split-actions">
                <button className="secondary-button" type="button" onClick={() => bridge.checkForUpdates()}>
                  <RefreshCw size={16} />
                  Check updates
                </button>
                <button className="secondary-button" type="button" onClick={() => bridge.installUpdate()} disabled={updateStatus.status !== "downloaded"}>
                  <Download size={16} />
                  Install
                </button>
              </div>
              <p className="path-text">Status: {String(updateStatus.status ?? "idle")}</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function StatusTile({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: "good" | "bad" | "warn" | "muted" }) {
  return (
    <div className={`status-tile ${tone}`}>
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function AudioMeter({ label, stats }: { label: string; stats: AudioStats }) {
  return (
    <div className="audio-meter-row">
      <div>
        <span>{label}</span>
        <strong>{stats.tracks} track / {Math.round(stats.rms * 100)}%</strong>
      </div>
      <div className="meter-track">
        <div style={{ width: `${Math.min(100, stats.rms * 220)}%` }} />
      </div>
      <p>peak {Math.round(stats.peak * 100)}% / packets {stats.packets}</p>
    </div>
  );
}

function fileProgressLabel(progress: FileProgress) {
  if (progress.stage === "speakers") return progress.percent === null ? "Preparing speaker detection" : `Identifying speakers ${Math.round(progress.percent * 100)}%`;
  if (progress.stage === "error") return "Transcription failed";
  if (progress.stage === "stopped") return "Stopped";
  const stage = progress.stage === "retry" ? "Retrying without VAD" : progress.stage === "decode" ? "Reading audio" : progress.stage === "complete" ? "Complete" : "Transcribing";
  if (!progress.total || progress.percent === null) return stage;
  return `${stage} ${formatTime(progress.current)} / ${formatTime(progress.total)}`;
}

function LiveLane({ speaker, segment }: { speaker: "Speaker 1" | "Speaker 2"; segment?: TranscriptSegment }) {
  const text = segment?.text || (speaker === "Speaker 1" ? "Waiting for desktop audio." : "Waiting for microphone.");

  return (
    <div className={`live-strip ${speakerClass(speaker)}`}>
      <span className={`speaker-pill ${speakerClass(speaker)}`}>{speaker}</span>
      <p>{text}</p>
    </div>
  );
}

async function connectTranscriptionSocket(port: number) {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 120_000) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/transcribe`);
    try {
      await waitForSocket(socket, 1_500);
      return socket;
    } catch (error) {
      lastError = error;
      socket.close();
      await delay(700);
    }
  }

  throw new Error(`Could not connect to local transcription service. ${String(lastError)}`);
}

async function captureDesktopStream(sourceId: string, log: (text: string) => void) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "desktop",
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          maxWidth: 16,
          maxHeight: 16,
          maxFrameRate: 1,
        },
      },
    } as unknown as MediaStreamConstraints);
    log("capture method=legacy desktop getUserMedia");
    return stream;
  } catch (error) {
    log(`legacy capture failed: ${String(error)}`);
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: { frameRate: 1, width: 16, height: 16 },
  });
  log("capture method=getDisplayMedia loopback");
  return stream;
}

async function captureMicrophoneStream(deviceId: string) {
  return navigator.mediaDevices.getUserMedia({
    audio: deviceId === "default" ? true : { deviceId: { exact: deviceId } },
    video: false,
  });
}

function attachAudioPipeline(
  sourceName: "desktop" | "mic",
  stream: MediaStream,
  audioContext: AudioContext,
  trackCount: number,
  getSocket: () => WebSocket | undefined,
  setAudioStats: Dispatch<SetStateAction<{ desktop: AudioStats; mic: AudioStats }>>,
) {
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mute = audioContext.createGain();
  let packets = 0;
  let lastStatsAt = 0;
  mute.gain.value = 0;

  processor.onaudioprocess = (event) => {
    const activeSocket = getSocket();
    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleFloat32(input, audioContext.sampleRate, TARGET_SAMPLE_RATE);
    const pcm = floatToPcm16(downsampled);
    const stats = getAudioStats(input);
    packets += 1;

    const now = Date.now();
    if (now - lastStatsAt > 500) {
      lastStatsAt = now;
      setAudioStats((current) => ({
        ...current,
        [sourceName]: {
          tracks: trackCount,
          peak: stats.peak,
          rms: stats.rms,
          packets,
        },
      }));
    }

    activeSocket.send(JSON.stringify({
      type: "audio",
      source: sourceName,
      payload: arrayBufferToBase64(pcm.buffer),
    }));
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioContext.destination);
  return [source, processor, mute];
}

function startStereoRecording(
  audioContext: AudioContext,
  desktopStream: MediaStream,
  micStream: MediaStream | undefined,
  nodes: AudioNode[],
  chunks: Blob[],
) {
  const destination = audioContext.createMediaStreamDestination();
  const merger = audioContext.createChannelMerger(2);
  const desktopSource = audioContext.createMediaStreamSource(desktopStream);
  const micSource = micStream ? audioContext.createMediaStreamSource(micStream) : undefined;

  desktopSource.connect(merger, 0, 0);
  if (micSource) {
    micSource.connect(merger, 0, 1);
  }
  merger.connect(destination);
  nodes.push(desktopSource, merger, destination);
  if (micSource) nodes.push(micSource);

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const recorder = new MediaRecorder(destination.stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start(1000);
  return recorder;
}

function stopRecorder(recorder: MediaRecorder | undefined) {
  if (!recorder || recorder.state === "inactive") return Promise.resolve();

  return new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.stop();
  });
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

function buildTranscriptText(sourceSegments: TranscriptSegment[]) {
  return sourceSegments
    .filter((segment) => !segment.partial)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((segment) => `[${formatTime(segment.start)} - ${formatTime(segment.end)}] ${segment.speaker}: ${segment.text}`)
    .join("\n");
}

function speakerClass(speaker: string) {
  const number = Number(speaker.match(/\d+/)?.[0] ?? 0);
  return number === 1 ? "speaker-one" : number === 2 ? "speaker-two" : number ? `speaker-extra speaker-${number % 4}` : "speaker-unknown";
}

function countMatches(text: string, query: string) {
  if (!query) return 0;
  let count = 0;
  let index = text.toLowerCase().indexOf(query);
  while (index !== -1) {
    count += 1;
    index = text.toLowerCase().indexOf(query, index + query.length);
  }
  return count;
}

function renderHighlightedText(text: string, query: string, startHitIndex: number, activeHitIndex: number) {
  if (!query) return text;

  const output: ReactNode[] = [];
  const lowerText = text.toLowerCase();
  let cursor = 0;
  let localHit = 0;
  let index = lowerText.indexOf(query);

  while (index !== -1) {
    if (index > cursor) output.push(text.slice(cursor, index));
    const globalHit = startHitIndex + localHit;
    output.push(
      <mark className={globalHit === activeHitIndex ? "active-match" : ""} key={`${index}-${globalHit}`}>
        {text.slice(index, index + query.length)}
      </mark>,
    );
    cursor = index + query.length;
    localHit += 1;
    index = lowerText.indexOf(query, cursor);
  }

  if (cursor < text.length) output.push(text.slice(cursor));
  return output;
}

function waitForSocket(socket: WebSocket, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Timed out waiting for service.")), timeoutMs);
    socket.addEventListener("open", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      window.clearTimeout(timer);
      reject(new Error("Service is not listening yet."));
    }, { once: true });
  });
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getAudioStats(input: Float32Array) {
  let peak = 0;
  let sumSquares = 0;

  for (let i = 0; i < input.length; i += 1) {
    const abs = Math.abs(input[i]);
    if (abs > peak) peak = abs;
    sumSquares += input[i] * input[i];
  }

  return {
    peak,
    rms: Math.sqrt(sumSquares / input.length),
  };
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}
