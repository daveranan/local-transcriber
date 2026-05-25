export type CaptureSource = {
  id: string;
  name: string;
  displayId: string;
  thumbnail: string;
};

export type ServiceStatus = {
  running: boolean;
  port: number;
  pid: number | null;
};

export type ServiceLog = {
  stream: "stdout" | "stderr" | "status";
  text: string;
};

export type TranscriptSegment = {
  id: string;
  speaker: string;
  text: string;
  start: number;
  end: number;
  partial?: boolean;
  confidence?: number;
};

export type AudioStats = {
  tracks: number;
  peak: number;
  rms: number;
  packets: number;
};

export type AudioInputDevice = {
  id: string;
  label: string;
};

export type MediaFile = {
  path: string;
  name: string;
};

export type LiveScriberBridge = {
  getSources: () => Promise<CaptureSource[]>;
  setCaptureSource: (sourceId: string) => Promise<boolean>;
  chooseMediaFile: () => Promise<MediaFile | null>;
  writeClipboardText: (text: string) => Promise<boolean>;
  startService: () => Promise<ServiceStatus>;
  stopService: () => Promise<ServiceStatus>;
  getServiceStatus: () => Promise<ServiceStatus>;
  chooseExportDirectory: () => Promise<string | null>;
  getDefaultExportDirectory: () => Promise<string>;
  saveSessionExport: (payload: {
    directory: string;
    baseName: string;
    transcriptText?: string;
    audioBase64?: string;
    includeText?: boolean;
    includeAudio?: boolean;
  }) => Promise<{ textPath: string | null; audioPath: string | null }>;
  checkForUpdates: () => Promise<{ status: string }>;
  installUpdate: () => Promise<void>;
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  onServiceLog: (callback: (log: ServiceLog) => void) => () => void;
  onServiceStatus: (callback: (status: ServiceStatus) => void) => () => void;
  onUpdateStatus: (callback: (status: Record<string, unknown>) => void) => () => void;
};

declare global {
  interface Window {
    liveScriber?: LiveScriberBridge;
  }
}
