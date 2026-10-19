import type { LiveScriberBridge } from "../types";

const fallbackBridge: LiveScriberBridge = {
  getAppVersion: async () => "preview",
  getSources: async () => [],
  setCaptureSource: async () => true,
  chooseMediaFile: async () => null,
  createFileTranscript: async () => { throw new Error("File transcription requires the desktop app."); },
  writeClipboardText: async () => true,
  startService: async () => ({ running: false, port: 8765, pid: null }),
  stopService: async () => ({ running: false, port: 8765, pid: null }),
  getServiceStatus: async () => ({ running: false, port: 8765, pid: null }),
  chooseExportDirectory: async () => null,
  getDefaultExportDirectory: async () => "",
  openExportDirectory: async () => undefined,
  saveSessionExport: async () => ({ textPath: "", audioPath: null }),
  showExportInFolder: async () => undefined,
  checkForUpdates: async () => ({ status: "dev" }),
  installUpdate: async () => undefined,
  minimizeWindow: async () => undefined,
  maximizeWindow: async () => undefined,
  closeWindow: async () => undefined,
  onServiceLog: () => () => undefined,
  onServiceStatus: () => () => undefined,
  onUpdateStatus: () => () => undefined,
};

export function getBridge() {
  return window.liveScriber ?? fallbackBridge;
}
