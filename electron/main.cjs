const { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, session, globalShortcut } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let mainWindow;
let tray;
let isQuitting = false;
let selectedSourceId = null;
let serviceProcess = null;
let serviceStatus = { running: false, port: 8765, pid: null };

const appDir = app.isPackaged ? app.getAppPath() : path.join(__dirname, "..");
const resourceDir = app.isPackaged ? process.resourcesPath : appDir;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    title: "Livescriber",
    frame: false,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(appDir, "dist", "index.html"));
  }
}

function makeTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#151922"/><path d="M20 33c0 7 5 12 12 12s12-5 12-12" fill="none" stroke="#f2f4f8" stroke-width="5" stroke-linecap="round"/><rect x="25" y="12" width="14" height="25" rx="7" fill="#4fd1c5"/><path d="M32 45v8M25 53h14" stroke="#f2f4f8" stroke-width="5" stroke-linecap="round"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function createTray() {
  tray = new Tray(makeTrayIcon().resize({ width: 16, height: 16 }));
  tray.setToolTip("Livescriber");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Livescriber", click: () => mainWindow?.show() },
    { label: "Hide", click: () => mainWindow?.hide() },
    { type: "separator" },
    { label: "Quit", click: () => quitApp() },
  ]));
  tray.on("double-click", () => mainWindow?.show());
}

function configureDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
    });
    const preferred = sources.find((source) => source.id === selectedSourceId);
    const fallback = sources.find((source) => source.id.startsWith("screen:")) ?? sources[0];
    callback({ video: preferred ?? fallback, audio: "loopback" });
  }, { useSystemPicker: false });
}

function configureMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    const isLocalRenderer = url.startsWith("file://") || url.startsWith("http://127.0.0.1:");
    callback(isLocalRenderer && permission === "media");
  });
}

function getPythonCommand() {
  const candidates = [
    path.join(resourceDir, ".venv", "Scripts", "python.exe"),
    path.join(path.dirname(process.execPath), ".venv", "Scripts", "python.exe"),
    path.join(appDir, ".venv", "Scripts", "python.exe"),
    path.join(resourceDir, "venv", "Scripts", "python.exe"),
    path.join(appDir, "venv", "Scripts", "python.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "python";
}

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows().forEach((win) => win.webContents.send(channel, payload));
}

function startService() {
  if (serviceProcess) return serviceStatus;

  const script = path.join(resourceDir, "backend", "transcriber_service.py");
  if (!fs.existsSync(script)) {
    throw new Error(`Missing backend service at ${script}`);
  }

  const port = Number(process.env.LIVE_SCRIBER_PORT ?? 8765);
  const python = getPythonCommand();
  serviceProcess = spawn(python, [script], {
    cwd: resourceDir,
    env: {
      ...process.env,
      LIVE_SCRIBER_PORT: String(port),
      HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      PYTHONUNBUFFERED: "1",
    },
    windowsHide: true,
  });

  serviceStatus = { running: true, port, pid: serviceProcess.pid };
  broadcast("service:status", serviceStatus);

  serviceProcess.stdout.on("data", (chunk) => {
    broadcast("service:log", { stream: "stdout", text: chunk.toString() });
  });

  serviceProcess.stderr.on("data", (chunk) => {
    broadcast("service:log", { stream: "stderr", text: chunk.toString() });
  });

  serviceProcess.on("exit", (code, signal) => {
    broadcast("service:log", { stream: "status", text: `transcriber exited code=${code} signal=${signal}` });
    serviceProcess = null;
    serviceStatus = { running: false, port, pid: null };
    broadcast("service:status", serviceStatus);
  });

  return serviceStatus;
}

function stopService() {
  if (serviceProcess) {
    serviceProcess.kill();
    serviceProcess = null;
  }
  serviceStatus = { ...serviceStatus, running: false, pid: null };
  broadcast("service:status", serviceStatus);
  return serviceStatus;
}

function quitApp() {
  isQuitting = true;
  stopService();
  app.quit();
}

function configureUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.on("checking-for-update", () => broadcast("update:status", { status: "checking" }));
  autoUpdater.on("update-available", (info) => broadcast("update:status", { status: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => broadcast("update:status", { status: "none" }));
  autoUpdater.on("download-progress", (progress) => broadcast("update:status", { status: "downloading", percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => broadcast("update:status", { status: "downloaded", version: info.version }));
  autoUpdater.on("error", (error) => broadcast("update:status", { status: "error", message: error.message }));
}

function safeFileName(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").slice(0, 120);
}

ipcMain.handle("capture:get-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id,
    thumbnail: source.thumbnail.toDataURL(),
  }));
});

ipcMain.handle("capture:set-source", (_event, sourceId) => {
  selectedSourceId = sourceId;
  return true;
});
ipcMain.handle("file:choose-media", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Audio and video", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "webm", "mp4", "mov", "mkv", "avi"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return {
    path: result.filePaths[0],
    name: path.basename(result.filePaths[0]),
  };
});

ipcMain.handle("service:start", () => startService());
ipcMain.handle("service:stop", () => stopService());
ipcMain.handle("service:status", () => serviceStatus);
ipcMain.handle("clipboard:write-text", (_event, text) => {
  clipboard.writeText(text || "");
  return true;
});
ipcMain.handle("export:choose-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("export:default-directory", () => {
  return path.join(app.getPath("documents"), "Livescriber");
});
ipcMain.handle("export:save-session", async (_event, payload) => {
  const directory = payload.directory;
  if (!directory) {
    throw new Error("Export directory is required.");
  }
  fs.mkdirSync(directory, { recursive: true });

  const stamp = safeFileName(new Date().toISOString().replace(/[:.]/g, "-"));
  const baseName = safeFileName(payload.baseName || `livescriber-${stamp}`);
  let textPath = null;
  if (payload.includeText !== false) {
    textPath = path.join(directory, `${baseName}.txt`);
    fs.writeFileSync(textPath, payload.transcriptText || "", "utf8");
  }

  let audioPath = null;
  if (payload.includeAudio !== false && payload.audioBase64) {
    audioPath = path.join(directory, `${baseName}.webm`);
    fs.writeFileSync(audioPath, Buffer.from(payload.audioBase64, "base64"));
  }

  return { textPath, audioPath };
});
ipcMain.handle("update:check", () => {
  if (!app.isPackaged) {
    return { status: "dev" };
  }
  autoUpdater.checkForUpdatesAndNotify();
  return { status: "checking" };
});
ipcMain.handle("update:install", () => {
  autoUpdater.quitAndInstall();
});
ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:maximize", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle("window:close", () => mainWindow?.close());

app.whenReady().then(() => {
  configureUpdater();
  configureMediaPermissions();
  configureDisplayCapture();
  createWindow();
  createTray();
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
  globalShortcut.register("CommandOrControl+Shift+L", () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  stopService();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
