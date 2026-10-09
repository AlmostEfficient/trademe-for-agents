import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { INBOX_DIR, Problem, SESSION_DIR, readJson, sha256, writeJson } from "./util";

// Everything lands in inbox/ first. Sources only differ in how photos get there.
const IMAGE = /\.(jpe?g|png|webp|heic|heif)$/i;
const LEDGER = resolve(SESSION_DIR, "collected.json");

async function ledger() {
  return await readJson<{ hashes: string[]; assets: string[] }>(LEDGER) ?? { hashes: [], assets: [] };
}

// AirDrop on a Mac, and most browsers everywhere, save into Downloads.
export async function fromDownloads(minutes: number) {
  const dir = join(homedir(), "Downloads");
  const names = await readdir(dir).catch(() => { throw new Problem("can't read the Downloads folder", "ask the seller to drop the photos into this workspace's inbox folder instead"); });
  const since = Date.now() - minutes * 60_000;
  const seen = await ledger();
  await mkdir(INBOX_DIR, { recursive: true });
  const copied: string[] = [];
  for (const name of names.filter(n => IMAGE.test(n))) {
    const path = join(dir, name);
    const info = await stat(path);
    // AirDrop keeps the capture time, so birth time (when it arrived) is the better signal.
    if (Math.max(info.birthtimeMs || 0, info.mtimeMs) < since) continue;
    const digest = sha256(await Bun.file(path).bytes());
    if (seen.hashes.includes(digest)) continue;
    await copyFile(path, join(INBOX_DIR, name));
    seen.hashes.push(digest);
    copied.push(name);
  }
  await writeJson(LEDGER, seen);
  return copied;
}

// macOS only. The first run makes macOS ask whether this app may control Photos.
export async function fromAlbum(album: string) {
  if (process.platform !== "darwin") throw new Problem("Apple Photos albums only work on a Mac", "use a folder or Downloads instead");
  const seen = await ledger();
  const out = resolve(SESSION_DIR, "album-export");
  await mkdir(out, { recursive: true });
  const script = `
const p = Application('Photos');
const albums = p.albums.whose({ name: ${JSON.stringify(album)} })();
if (albums.length === 0) throw new Error('NO_ALBUM');
const skip = ${JSON.stringify(seen.assets)};
const items = albums[0].mediaItems().filter(i => !skip.includes(i.id()));
if (items.length) p.export(items, { to: Path(${JSON.stringify(out)}), usingOriginals: false });
JSON.stringify(items.map(i => i.id()));`;
  const child = Bun.spawn(["osascript", "-l", "JavaScript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) {
    if (/NO_ALBUM/.test(stderr)) throw new Problem(`no Photos album called "${album}"`, "check the exact album name in the Photos app (spaces count)");
    if (/-1743|not authori[sz]ed|not allowed/i.test(stderr)) throw new Problem("macOS blocked access to Photos", "open System Settings > Privacy & Security > Automation, find the app running this agent, and switch Photos on. then try again");
    throw new Problem(`Photos export failed: ${stderr.trim().slice(0, 200)}`, "make sure the Photos app can open, and that iCloud photos have finished downloading");
  }
  const ids: string[] = JSON.parse(stdout);
  await mkdir(INBOX_DIR, { recursive: true });
  const copied: string[] = [];
  for (const name of await readdir(out)) {
    await copyFile(join(out, name), join(INBOX_DIR, name));
    await Bun.file(join(out, name)).delete();
    copied.push(name);
  }
  seen.assets.push(...ids);
  await writeJson(LEDGER, seen);
  return copied;
}
