import type { LiveScriberBridge } from "../types";

const fallbackBridge: LiveScriberBridge = {
  getSources: async () => [],
  setCaptureSource: async () => true,
  chooseMediaFile: async () => null,
  writeClipboardText: async () => true,
  startService: async () => ({ running: false, port: 8765, pid: null }),
  stopService: async () => ({ running: false, port: 8765, pid: null }),
  getServiceStatus: async () => ({ running: false, port: 8765, pid: null }),
  chooseExportDirectory: async () => null,
  getDefaultExportDirectory: async () => "",
  saveSessionExport: async () => ({ textPath: "", audioPath: null }),
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
