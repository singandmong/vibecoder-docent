#!/usr/bin/env node
import { cp, copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_NAME = "Vibecoder Docent";
const APP_BUNDLE_ID = "com.vibecoder.docent";
const APP_FILES = [
  "index.html",
  "favicon.svg",
  "mobile.css",
  "manifest.webmanifest",
  "sw.js",
  "offline.html",
];

function usage() {
  console.log([
    "Usage: node scripts/build-macos.mjs [--output <path.app>]",
    "Builds an ad-hoc signed (not notarized) macOS app bundle for the current Mac architecture.",
    "Requires the Electron, @electron/packager, and project build dependencies.",
  ].join("\n"));
}

function parseArgs(args) {
  const options = { output: join(ROOT, "dist", `${APP_NAME}.app`) };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output requires a path.");
      options.output = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function requireFile(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Required app file is missing: ${path}`);
}

async function buildFrontend() {
  execFileSync(process.execPath, [join(ROOT, "app", "build.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

async function buildIcon(tempRoot) {
  const iconset = join(tempRoot, "docent.iconset");
  await mkdir(iconset);
  const source = join(ROOT, "app/assets/app-icon-512.png");
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync("/usr/bin/sips", ["-z", String(size * scale), String(size * scale), source, "--out", join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { stdio: "ignore" });
    }
  }
  const icon = join(tempRoot, "docent.icns");
  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", icon]);
  return icon;
}

async function copyRuntime(sourceRoot) {
  const sourceApp = join(ROOT, "app");
  const runtimeApp = join(sourceRoot, "app");
  await mkdir(runtimeApp, { recursive: true });

  for (const entry of await readdir(sourceApp, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name) === ".mjs" && entry.name !== "build.mjs") {
      await copyFile(join(sourceApp, entry.name), join(runtimeApp, entry.name));
    }
  }
  for (const name of APP_FILES) {
    const source = join(sourceApp, name);
    await requireFile(source);
    await copyFile(source, join(runtimeApp, name));
  }
  await cp(join(sourceApp, "assets"), join(runtimeApp, "assets"), { recursive: true });

  const desktopSource = join(sourceApp, "desktop", "main.cjs");
  await requireFile(desktopSource);
  await mkdir(join(sourceRoot, "desktop"), { recursive: true });
  await copyFile(desktopSource, join(sourceRoot, "desktop", "main.cjs"));

  const scriptsSource = join(ROOT, "scripts");
  const scriptsTarget = join(sourceRoot, "scripts");
  await mkdir(scriptsTarget, { recursive: true });
  for (const entry of await readdir(scriptsSource, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mjs")
      && (entry.name.startsWith("transcript-") || entry.name === "event-text.mjs")) {
      await copyFile(join(scriptsSource, entry.name), join(scriptsTarget, entry.name));
    }
  }
  await mkdir(join(sourceRoot, "prompt"), { recursive: true });
  await copyFile(join(ROOT, "prompt", "docent.md"), join(sourceRoot, "prompt", "docent.md"));
}

async function createAppSource(sourceRoot, version) {
  await mkdir(sourceRoot, { recursive: true });
  await copyRuntime(sourceRoot);
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) await copyFile(join(ROOT, name), join(sourceRoot, name));
  await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify({
    name: "vibecoder-docent-desktop",
    productName: APP_NAME,
    version,
    private: true,
    type: "commonjs",
    main: "desktop/main.cjs",
  }, null, 2)}\n`);
}

async function ensureReplaceableApp(output) {
  if (!output.endsWith(".app")) throw new Error("--output must end in .app.");
  if (output === ROOT || output === dirname(ROOT)) throw new Error("Refusing to replace a project directory.");
  const existing = await lstat(output).catch(() => null);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-app output: ${output}`);
  }
  if (existing) {
    const id = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(output, "Contents/Info.plist")], { encoding: "utf8" }).trim();
    if (id !== APP_BUNDLE_ID) throw new Error(`Refusing to replace another application: ${output}`);
  }
}

async function main() {
  if (process.platform !== "darwin") throw new Error("This build script must run on macOS.");
  const { output } = parseArgs(process.argv.slice(2));
  await ensureReplaceableApp(output);

  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const electronPkg = JSON.parse(await readFile(join(ROOT, "node_modules", "electron", "package.json"), "utf8").catch(() => {
    throw new Error("Electron dependency is missing. Install the declared development dependencies first.");
  }));
  await buildFrontend();

  const outputParent = dirname(output);
  await mkdir(outputParent, { recursive: true });
  const tempRoot = await mkdtemp(join(outputParent, ".docent-macos-build-"));
  const sourceRoot = join(tempRoot, "source");
  const packageOutput = join(tempRoot, "output");
  try {
    await createAppSource(sourceRoot, pkg.version);
    const icon = await buildIcon(tempRoot);
    const { packager } = await import("@electron/packager");
    const bundles = await packager({
      dir: sourceRoot,
      out: packageOutput,
      platform: "darwin",
      arch: process.arch,
      name: APP_NAME,
      executableName: APP_NAME,
      icon,
      appBundleId: APP_BUNDLE_ID,
      appVersion: pkg.version,
      electronVersion: electronPkg.version,
      asar: false,
      prune: false,
      overwrite: true,
      extendInfo: { CFBundleDisplayName: "바이브코더 도슨트" },
    });
    const packagedRoot = bundles[0];
    const appPaths = packagedRoot.endsWith(".app")
      ? [packagedRoot]
      : (await readdir(packagedRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
        .map((entry) => join(packagedRoot, entry.name));
    if (appPaths.length !== 1) throw new Error("Electron Packager must produce exactly one app bundle.");
    const [appBundle] = appPaths;
    const appInfo = await lstat(appBundle).catch(() => null);
    if (!appInfo?.isDirectory()) throw new Error(`Electron Packager did not create the expected .app bundle at ${appBundle}`);
    const currentOutput = await lstat(output).catch(() => null);
    if (currentOutput) await rm(output, { recursive: true });
    await rename(appBundle, output);
    // 묶은 뒤 바뀐 파일 때문에 Electron 의 원래 서명이 깨지면 Apple Silicon 이 "손상된 앱"으로 거부한다. 임시(ad-hoc) 서명으로 다시 맞춘다.
    // Developer ID 서명과 공증이 아니므로 내려받은 앱은 처음 한 번 Gatekeeper 확인이 필요하다 (ADR 0073).
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", output], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--deep", "--strict", output], { stdio: "inherit" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`Created ad-hoc signed macOS app (${process.arch}): ${output}`);
  console.log("Not notarized. A downloaded copy needs a one-time Gatekeeper approval (right-click > Open, or xattr -dr com.apple.quarantine).");
}

main().catch((error) => {
  console.error(`macOS app build failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
