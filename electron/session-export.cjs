const fs = require("node:fs/promises");
const path = require("node:path");

function safeFileName(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").slice(0, 120);
}

async function saveSessionExport(payload, extractAudio) {
  if (!payload.directory) throw new Error("Export directory is required.");
  await fs.mkdir(payload.directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = safeFileName(payload.baseName || `livescriber-${stamp}`);
  let textPath = null;
  let audioPath = null;
  let audioError;
  if (payload.includeText !== false) {
    if (!payload.transcriptText) throw new Error("There is no transcript to export.");
    textPath = path.join(payload.directory, `${baseName}.txt`);
    await fs.writeFile(textPath, payload.transcriptText, "utf8");
  }
  if (payload.includeAudio !== false) {
    try {
      if (payload.audioSourcePath) {
        const destination = path.join(payload.directory, `${baseName}.wav`);
        await extractAudio(payload.audioSourcePath, destination);
        audioPath = destination;
      } else if (payload.audioBase64) {
        const destination = path.join(payload.directory, `${baseName}.webm`);
        await fs.writeFile(destination, Buffer.from(payload.audioBase64, "base64"));
        audioPath = destination;
      } else {
        throw new Error("No audio is available to export.");
      }
    } catch (error) {
      if (!textPath) throw error;
      audioError = error.message || String(error);
    }
  }
  return { textPath, audioPath, audioError };
}

async function createFileTranscript(directory, fileName) {
  if (!directory) throw new Error("Export directory is required.");
  await fs.mkdir(directory, { recursive: true });
  const stem = safeFileName(path.parse(fileName).name) || "transcript";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const transcriptPath = path.join(directory, `${stem}-${stamp}.txt`);
  const file = await fs.open(transcriptPath, "wx");
  await file.close();
  return { directory, transcriptPath };
}

module.exports = { saveSessionExport, createFileTranscript };
