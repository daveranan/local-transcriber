const { contextBridge, ipcRenderer } = require("electron");

function listen(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("liveScriber", {
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  getSources: () => ipcRenderer.invoke("capture:get-sources"),
  setCaptureSource: (sourceId) => ipcRenderer.invoke("capture:set-source", sourceId),
  chooseMediaFile: () => ipcRenderer.invoke("file:choose-media"),
  createFileTranscript: (payload) => ipcRenderer.invoke("file:create-transcript", payload),
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  startService: () => ipcRenderer.invoke("service:start"),
  stopService: () => ipcRenderer.invoke("service:stop"),
  getServiceStatus: () => ipcRenderer.invoke("service:status"),
  chooseExportDirectory: () => ipcRenderer.invoke("export:choose-directory"),
  getDefaultExportDirectory: () => ipcRenderer.invoke("export:default-directory"),
  openExportDirectory: (directory) => ipcRenderer.invoke("export:open-directory", directory),
  saveSessionExport: (payload) => ipcRenderer.invoke("export:save-session", payload),
  showExportInFolder: (filePath) => ipcRenderer.invoke("export:show-in-folder", filePath),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window:maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  onServiceLog: (callback) => listen("service:log", callback),
  onServiceStatus: (callback) => listen("service:status", callback),
  onUpdateStatus: (callback) => listen("update:status", callback),
});
