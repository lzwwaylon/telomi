import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";
import { resolveDataDir } from "../server/config/data-dir.js";
import { loadProjectEnvironment } from "../server/config/environment.js";
import { runtimeControlRoot } from "../server/workspaces/server-runtime-paths.js";

type BrowserName = "chrome" | "brave" | "edge" | "chromium";
type Command = "help" | "profiles" | "start" | "status" | "stop" | "sync-default";

type Options = {
  browser: BrowserName;
  executablePath?: string;
  headless: boolean;
  onlyProfile: boolean;
  port: number;
  profileDirectory: string;
  profileDir: string;
  sourceDir: string;
  stateDir: string;
  syncOnStart: boolean;
  timeoutMs: number;
};

type StateFile = {
  browser: BrowserName;
  executablePath: string;
  headless: boolean;
  pid: number;
  port: number;
  profileDirectory: string;
  profileDir: string;
  sourceDir: string;
  startedAt: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
/** Where format version 1 kept the managed browser, inside the checkout; the data-directory migration moves it. */
export const legacyBrowserPaths = {
  profileDir: path.join(repoRoot, ".chrome-debug-profile"),
  stateDir: path.join(repoRoot, ".chrome-debug"),
};

/** The managed profile holds the browser's logins, so it lives with the rest of the installation's state. */
export function managedBrowserPaths(dataDir = resolveDataDir(process.env, repoRoot)): { profileDir: string; stateDir: string } {
  return {
    profileDir: path.join(dataDir, "browser-profile"),
    stateDir: path.join(runtimeControlRoot(dataDir), "chrome-debug"),
  };
}
const defaultPort = 9222;
const defaultTimeoutMs = 15_000;

const DEFAULT_EXCLUDE_NAMES = new Set([
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "RunningChromeVersion",
  "Crashpad",
  "GraphiteDawnCache",
  "GrShaderCache",
  "ShaderCache",
  "component_crx_cache",
  "extensions_crx_cache",
  "download_cache",
  "BrowserMetrics",
  "BrowserMetrics-spare.pma",
]);

function printHelp(): void {
  console.log(
    `
Usage:
  npm run browser:start
  npm run browser:start:sync
  npm run browser:start:headed
  npm run browser:start:sync:headed
  npm run browser:status
  npm run browser:stop

Direct:
  tsx scripts/chrome-debug.ts <command> [options]

Commands:
  profiles      List profiles discovered from Local State
  start         Start Chrome/Chromium with remote debugging enabled (default: headless)
  status        Show current process and CDP status
  stop          Stop the managed browser
  sync-default  Copy local browser profile data into the managed profile dir
  help          Show this help text

Options:
  --browser <chrome|brave|edge|chromium>
  --headed
  --headless
  --profile-directory <name>
  --source-dir <path>
  --profile-dir <path>
  --state-dir <path>
  --port <number>
  --timeout-ms <number>
  --executable-path <path>
  --sync
  --only-profile        With --sync (or sync-default): copy ONLY the selected
                        --profile-directory and root metadata; skip every other
                        user profile so other Google accounts' data is not duplicated.
`.trim(),
  );
}

function resolveDefaultSourceDir(browser: BrowserName): string {
  const homeDir = os.homedir();
  const localAppData = process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");

  const byPlatform: Record<NodeJS.Platform, Record<BrowserName, string>> = {
    aix: {
      chrome: path.join(homeDir, ".config", "google-chrome"),
      brave: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      edge: path.join(homeDir, ".config", "microsoft-edge"),
      chromium: path.join(homeDir, ".config", "chromium"),
    },
    android: {
      chrome: path.join(homeDir, ".config", "google-chrome"),
      brave: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      edge: path.join(homeDir, ".config", "microsoft-edge"),
      chromium: path.join(homeDir, ".config", "chromium"),
    },
    darwin: {
      chrome: path.join(homeDir, "Library", "Application Support", "Google", "Chrome"),
      brave: path.join(homeDir, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
      edge: path.join(homeDir, "Library", "Application Support", "Microsoft Edge"),
      chromium: path.join(homeDir, "Library", "Application Support", "Chromium"),
    },
    freebsd: {
      chrome: path.join(homeDir, ".config", "google-chrome"),
      brave: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      edge: path.join(homeDir, ".config", "microsoft-edge"),
      chromium: path.join(homeDir, ".config", "chromium"),
    },
    haiku: {
      chrome: path.join(homeDir, ".config", "google-chrome"),
      brave: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      edge: path.join(homeDir, ".config", "microsoft-edge"),
      chromium: path.join(homeDir, ".config", "chromium"),
    },
    linux: {
      chrome: path.join(homeDir, ".config", "google-chrome"),
      brave: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      edge: path.join(homeDir, ".config", "microsoft-edge"),
      chromium: path.join(homeDir, ".config", "chromium"),
    },
    openbsd: {
      chrome: path.join(homeDir, ".config", "google-chrome"),
      brave: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      edge: path.join(homeDir, ".config", "microsoft-edge"),
      chromium: path.join(homeDir, ".config", "chromium"),
    },
    sunos: {
      chrome: path.join(homeDir, ".config", "google-chrome"),
      brave: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      edge: path.join(homeDir, ".config", "microsoft-edge"),
      chromium: path.join(homeDir, ".config", "chromium"),
    },
    win32: {
      chrome: path.join(localAppData, "Google", "Chrome", "User Data"),
      brave: path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
      edge: path.join(localAppData, "Microsoft", "Edge", "User Data"),
      chromium: path.join(localAppData, "Chromium", "User Data"),
    },
    cygwin: {
      chrome: path.join(localAppData, "Google", "Chrome", "User Data"),
      brave: path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
      edge: path.join(localAppData, "Microsoft", "Edge", "User Data"),
      chromium: path.join(localAppData, "Chromium", "User Data"),
    },
    netbsd: {
      chrome: path.join(homeDir, ".config", "google-chrome"),
      brave: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      edge: path.join(homeDir, ".config", "microsoft-edge"),
      chromium: path.join(homeDir, ".config", "chromium"),
    },
  };

  const platformConfig = byPlatform[process.platform] ?? byPlatform.linux;
  return platformConfig[browser];
}

function resolveExecutableCandidates(browser: BrowserName): string[] {
  const homeDir = os.homedir();
  const localAppData = process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";

  if (process.platform === "darwin") {
    const byBrowser: Record<BrowserName, string[]> = {
      chrome: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(
          homeDir,
          "Applications",
          "Google Chrome.app",
          "Contents",
          "MacOS",
          "Google Chrome",
        ),
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ],
      brave: [
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        path.join(
          homeDir,
          "Applications",
          "Brave Browser.app",
          "Contents",
          "MacOS",
          "Brave Browser",
        ),
      ],
      edge: [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        path.join(
          homeDir,
          "Applications",
          "Microsoft Edge.app",
          "Contents",
          "MacOS",
          "Microsoft Edge",
        ),
      ],
      chromium: [
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        path.join(homeDir, "Applications", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ],
    };
    return byBrowser[browser];
  }

  if (process.platform === "win32" || process.platform === "cygwin") {
    const byBrowser: Record<BrowserName, string[]> = {
      chrome: [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      ],
      brave: [
        path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ],
      edge: [
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      ],
      chromium: [
        path.join(localAppData, "Chromium", "Application", "chrome.exe"),
        path.join(programFiles, "Chromium", "Application", "chrome.exe"),
      ],
    };
    return byBrowser[browser];
  }

  const byBrowser: Record<BrowserName, string[]> = {
    chrome: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
    brave: ["/usr/bin/brave-browser", "/snap/bin/brave"],
    edge: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
    chromium: ["/usr/bin/chromium", "/usr/bin/chromium-browser"],
  };
  return byBrowser[browser];
}

type LocalStateProfileSummary = {
  lastUsed?: string;
  lastActiveProfiles: string[];
  profiles: string[];
};

function readLocalStateProfileSummary(sourceDir: string): LocalStateProfileSummary {
  const localStatePath = path.join(sourceDir, "Local State");
  if (!existsSync(localStatePath)) {
    return { lastActiveProfiles: [], profiles: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(localStatePath, "utf8")) as {
      profile?: {
        info_cache?: Record<string, unknown>;
        last_active_profiles?: string[];
        last_used?: string;
      };
    };

    return {
      lastUsed: parsed.profile?.last_used,
      lastActiveProfiles: Array.isArray(parsed.profile?.last_active_profiles)
        ? parsed.profile.last_active_profiles.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      profiles: Object.keys(parsed.profile?.info_cache ?? {}),
    };
  } catch {
    return { lastActiveProfiles: [], profiles: [] };
  }
}

function resolveDefaultProfileDirectory(sourceDir: string): string {
  const summary = readLocalStateProfileSummary(sourceDir);
  if (summary.lastUsed?.trim()) {
    return summary.lastUsed.trim();
  }
  if (summary.lastActiveProfiles[0]?.trim()) {
    return summary.lastActiveProfiles[0].trim();
  }
  if (summary.profiles[0]?.trim()) {
    return summary.profiles[0].trim();
  }
  return "Default";
}

function resolveBrowserExecutablePath(options: Options): string {
  if (options.executablePath) {
    if (!existsSync(options.executablePath)) {
      throw new Error(`Browser executable not found: ${options.executablePath}`);
    }
    return options.executablePath;
  }

  for (const candidate of resolveExecutableCandidates(options.browser)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `No supported ${options.browser} executable found. Pass --executable-path or install a Chromium-based browser.`,
  );
}

export function parseArgs(argv: string[]): { command: Command; options: Options } {
  const first = argv[0]?.trim().toLowerCase();
  const command: Command =
    first === "help" ||
    first === "profiles" ||
    first === "status" ||
    first === "stop" ||
    first === "sync-default" ||
    first === "start"
      ? first
      : first === "--help" || first === "-h"
        ? "help"
        : "start";

  const firstIsCommand = command === first || first === "--help" || first === "-h";
  const args = firstIsCommand ? argv.slice(1) : argv;

  let browser: BrowserName = "chrome";
  let executablePath: string | undefined;
  let headless = true;
  let onlyProfile = false;
  let port = defaultPort;
  const managed = managedBrowserPaths();
  let profileDir = managed.profileDir;
  let sourceDir = resolveDefaultSourceDir(browser);
  let profileDirectory = resolveDefaultProfileDirectory(sourceDir);
  let stateDir = managed.stateDir;
  let syncOnStart = false;
  let timeoutMs = defaultTimeoutMs;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--browser") {
      const raw = args[index + 1]?.trim().toLowerCase();
      if (raw !== "chrome" && raw !== "brave" && raw !== "edge" && raw !== "chromium") {
        throw new Error(`Invalid --browser: ${String(raw)}`);
      }
      browser = raw;
      sourceDir = resolveDefaultSourceDir(browser);
      profileDirectory = resolveDefaultProfileDirectory(sourceDir);
      index += 1;
      continue;
    }
    if (arg === "--profile-directory") {
      const raw = args[index + 1]?.trim();
      if (!raw) {
        throw new Error("Invalid --profile-directory");
      }
      profileDirectory = raw;
      index += 1;
      continue;
    }
    if (arg === "--executable-path") {
      executablePath = path.resolve(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--headed") {
      headless = false;
      continue;
    }
    if (arg === "--headless") {
      headless = true;
      continue;
    }
    if (arg === "--port") {
      port = Number.parseInt(args[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--profile-dir") {
      profileDir = path.resolve(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--source-dir") {
      sourceDir = path.resolve(args[index + 1] ?? "");
      profileDirectory = resolveDefaultProfileDirectory(sourceDir);
      index += 1;
      continue;
    }
    if (arg === "--state-dir") {
      stateDir = path.resolve(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = Number.parseInt(args[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--sync") {
      syncOnStart = true;
      continue;
    }
    if (arg === "--only-profile") {
      onlyProfile = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port: ${String(port)}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${String(timeoutMs)}`);
  }

  return {
    command,
    options: {
      browser,
      executablePath,
      headless,
      onlyProfile,
      port,
      profileDirectory,
      profileDir,
      sourceDir,
      stateDir,
      syncOnStart,
      timeoutMs,
    },
  };
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function stateFilePath(stateDir: string): string {
  return path.join(stateDir, "chrome-debug.json");
}

function logFilePath(stateDir: string): string {
  return path.join(stateDir, "chrome-debug.log");
}

function readState(stateDir: string): StateFile | null {
  const filePath = stateFilePath(stateDir);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as StateFile;
  } catch {
    return null;
  }
}

function writeState(stateDir: string, state: StateFile): void {
  ensureDir(stateDir);
  writeFileSync(stateFilePath(stateDir), JSON.stringify(state, null, 2));
}

function clearState(stateDir: string): void {
  rmSync(stateFilePath(stateDir), { force: true });
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchVersion(port: number): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReady(
  port: number,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await fetchVersion(port);
    if (version) {
      return version;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function shouldCopyEntry(src: string): boolean {
  const name = path.basename(src);
  if (DEFAULT_EXCLUDE_NAMES.has(name)) {
    return false;
  }
  if (name.endsWith(".lock")) {
    return false;
  }
  return true;
}

function resolveExcludedProfiles(options: Options): Set<string> {
  if (!options.onlyProfile) {
    return new Set();
  }
  const summary = readLocalStateProfileSummary(options.sourceDir);
  const excluded = new Set<string>();
  for (const profile of summary.profiles) {
    if (profile !== options.profileDirectory) {
      excluded.add(profile);
    }
  }
  return excluded;
}

export function syncFromDefaultBrowser(options: Options): { excludedProfiles: string[] } {
  if (!existsSync(options.sourceDir)) {
    throw new Error(`Browser source dir not found: ${options.sourceDir}`);
  }
  if (options.onlyProfile) {
    const candidate = path.join(options.sourceDir, options.profileDirectory);
    if (!existsSync(candidate)) {
      throw new Error(
        `--only-profile requires an existing profile dir, but ${candidate} does not exist`,
      );
    }
  }
  ensureDir(path.dirname(options.profileDir));
  ensureDir(options.profileDir);
  const profilePath = path.join(options.profileDir, options.profileDirectory);
  const ownLogins = readOwnLoginCookies(path.join(profilePath, "Cookies"));
  for (const entry of readdirSync(options.profileDir)) {
    rmSync(path.join(options.profileDir, entry), {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 200,
    });
  }
  const excludedProfiles = resolveExcludedProfiles(options);
  cpSync(options.sourceDir, options.profileDir, {
    dereference: false,
    filter: (src) => {
      if (!shouldCopyEntry(src)) {
        return false;
      }
      if (excludedProfiles.size > 0) {
        const rel = path.relative(options.sourceDir, src);
        if (rel && rel !== "") {
          const top = rel.split(path.sep)[0];
          if (excludedProfiles.has(top)) {
            return false;
          }
        }
      }
      return true;
    },
    recursive: true,
  });
  detachBrowserAccount(profilePath);
  keepOwnLoginCookies(path.join(profilePath, "Cookies"), ownLogins);
  return { excludedProfiles: Array.from(excludedProfiles) };
}

/**
 * Hosts the user logs in to inside Telomi's browser itself (the source descriptor's `login`), never
 * through a copy of their own browser: Google binds a session to a token that the open page
 * rotates, so a copy and the original invalidate each other. A copy drops these cookies, and the
 * managed browser's own are carried across a re-copy.
 */
const OWN_LOGIN_HOSTS = ["google.com", "youtube.com"];
const OWN_LOGIN_WHERE = OWN_LOGIN_HOSTS.map(() => "host_key = ? OR host_key LIKE ?").join(" OR ");
const OWN_LOGIN_PARAMS = OWN_LOGIN_HOSTS.flatMap((host) => [host, `%.${host}`]);

type CookieRows = { columns: string[]; rows: Array<Record<string, unknown>> };

function readOwnLoginCookies(cookiesDb: string): CookieRows | undefined {
  if (!existsSync(cookiesDb)) return undefined;
  const db = new DatabaseSync(cookiesDb, { readOnly: true });
  try {
    const columns = (db.prepare("PRAGMA table_info(cookies)").all() as Array<{ name: string }>).map((column) => column.name);
    const rows = db.prepare(`SELECT * FROM cookies WHERE ${OWN_LOGIN_WHERE}`).all(...OWN_LOGIN_PARAMS) as Array<Record<string, unknown>>;
    return { columns, rows };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

export function keepOwnLoginCookies(cookiesDb: string, own: CookieRows | undefined): void {
  if (!existsSync(cookiesDb)) return;
  const db = new DatabaseSync(cookiesDb);
  try {
    db.prepare(`DELETE FROM cookies WHERE ${OWN_LOGIN_WHERE}`).run(...OWN_LOGIN_PARAMS);
    if (!own || own.rows.length === 0) return;
    const columns = (db.prepare("PRAGMA table_info(cookies)").all() as Array<{ name: string }>)
      .map((column) => column.name)
      .filter((name) => own.columns.includes(name));
    const insert = db.prepare(
      `INSERT OR REPLACE INTO cookies (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of own.rows) insert.run(...columns.map((name) => row[name] as null | number | bigint | string | Uint8Array));
  } catch (error) {
    // A schema the copy cannot take is not worth failing the copy over; the user logs in again.
    console.warn(`[chrome-debug] could not keep the managed browser's own logins: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}

/**
 * Strip the Chrome-level Google sign-in from a copied profile, keeping every website cookie.
 *
 * A copied profile carries the user's OAuth refresh tokens, sync client id and device id. Run
 * alongside the user's own Chrome, the copy rotates those tokens as "the same device", which makes
 * Google reject the token the user's Chrome still holds and signs them out. Without tokens, and
 * with browser sign-in disallowed so DICE cannot re-add the account from a web login, the copy is
 * a plain browser that is merely logged into websites, which is all Telomi needs.
 */
export function detachBrowserAccount(profilePath: string): void {
  const webData = path.join(profilePath, "Web Data");
  if (existsSync(webData)) {
    const db = new DatabaseSync(webData);
    try {
      db.exec("DELETE FROM token_service");
    } finally {
      db.close();
    }
  }
  const preferencesPath = path.join(profilePath, "Preferences");
  if (!existsSync(preferencesPath)) return;
  const preferences = JSON.parse(readFileSync(preferencesPath, "utf8")) as Record<string, unknown>;
  delete preferences.account_info;
  delete preferences.sync;
  if (preferences.google && typeof preferences.google === "object") {
    delete (preferences.google as Record<string, unknown>).services;
  }
  preferences.signin = { allowed: false, allowed_on_next_startup: false };
  writeFileSync(preferencesPath, JSON.stringify(preferences));
}

export async function startChrome(options: Options): Promise<void> {
  ensureDir(options.stateDir);
  ensureDir(options.profileDir);

  const existingVersion = await fetchVersion(options.port);
  if (existingVersion) {
    const headless = observedHeadless(existingVersion, readState(options.stateDir), options.port);
    if (headless === null || headless !== options.headless) {
      throw new Error(
        `Chrome debug port ${options.port} is already running in ${headless === null ? "unknown" : headless ? "headless" : "headed"} mode; requested ${options.headless ? "headless" : "headed"}. ` +
        "Changing launch mode requires restarting that dedicated browser. Stop it explicitly, then start again; the existing browser was not changed.",
      );
    }
    const state = readState(options.stateDir);
    console.log(
      JSON.stringify(
        {
          status: "running",
          port: options.port,
          headless,
          profileDirectory: state?.port === options.port && isPidRunning(state.pid) ? state.profileDirectory : null,
          profileDir: state?.port === options.port && isPidRunning(state.pid) ? state.profileDir : null,
          webSocketDebuggerUrl: existingVersion.webSocketDebuggerUrl ?? null,
          browser: existingVersion.Browser ?? null,
          note: "Chrome debug port already reachable",
        },
        null,
        2,
      ),
    );
    return;
  }

  let syncResult: { excludedProfiles: string[] } | null = null;
  if (options.syncOnStart) {
    syncResult = syncFromDefaultBrowser(options);
  } else {
    // A profile copied before detachment existed still carries the account; strip it too.
    detachBrowserAccount(path.join(options.profileDir, options.profileDirectory));
  }

  const executablePath = resolveBrowserExecutablePath(options);
  const logPath = logFilePath(options.stateDir);
  const stdoutFd = openSync(logPath, "a");
  const stderrFd = openSync(logPath, "a");

  try {
    const args = [
      `--remote-debugging-port=${options.port}`,
      `--user-data-dir=${options.profileDir}`,
      `--profile-directory=${options.profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      // Headless Chrome announces itself as "HeadlessChrome" in the User-Agent, which sites treat
      // as a bot and which makes the user's clearance cookies (bound to the User-Agent) useless.
      // Present the same reduced User-Agent the user's own Chrome sends.
      ...(options.headless ? ["--headless=new", `--user-agent=${headlessUserAgent(executablePath)}`] : []),
      "about:blank",
    ];

    const child = spawn(executablePath, args, {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.unref();

    writeState(options.stateDir, {
      browser: options.browser,
      executablePath,
      headless: options.headless,
      pid: child.pid ?? -1,
      port: options.port,
      profileDirectory: options.profileDirectory,
      profileDir: options.profileDir,
      sourceDir: options.sourceDir,
      startedAt: new Date().toISOString(),
    });

    const version = await waitForReady(options.port, options.timeoutMs);
    if (!version) {
      if (child.pid && isPidRunning(child.pid)) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // ignore
        }
      }
      throw new Error(
        `Chrome debug port ${options.port} did not become ready within ${options.timeoutMs}ms`,
      );
    }

    console.log(
      JSON.stringify(
        {
          status: "started",
          pid: child.pid ?? null,
          port: options.port,
          headless: options.headless,
          profileDirectory: options.profileDirectory,
          profileDir: options.profileDir,
          sourceDir: options.sourceDir,
          executablePath,
          webSocketDebuggerUrl: version.webSocketDebuggerUrl ?? null,
          browser: version.Browser ?? null,
          logPath,
          syncedOnStart: options.syncOnStart,
          onlyProfile: options.onlyProfile,
          excludedProfiles: syncResult?.excludedProfiles ?? [],
        },
        null,
        2,
      ),
    );
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

function observedHeadless(version: Record<string, unknown>, state?: StateFile | null, port?: number): boolean | null {
  // A browser this script launched reports the mode it was launched in; its User-Agent no longer says.
  if (state && state.port === port && isPidRunning(state.pid)) return state.headless;
  const userAgent = version["User-Agent"];
  return typeof userAgent === "string" && userAgent ? /HeadlessChrome\//u.test(userAgent) : null;
}

/** The reduced User-Agent a headed Chrome of this build sends on this platform. */
export function headlessUserAgent(executablePath: string, platform: NodeJS.Platform = process.platform): string {
  const version = spawnSync(executablePath, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const major = /\b(\d+)\.\d+\.\d+\.\d+/u.exec(version.stdout ?? "")?.[1];
  if (!major) throw new Error(`Cannot read the browser version from ${executablePath}`);
  const system = platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32" ? "Windows NT 10.0; Win64; x64"
    : "X11; Linux x86_64";
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function statusChrome(options: Options): Promise<void> {
  const state = readState(options.stateDir);
  const version = await fetchVersion(options.port);
  console.log(
    JSON.stringify(
      {
        status: version ? "running" : "stopped",
        port: options.port,
        headless: version ? observedHeadless(version, state, options.port) : null,
        profileDirectory: state?.profileDirectory ?? options.profileDirectory,
        profileDir: state?.profileDir ?? options.profileDir,
        sourceDir: state?.sourceDir ?? options.sourceDir,
        pid: state?.pid ?? null,
        pidRunning: state?.pid ? isPidRunning(state.pid) : false,
        browser: state?.browser ?? options.browser,
        webSocketDebuggerUrl: version?.webSocketDebuggerUrl ?? null,
        browserVersion: version?.Browser ?? null,
        logPath: logFilePath(options.stateDir),
      },
      null,
      2,
    ),
  );
}

export async function stopChrome(options: Options): Promise<void> {
  const state = readState(options.stateDir);
  if (!state || state.port !== options.port || state.profileDir !== options.profileDir
      || !Number.isSafeInteger(state.pid) || state.pid <= 0) {
    throw new Error(`Chrome on port ${options.port} is not owned by this checkout; it was not stopped`);
  }
  const processInfo = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${state.pid}").CommandLine`], { encoding: "utf8" })
    : spawnSync("ps", ["-p", String(state.pid), "-o", "args="], { encoding: "utf8" });
  const args = processInfo.stdout?.trimEnd() || "";
  const owned = processInfo.status === 0 && [`--remote-debugging-port=${options.port}`, `--user-data-dir=${options.profileDir}`]
    .every((flag) => args.includes(flag + " ") || args.includes(flag + '"') || args.endsWith(flag));
  if (!owned) {
    throw new Error(`Chrome on port ${options.port} is not owned by the recorded process; it was not stopped`);
  }
  const version = await fetchVersion(options.port);
  let stopped = await closeBrowserWithCdp(version);
  if (!stopped && state?.pid && isPidRunning(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
      stopped = true;
    } catch {
      // ignore
    }
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const version = await fetchVersion(options.port);
    if (!version) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (await fetchVersion(options.port)) throw new Error(`Chrome on port ${options.port} is still running; ownership was preserved`);
  clearState(options.stateDir);
  console.log(
    JSON.stringify(
      {
        status: "stopped",
        port: options.port,
        stopped,
        headless: state?.headless ?? options.headless,
        profileDirectory: state?.profileDirectory ?? options.profileDirectory,
        profileDir: state?.profileDir ?? options.profileDir,
      },
      null,
      2,
    ),
  );
}

async function closeBrowserWithCdp(
  version: Record<string, unknown> | null,
): Promise<boolean> {
  const endpoint = version?.webSocketDebuggerUrl;
  if (typeof endpoint !== "string") return false;
  return new Promise((resolveClose) => {
    const socket = new WebSocket(endpoint);
    let sent = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      resolveClose(sent);
    };
    const timer = setTimeout(finish, 2_000);
    socket.once("open", () => {
      sent = true;
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });
    socket.once("message", finish);
    socket.once("close", finish);
    socket.once("error", finish);
  });
}

async function main(): Promise<void> {
  const env = existsSync(path.join(repoRoot, ".env.worktree")) ? {} : process.env;
  loadProjectEnvironment(repoRoot, env);
  Object.assign(process.env, env);
  const { command, options } = parseArgs(process.argv.slice(2));
  if (["start", "stop", "status"].includes(command) && !process.argv.slice(2).includes("--port") && process.env.TELOMI_BROWSER_HOST_CDP_URL) {
    const endpoint = new URL(process.env.TELOMI_BROWSER_HOST_CDP_URL);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname)
        || endpoint.pathname !== "/" || endpoint.search || endpoint.username || endpoint.password) {
      throw new Error("Chrome CLI requires a local CDP endpoint; specify --port for a local browser");
    }
    options.port = Number(endpoint.port || "80");
    if (options.port < 1) throw new Error(`Invalid CDP port: ${options.port}`);
  }

  if (command === "help") {
    printHelp();
    return;
  }

  if (command === "profiles") {
    const summary = readLocalStateProfileSummary(options.sourceDir);
    console.log(
      JSON.stringify(
        {
          browser: options.browser,
          sourceDir: options.sourceDir,
          lastUsed: summary.lastUsed ?? null,
          lastActiveProfiles: summary.lastActiveProfiles,
          profiles: summary.profiles,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "sync-default") {
    const result = syncFromDefaultBrowser(options);
    console.log(
      JSON.stringify(
        {
          status: "synced",
          browser: options.browser,
          sourceDir: options.sourceDir,
          profileDir: options.profileDir,
          profileDirectory: options.profileDirectory,
          onlyProfile: options.onlyProfile,
          excluded: Array.from(DEFAULT_EXCLUDE_NAMES),
          excludedProfiles: result.excludedProfiles,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "start") {
    await startChrome(options);
    return;
  }

  if (command === "status") {
    await statusChrome(options);
    return;
  }

  await stopChrome(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
