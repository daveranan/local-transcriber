// Run after npm run build: electron scripts/test-renderer.cjs
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { saveSessionExport, createFileTranscript } = require("../electron/session-export.cjs");
const output = path.resolve(__dirname, "../release/renderer-test");
app.setPath("userData", path.join(output, "profile"));
app.disableHardwareAcceleration();
const savedExports = [];
let exportFailure = false;
let revealed;
let openedDirectory;
let chosenDirectory = false;
let automaticFile;
const status = { running: true, port: 8765, pid: 1 };
const handlers = {
  "app:version": () => "1.0.3",
  "capture:get-sources": () => [],
  "service:status": () => status,
  "service:start": () => status,
  "service:stop": () => ({ ...status, running: false }),
  "export:default-directory": () => output,
  "export:open-directory": (_event, directory) => { openedDirectory = directory; },
  "export:choose-directory": () => { chosenDirectory = true; return output; },
  "file:create-transcript": async (_event, payload) => {
    const created = await createFileTranscript(payload.directory || output, payload.fileName);
    automaticFile = created.transcriptPath;
    // The backend's real incremental writer is covered by the Python and
    // recording checks; simulate its completed output for renderer tests.
    await fs.writeFile(automaticFile, Array.from({ length: 1200 }, (_, i) => `Sentence number ${i}\n`).join(""));
    return created;
  },
  "file:choose-media": () => ({ name: "48-minute recording.mp4", path: "fixture.mp4" }),
  "clipboard:write-text": () => true,
  "export:show-in-folder": (_event, file) => { revealed = file; },
  "export:save-session": async (_event, payload) => {
    if (exportFailure) throw new Error("Test export folder is read-only");
    const result = await saveSessionExport(payload, async (source, destination) => {
      assert.equal(source, "fixture.mp4");
      await fs.writeFile(destination, "audio fixture");
    });
    savedExports.push({ payload, result });
    return result;
  },
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const window = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { preload: path.resolve(__dirname, "../electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const run = (script) => window.webContents.executeJavaScript(script);
  async function waitFor(script) {
    const start = Date.now();
    while (!await run(`Boolean(${script})`)) {
      if (Date.now() - start > 15000) throw new Error(`Timed out: ${script}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const click = (label) => run(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  try {
    await window.loadFile(path.resolve(__dirname, "../dist/index.html"));
    await run(`localStorage.clear(); localStorage.setItem('autoExport', 'false')`);
    await window.loadFile(path.resolve(__dirname, "../dist/index.html"));
    await waitFor("document.querySelector('.sidebar-export')");
    await waitFor("document.querySelector('.window-drag').textContent.includes('1.0.3')");
    await run(`
      window.fixtureMode = 'complete';
      window.WebSocket = class extends EventTarget {
        static OPEN = 1;
        constructor() { super(); this.readyState = 1; setTimeout(() => this.dispatchEvent(new Event('open')), 0); }
        send(raw) {
          const request = JSON.parse(raw);
          if (request.type !== 'file') return;
          const emit = (message) => this.onmessage?.({ data: JSON.stringify(message) });
          if (window.fixtureMode === 'error') { emit({ type: 'file_error', message: 'The recording cannot be decoded.' }); return; }
          if (window.fixtureMode === 'disconnect') { this.close(); return; }
          for (let i = 0; i < 1200; i++) emit({ type: 'segment', segment: { id: 'segment-' + i, start: i * 2.4, end: (i + 1) * 2.4, speaker: 'Speaker ' + (Math.floor(i / 100) % 3 + 1), text: 'Sentence number ' + i, partial: false } });
          emit({ type: 'progress', progress: { stage: 'complete', percent: 1, current: 2880, total: 2880 } });
          emit({ type: 'file_complete', segments: 1200, duration: 2880, transcriptPath: request.transcriptPath, speakers: 3 });
        }
        close() { this.readyState = 3; setTimeout(() => this.onclose?.(), 0); }
      };
      void 0;
    `);
    await click("Transcribe file");
    await waitFor("document.querySelectorAll('.segment').length === 1200 && document.querySelector('.session-notice')?.textContent.includes('Saved')");
    assert.equal(savedExports.length, 0, "Automatic TXT must be saved by the file pipeline without requiring an export click");
    const autoText = await fs.readFile(automaticFile, "utf8");
    assert.equal((autoText.match(/Sentence number /g) || []).length, 1200);
    assert(autoText.indexOf("Sentence number 0\n") < autoText.indexOf("Sentence number 1199"));
    assert(await run("document.querySelector('.segment time').textContent.startsWith('00:00')"));
    assert(await run("document.querySelectorAll('.segment')[1199].textContent.includes('Sentence number 1199')"));
    assert(await run("document.querySelector('.speaker-extra .speaker-pill').textContent === 'Speaker 3'"));
    await click("Folder");
    assert.equal(openedDirectory, output);
    assert.equal(chosenDirectory, false, "Folder must open Explorer, not a directory picker");
    await click("Export TXT");
    await waitFor("!document.querySelector('.sidebar-export button').disabled");
    assert.equal(savedExports.length, 1);
    assert.equal(savedExports[0].result.audioPath, null);
    assert(savedExports[0].payload.transcriptText.startsWith("[00:00"));
    assert(savedExports[0].payload.transcriptText.indexOf("Sentence number 0\n") < savedExports[0].payload.transcriptText.indexOf("Sentence number 1199"));
    await click("Export audio");
    await waitFor("!document.querySelector('.sidebar-export button').disabled");
    assert.equal(savedExports.length, 2);
    assert.equal(savedExports[1].result.textPath, null);
    assert(savedExports[1].result.audioPath.endsWith(".wav"));
    assert.equal(savedExports[1].payload.audioSourcePath, "fixture.mp4");
    await click("Show in folder");
    assert.equal(revealed, savedExports[1].result.audioPath);
    await run(`const input = document.querySelector('.search-box input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Sentence number 0'); input.dispatchEvent(new Event('input', { bubbles: true }));`);
    await waitFor("document.querySelectorAll('.segment').length === 1");
    assert(await run("document.querySelector('.segment time').textContent.startsWith('00:00')"));
    await click("Export TXT");
    await waitFor("!document.querySelector('.sidebar-export button').disabled");
    assert.equal((savedExports[2].payload.transcriptText.match(/Sentence number /g) || []).length, 1200, "Search must not restrict exports");
    exportFailure = true;
    await click("Export TXT");
    await waitFor("document.querySelector('[role=alert]')?.textContent.includes('read-only')");
    exportFailure = false;
    await run("window.fixtureMode = 'error'");
    await click("Transcribe file");
    await waitFor("document.querySelector('[role=alert]')?.textContent.includes('cannot be decoded')");
    assert(await run("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Transcribe file' && !b.disabled)"));
    await run("window.fixtureMode = 'disconnect'");
    await click("Transcribe file");
    await waitFor("document.querySelector('[role=alert]')?.textContent.includes('interrupted')");
    await run("document.querySelector('[aria-label=\"Clear transcript\"]').click()");
    await click("Export audio");
    await waitFor("document.querySelector('[role=alert]')?.textContent.includes('No audio is available')");
    await run("window.fixtureMode = 'complete'");
    await click("Transcribe file");
    await waitFor("document.querySelectorAll('.segment').length === 1200 && document.querySelector('.session-notice')?.textContent.includes('Saved')");
    await run("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await fs.writeFile(path.join(output, "renderer.png"), (await window.webContents.capturePage()).toPNG());
    console.log("PASS: 1200 chronological segments, 3 speaker styles, automatic TXT with live auto-export disabled, full manual TXT/audio, Folder opens directory, version display, export failures, job errors, disconnect, and retry.");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
