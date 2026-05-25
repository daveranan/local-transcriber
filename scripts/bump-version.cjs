const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");

const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map((part) => Number.parseInt(part, 10));
if (![major, minor, patch].every(Number.isFinite)) {
  throw new Error(`Unsupported version: ${pkg.version}`);
}

const nextVersion = `${major}.${minor}.${patch + 1}`;
pkg.version = nextVersion;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.version = nextVersion;
  if (lock.packages?.[""]) {
    lock.packages[""].version = nextVersion;
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(nextVersion);
