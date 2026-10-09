import { accessSync, constants, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Problem } from "./util";

// Any Chromium-based browser works: we only need its debugging connection to
// read the cookies of a profile that belongs to this workspace.
function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
}

export function findBrowser(): string | undefined {
  if (process.env.TM_BROWSER) return executable(process.env.TM_BROWSER) ? process.env.TM_BROWSER : undefined;
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    for (const base of ["/Applications", join(homedir(), "Applications")]) {
      candidates.push(
        `${base}/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `${base}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
        `${base}/Brave Browser.app/Contents/MacOS/Brave Browser`,
        `${base}/Chromium.app/Contents/MacOS/Chromium`,
      );
    }
  } else if (process.platform === "win32") {
    const bases = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const base of bases) {
      candidates.push(
        join(base, "Google/Chrome/Application/chrome.exe"),
        join(base, "Microsoft/Edge/Application/msedge.exe"),
        join(base, "BraveSoftware/Brave-Browser/Application/brave.exe"),
        join(base, "Chromium/Application/chrome.exe"),
      );
    }
  } else {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
      const found = Bun.which(name);
      if (found) candidates.push(found);
    }
  }
  return candidates.find(path => executable(path));
}

export function requireBrowser() {
  const path = findBrowser();
  if (!path) throw new Problem("no Chrome, Edge, Brave or Chromium found", "install Google Chrome, or set TM_BROWSER to the full path of a Chromium-based browser");
  return path;
}

type Cdp = { send(method: string, params?: object): Promise<any>; close(): void };

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => { ws.close(); fail(new Problem("browser connection timed out")); }, 10000);
    ws.onopen = () => { clearTimeout(timer); ok(); };
    ws.onerror = () => { clearTimeout(timer); fail(new Problem("could not connect to the browser")); };
  });
  let next = 0;
  const pending = new Map<number, (message: any) => void>();
  ws.onclose = () => {
    for (const finish of pending.values()) finish({ error: { message: "browser connection closed" } });
    pending.clear();
  };
  ws.onmessage = event => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  return {
    send(method, params = {}) {
      return new Promise((ok, fail) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); fail(new Problem(`browser request timed out: ${method}`)); }, 10000);
        pending.set(id, message => {
          clearTimeout(timer);
          message.error ? fail(new Error(message.error.message)) : ok(message.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

// The browser writes its debugging port to this file once it is ready.
async function readDevToolsPort(profile: string) {
  const file = Bun.file(join(profile, "DevToolsActivePort"));
  if (!await file.exists()) return undefined;
  const [port, path] = (await file.text()).trim().split(/\r?\n/);
  try {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (version.ok) return `ws://127.0.0.1:${port}${path}`;
  } catch {}
  return undefined;
}

export type BrowserSession = { cookies(): Promise<any[]>; close(): Promise<void>; exited: Promise<number> | undefined };

export async function openProfile(profile: string, url: string, { headless = false } = {}): Promise<BrowserSession> {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // A window from an earlier run may still be open on this profile; reuse it.
  let wsUrl = await readDevToolsPort(profile);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  if (!wsUrl) {
    await rm(join(profile, "DevToolsActivePort"), { force: true });
    child = Bun.spawn([requireBrowser(),
      `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
      ...(headless ? ["--headless=new"] : ["--new-window"]), url,
    ], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && !wsUrl; i++) {
      await Bun.sleep(200);
      if (child.exitCode !== null) break;
      wsUrl = await readDevToolsPort(profile);
    }
    if (!wsUrl) {
      child.kill();
      throw new Problem("the browser started but did not open its debugging connection",
        "close every window of that browser that uses this workspace's profile and try again. If it still fails, set TM_BROWSER to a different Chromium-based browser");
    }
  }
  const cdp = await connect(wsUrl);
  return {
    async cookies() { return (await cdp.send("Storage.getCookies")).cookies; },
    async close() {
      try { await cdp.send("Browser.close"); } catch {}
      cdp.close();
      if (child) await Promise.race([child.exited, Bun.sleep(5000)]);
    },
    exited: child?.exited,
  };
}
