const { execFileSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
for (const [script, ...args] of [
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  ["node_modules/vite/bin/vite.js", "build"],
]) {
  execFileSync(process.execPath, [path.join(root, script), ...args], { cwd: root, stdio: "inherit" });
}
