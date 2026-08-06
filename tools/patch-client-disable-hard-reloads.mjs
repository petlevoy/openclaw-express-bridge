#!/usr/bin/env node
// Disable the official eXpress client's hard renderer reloads.
//
// The client's electron/src/main/memoryCleaner.js schedules a daily renderer
// reload and an additional reload on high memory usage. In headless bridge
// deployments those hard reloads can discard the authenticated session while
// the process keeps running. This tool patches startMemoryCleaner() inside
// resources/app.asar so that only the safe cache cleaner keeps running.
// Process memory stays bounded by the systemd unit's limits.
//
// The patch must be re-applied after every official client update, because
// an update ships a new app.asar.
//
// Usage:
//   node tools/patch-client-disable-hard-reloads.mjs [--asar PATH] [--restore]
//
// Requires @electron/asar (resolved from node_modules or via `npx --yes`).
// Stop openclaw-express-client.service before running.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_FILE = "electron/src/main/memoryCleaner.js";
const ORIGINAL_BLOCK =
  "function startMemoryCleaner() {\n" +
  "  startDailyReloadCycle()\n" +
  "  startMemoryWatch()\n" +
  "  startCacheCleaner()\n" +
  "}";
const PATCH_MARKER = "Disabled for the headless OpenClaw bridge";
const PATCHED_BLOCK =
  "function startMemoryCleaner() {\n" +
  "  // " + PATCH_MARKER + ": hard renderer reloads can\n" +
  "  // discard the authenticated eXpress session. Cache cleanup is safe and\n" +
  "  // remains enabled; process memory is bounded by the systemd unit.\n" +
  "  startCacheCleaner()\n" +
  "}";

function die(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function defaultAsarPath() {
  const bridgeHome =
    process.env.OPENCLAW_EXPRESS_BRIDGE_HOME ||
    path.join(os.homedir(), ".local/share/openclaw-express-bridge");
  return path.join(bridgeHome, "client/appdir/resources/app.asar");
}

function parseArgs(argv) {
  const options = { asar: defaultAsarPath(), restore: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--asar") {
      i += 1;
      if (!argv[i]) die("--asar requires a path");
      options.asar = argv[i];
    } else if (arg === "--restore") {
      options.restore = true;
    } else {
      die(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function clientServiceActive() {
  try {
    execFileSync(
      "systemctl",
      ["--user", "is-active", "--quiet", "openclaw-express-client.service"],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function asarCommand() {
  const local = path.resolve("plugin/node_modules/.bin/asar");
  if (fs.existsSync(local)) return [local];
  return ["npx", "--yes", "@electron/asar"];
}

function runAsar(args) {
  const [command, ...prefix] = asarCommand();
  execFileSync(command, [...prefix, ...args], { stdio: ["ignore", "inherit", "inherit"] });
}

function findBackup(asarPath) {
  const dir = path.dirname(asarPath);
  const base = path.basename(asarPath);
  const backups = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.pre-no-reload-`))
    .sort();
  return backups.length ? path.join(dir, backups[backups.length - 1]) : null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.asar)) die(`app.asar not found: ${options.asar}`);
  if (clientServiceActive()) {
    die("openclaw-express-client.service is active; stop it first: systemctl --user stop openclaw-express-client.service");
  }

  if (options.restore) {
    const backup = findBackup(options.asar);
    if (!backup) die("no pre-no-reload backup found next to app.asar");
    fs.copyFileSync(backup, `${options.asar}.restore-tmp`);
    fs.renameSync(`${options.asar}.restore-tmp`, options.asar);
    console.log(`Restored ${options.asar} from ${backup}`);
    console.log("Start the client: systemctl --user start openclaw-express-client.service");
    return;
  }

  const workDir = fs.mkdtempSync(path.join(path.dirname(options.asar), ".asar-patch-"));
  const extractDir = path.join(workDir, "app");
  const repacked = path.join(workDir, "app.asar");
  try {
    console.log("Extracting app.asar (this can take a while)...");
    runAsar(["extract", options.asar, extractDir]);

    const targetPath = path.join(extractDir, TARGET_FILE);
    if (!fs.existsSync(targetPath)) die(`${TARGET_FILE} not found inside the archive; client layout changed`);
    const source = fs.readFileSync(targetPath, "utf8");
    if (source.includes(PATCH_MARKER)) {
      console.log("Archive is already patched; nothing to do.");
      return;
    }
    if (!source.includes(ORIGINAL_BLOCK)) {
      die("startMemoryCleaner() does not match the expected layout; refusing to guess. Inspect the file manually.");
    }
    fs.writeFileSync(targetPath, source.replace(ORIGINAL_BLOCK, PATCHED_BLOCK));

    console.log("Repacking app.asar...");
    runAsar(["pack", extractDir, repacked]);

    const checkDir = path.join(workDir, "check");
    runAsar(["extract-file", repacked, TARGET_FILE]);
    const producedLocal = path.basename(TARGET_FILE);
    const produced = fs.readFileSync(producedLocal, "utf8");
    fs.rmSync(producedLocal, { force: true });
    fs.rmSync(checkDir, { recursive: true, force: true });
    if (!produced.includes(PATCH_MARKER)) die("verification failed: repacked archive is missing the patch");

    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const backup = `${options.asar}.pre-no-reload-${stamp}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(options.asar, backup);
    fs.renameSync(repacked, options.asar);
    console.log(`Patched ${options.asar}`);
    console.log(`Original kept at ${backup}`);
    console.log("Start the client: systemctl --user start openclaw-express-client.service");
    console.log("Re-run this tool after every official client update.");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
