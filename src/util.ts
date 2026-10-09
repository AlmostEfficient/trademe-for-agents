import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

export const ROOT = resolve(import.meta.dir, "..");
export const SESSION_DIR = resolve(ROOT, ".session");
export const LISTINGS_DIR = resolve(ROOT, "listings");
export const INBOX_DIR = resolve(ROOT, "inbox");
export const CONFIG_PATH = resolve(ROOT, "config.json");

// A failure the user or agent can act on. `fix` says what to do next.
export class Problem extends Error {
  constructor(message: string, public fix?: string) { super(message); }
}

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function readJson<T = any>(path: string): Promise<T | undefined> {
  const file = Bun.file(path);
  if (!await file.exists()) return undefined;
  try { return await file.json(); }
  catch { throw new Problem(`${path} is not valid JSON`, "fix the syntax error in that file (a trailing comma is the usual culprit)"); }
}

// Write via a temp file so an interrupted run never leaves half a file behind.
export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await Bun.write(temp, JSON.stringify(value, null, 2) + "\n");
  await rename(temp, path);
}

export function itemDir(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug ?? "")) throw new Problem(`"${slug}" is not a valid item name`, "use lowercase letters, numbers and dashes, like blue-office-chair");
  return resolve(LISTINGS_DIR, slug);
}

export const listingUrl = (id: number) => `https://www.trademe.co.nz/a/marketplace/listing/${id}`;
