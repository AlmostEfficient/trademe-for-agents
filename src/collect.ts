import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { INBOX_DIR, Problem, SESSION_DIR, readJson, sha256, writeJson } from "./util";

// Everything lands in inbox/ first. Sources only differ in how photos get there.
const IMAGE = /\.(jpe?g|png|webp|heic|heif)$/i;
const LEDGER = resolve(SESSION_DIR, "collected.json");

async function ledger() {
  return await readJson<{ hashes: string[]; assets: string[]; albums?: string[] }>(LEDGER) ?? { hashes: [], assets: [], albums: [] };
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

function photos(script: string) {
  if (process.platform !== "darwin") throw new Problem("Apple Photos albums only work on a Mac", "use a folder or AirDrop instead");
  return (async () => {
    const child = Bun.spawn(["osascript", "-l", "JavaScript", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code === 0) return JSON.parse(stdout);
    if (/-1743|not authori[sz]ed|not allowed/i.test(stderr)) throw new Problem("macOS blocked access to Photos", "ask the seller to open System Settings > Privacy & Security > Automation, find the app running this agent, and switch Photos on. or use AirDrop or the inbox folder instead");
    if (/-1712|timed out/i.test(stderr)) throw new Problem("Photos took too long to answer", "Photos may still be downloading from iCloud. open the Photos app, wait for it to settle, then try again");
    throw new Problem(`Photos said: ${stderr.trim().slice(0, 200)}`, "make sure the Photos app opens normally, then try again");
  })();
}

export async function listAlbums(): Promise<{ name: string; count: number }[]> {
  return photos(`JSON.stringify(Application('Photos').albums().map(a => ({ name: a.name(), count: a.mediaItems.length })))`);
}

// Album names are matched exactly first, then ignoring case and stray spaces.
async function resolveAlbum(name: string) {
  const albums = await listAlbums();
  const exact = albums.filter(a => a.name === name);
  const loose = albums.filter(a => a.name.trim().toLowerCase() === name.trim().toLowerCase());
  const match = exact.length === 1 ? exact[0] : loose.length === 1 ? loose[0] : undefined;
  if (!match) {
    const names = albums.map(a => `"${a.name}"`).slice(0, 15).join(", ");
    throw new Problem(loose.length > 1 ? `more than one album is called "${name}"` : `no Photos album called "${name}"`,
      albums.length ? `albums on this Mac: ${names}. if the seller made it on their iPhone and it's missing, iCloud Photos may be off on the Mac (Photos > Settings > iCloud)` : "this Mac's Photos library has no albums. if the seller uses iCloud Photos, check it's switched on in Photos > Settings > iCloud");
  }
  return match.name;
}

// The first time an album is used, the seller decides whether what's already
// in it is for sale (all) or only what they add from now on (new-only).
export async function fromAlbum(name: string, firstTime?: "all" | "new-only") {
  const album = await resolveAlbum(name);
  const seen = await ledger();
  seen.albums ??= [];
  const known = seen.albums.includes(album);
  if (!known && !firstTime) {
    const { count } = (await listAlbums()).find(a => a.name === album)!;
    throw new Problem(`first time using "${album}" (${count} photos in it now)`, `ask the seller whether those ${count} photos are for sale too. then run again with --all (grab them) or --new-only (only photos added from now)`);
  }
  const out = resolve(SESSION_DIR, "album-export");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const exporting = known || firstTime === "all";
  const ids: string[] = await photos(`
const p = Application('Photos');
const album = p.albums.whose({ name: ${JSON.stringify(album)} })()[0];
const skip = new Set(${JSON.stringify(seen.assets)});
const items = album.mediaItems().filter(i => !skip.has(i.id()));
if (${exporting} && items.length) p.export(items, { to: Path(${JSON.stringify(out)}), usingOriginals: false });
JSON.stringify(items.map(i => i.id()));`);
  await mkdir(INBOX_DIR, { recursive: true });
  const copied: string[] = [];
  for (const file of await readdir(out)) {
    let target = file;
    for (let n = 2; await Bun.file(join(INBOX_DIR, target)).exists(); n++) target = file.replace(/(\.[^.]+)$/, `-${n}$1`);
    await copyFile(join(out, file), join(INBOX_DIR, target));
    copied.push(target);
  }
  await rm(out, { recursive: true, force: true });
  seen.assets.push(...ids);
  if (!known) seen.albums.push(album);
  await writeJson(LEDGER, seen);
  return { album, copied, skipped: exporting ? 0 : ids.length };
}
