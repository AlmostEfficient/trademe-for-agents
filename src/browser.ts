import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { Problem } from "./util";

// Chromium-based browsers on macOS keep cookies in a SQLite file per profile,
// encrypted with a key stored in the login Keychain.
const BROWSERS = [
  { name: "Google Chrome", app: "Google Chrome", dir: "Google/Chrome", keychain: "Chrome Safe Storage" },
  { name: "Arc", app: "Arc", dir: "Arc/User Data", keychain: "Arc Safe Storage" },
  { name: "Brave", app: "Brave Browser", dir: "BraveSoftware/Brave-Browser", keychain: "Brave Safe Storage" },
  { name: "Microsoft Edge", app: "Microsoft Edge", dir: "Microsoft Edge", keychain: "Microsoft Edge Safe Storage" },
  { name: "Chromium", app: "Chromium", dir: "Chromium", keychain: "Chromium Safe Storage" },
];

export type Cookie = { name: string; value: string; domain: string; path: string; expires?: number };
export type Profile = { browser: string; app: string; profile: string; path: string; keychain: string };

const support = join(homedir(), "Library/Application Support");

export function requireMac() {
  if (process.platform !== "darwin") throw new Problem("this workspace only runs on macOS for now", "use it from a Mac");
}

// Every browser profile on this Mac that has a cookie file.
export async function profiles(): Promise<Profile[]> {
  requireMac();
  const found: Profile[] = [];
  for (const browser of BROWSERS) {
    const root = join(support, browser.dir);
    const names = await readdir(root).catch(() => [] as string[]);
    for (const profile of names.filter(n => n === "Default" || /^Profile \d+$/.test(n))) {
      for (const file of ["Cookies", "Network/Cookies"]) {
        const path = join(root, profile, file);
        if (await Bun.file(path).exists()) { found.push({ browser: browser.name, app: browser.app, profile, path, keychain: browser.keychain }); break; }
      }
    }
  }
  return found;
}

export const installedBrowsers = async () => [...new Set((await profiles()).map(p => p.app))];

type Row = { host_key: string; name: string; path: string; value: string; encrypted_value: Uint8Array; expires_utc: number };

// Copy first: the browser may hold a lock on the live file.
async function trademeRows(profile: Profile) {
  const dir = await mkdtemp(join(tmpdir(), "tm-cookies-"));
  try {
    await copyFile(profile.path, join(dir, "Cookies"));
    const db = new Database(join(dir, "Cookies"), { readonly: true });
    const rows = db.query<Row, []>("select host_key, name, path, value, encrypted_value, expires_utc from cookies where host_key = 'trademe.co.nz' or host_key like '%.trademe.co.nz'").all();
    db.close();
    return rows;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const keys = new Map<string, Buffer>();

// The first read makes macOS ask for the login password. "Always Allow" stops it asking again.
async function keyFor(service: string) {
  if (keys.has(service)) return keys.get(service)!;
  const child = Bun.spawn(["security", "find-generic-password", "-w", "-s", service], { stdout: "pipe", stderr: "pipe" });
  const [secret, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Problem(`macOS didn't allow reading the ${service} key`, "when the Keychain popup appears, the seller types their Mac login password and clicks Always Allow. then try again");
  const key = pbkdf2Sync(secret.trim(), "saltysalt", 1003, 16, "sha1");
  keys.set(service, key);
  return key;
}

export async function readCookies(profile: Profile): Promise<Cookie[]> {
  const rows = await trademeRows(profile);
  if (!rows.length) return [];
  const now = (Date.now() + 11644473600000) * 1000; // Chrome counts microseconds from 1601.
  const cookies: Cookie[] = [];
  for (const row of rows) {
    if (row.expires_utc && row.expires_utc < now) continue;
    let value = row.value;
    const encrypted = Buffer.from(row.encrypted_value ?? []);
    if (!value && encrypted.length) {
      if (encrypted.subarray(0, 3).toString() !== "v10") throw new Problem(`${profile.browser} uses a cookie format this tool can't read yet`, "try logging in to Trade Me in Google Chrome instead");
      const decipher = createDecipheriv("aes-128-cbc", await keyFor(profile.keychain), Buffer.alloc(16, " "));
      let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
      // Newer versions prefix the value with a hash of the cookie's domain.
      if (plain.subarray(0, 32).equals(createHash("sha256").update(row.host_key).digest())) plain = plain.subarray(32);
      value = plain.toString();
    }
    if (value) cookies.push({ name: row.name, value, domain: row.host_key, path: row.path });
  }
  return cookies;
}

export async function openInBrowser(app: string | undefined, url: string) {
  const child = Bun.spawn(app ? ["open", "-a", app, url] : ["open", url], { stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0 && app) await Bun.spawn(["open", url]).exited;
}
