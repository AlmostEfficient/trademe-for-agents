import { copyFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { Client } from "./client";
import type { Item, State } from "./listing";
import { INBOX_DIR, Problem, sha256 } from "./util";

const IMAGE = /\.(jpe?g|png|webp|heic|heif|tiff?|gif|avif)$/i;

async function sharp() {
  try { return (await import("sharp")).default; }
  catch { throw new Problem("the image library isn't installed", "run: bun install"); }
}

// Decode any supported photo, apply rotation and crop, and save a JPEG Trade
// Me accepts. Location and camera metadata are dropped.
async function render(original: string, output: string, crop?: number[], rotate?: number) {
  let input: Buffer | string = original;
  if (/\.(heic|heif)$/i.test(original)) {
    const convert = (await import("heic-convert")).default;
    try { input = Buffer.from(await convert({ buffer: await Bun.file(original).bytes(), format: "JPEG", quality: 0.95 })); }
    catch { throw new Problem(`couldn't read ${basename(original)} as a HEIC photo`, "export it as a JPEG and add that instead"); }
  }
  const Sharp = await sharp();
  // Bake EXIF orientation into a real image first, so crop coordinates match what people see.
  let image = Sharp(await Sharp(input).rotate().toBuffer());
  if (rotate) image = Sharp(await image.rotate(rotate).toBuffer());
  if (crop) {
    const { width = 0, height = 0 } = await image.metadata();
    const [left, top, right, bottom] = crop;
    image = image.extract({ left: Math.round(left * width), top: Math.round(top * height), width: Math.round((right - left) * width), height: Math.round((bottom - top) * height) });
  }
  try {
    await image.resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(output);
  } catch (error: any) {
    throw new Problem(`couldn't convert ${basename(original)}: ${error.message}`, "check that the file is a photo and isn't damaged");
  }
}

export async function addPhotos(dir: string, item: Item, state: State, paths: string[]) {
  if (!paths.length) throw new Problem("no photos given", "pass one or more photo paths, or a folder");
  const files: string[] = [];
  for (const path of paths) {
    const full = resolve(path);
    const info = await stat(full).catch(() => undefined);
    if (!info) throw new Problem(`can't find ${path}`);
    if (info.isDirectory()) files.push(...(await readdir(full)).filter(name => IMAGE.test(name)).sort().map(name => resolve(full, name)));
    else if (IMAGE.test(full)) files.push(full);
    else throw new Problem(`${basename(full)} isn't a supported photo type`, "use JPEG, PNG, WebP or HEIC");
  }
  await mkdir(resolve(dir, "originals"), { recursive: true });
  await mkdir(resolve(dir, "photos"), { recursive: true });
  state.photoSources ??= [];
  const known = new Set(await Promise.all(state.photoSources.map(async s => sha256(await Bun.file(resolve(dir, s.original)).bytes()).toString())).catch(() => []));
  const added: string[] = [];
  for (const file of files) {
    const digest = sha256(await Bun.file(file).bytes());
    if (known.has(digest)) { console.log(`skipped ${basename(file)} (already added)`); continue; }
    known.add(digest);
    let original = `originals/${basename(file)}`;
    for (let n = 2; await Bun.file(resolve(dir, original)).exists(); n++) original = `originals/${basename(file, extname(file))}-${n}${extname(file)}`;
    // Photos dropped in the inbox move out of it, so the inbox only holds unsorted photos.
    if (file.startsWith(INBOX_DIR + "/") || file.startsWith(INBOX_DIR + "\\")) await rename(file, resolve(dir, original)).catch(() => copyFile(file, resolve(dir, original)));
    else await copyFile(file, resolve(dir, original));
    const number = Math.max(0, ...state.photoSources.map(s => parseInt(s.file))) + 1;
    const name = `${String(number).padStart(2, "0")}.jpg`;
    await render(resolve(dir, original), resolve(dir, "photos", name));
    state.photoSources.push({ file: name, original });
    item.photos.push(name);
    added.push(name);
  }
  return added;
}

export async function editPhoto(dir: string, state: State, file: string, change: { crop?: number[]; rotate?: number; reset?: boolean }) {
  const source = state.photoSources?.find(s => s.file === file);
  if (!source) throw new Problem(`${file} isn't one of this item's photos`, "use a name from listing.json photos, like 01.jpg");
  if (change.reset) { delete source.crop; delete source.rotate; }
  if (change.crop) {
    const [l, t, r, b] = change.crop;
    if (change.crop.length !== 4 || [l, t, r, b].some(v => !(v >= 0 && v <= 1)) || l >= r || t >= b) throw new Problem("crop takes left,top,right,bottom as fractions from 0 to 1, like 0.1,0,0.9,0.85");
    source.crop = change.crop;
  }
  if (change.rotate !== undefined) {
    if (![0, 90, 180, 270].includes(change.rotate)) throw new Problem("rotate takes 90, 180 or 270 (clockwise)");
    source.rotate = change.rotate || undefined;
  }
  await render(resolve(dir, source.original), resolve(dir, "photos", file), source.crop, source.rotate);
}

// Upload each photo once. A photo is uploaded again only if its file changed.
export async function uploadPhotos(client: Client, dir: string, item: Item, state: State, save: () => Promise<void>, reupload = false) {
  if (reupload) state.uploads = [];
  state.uploads ??= [];
  const ids: number[] = [];
  for (const file of item.photos) {
    const path = resolve(dir, "photos", file);
    if (!await Bun.file(path).exists()) throw new Problem(`photos/${file} is listed in listing.json but missing`, "remove it from photos in listing.json or add it again");
    const bytes = await Bun.file(path).bytes();
    const digest = sha256(bytes);
    const existing = state.uploads.findLast(u => u.file === file && u.sha256 === digest);
    if (existing) { ids.push(existing.photoId); continue; }
    const response = await client.request("v1/photos/add", { FileName: file, FileType: "jpeg", PhotoData: Buffer.from(bytes).toString("base64") });
    const id = response.PhotoId;
    if (!Number.isSafeInteger(id) || id <= 0) throw new Problem(`Trade Me didn't return an ID for ${file}`, "run validate again");
    state.uploads.push({ file, sha256: digest, photoId: id, at: new Date().toISOString() });
    await save();
    console.log(`uploaded ${file}`);
    ids.push(id);
  }
  return ids;
}

// Small JPEG copies of inbox photos so an agent can look at them, HEIC included.
export async function inboxPreviews() {
  await mkdir(resolve(INBOX_DIR, ".previews"), { recursive: true });
  const names = (await readdir(INBOX_DIR)).filter(name => IMAGE.test(name)).sort();
  // Drop previews of photos that have since moved into an item.
  for (const preview of await readdir(resolve(INBOX_DIR, ".previews"))) {
    if (!names.includes(preview.replace(/\.jpg$/, ""))) await Bun.file(resolve(INBOX_DIR, ".previews", preview)).delete();
  }
  const Sharp = await sharp();
  const result: { file: string; preview: string }[] = [];
  for (const name of names) {
    const preview = resolve(INBOX_DIR, ".previews", `${name}.jpg`);
    if (!await Bun.file(preview).exists()) {
      await render(resolve(INBOX_DIR, name), preview);
      await Sharp(await Bun.file(preview).bytes()).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 80 }).toFile(preview + ".tmp");
      await rename(preview + ".tmp", preview);
    }
    result.push({ file: `inbox/${name}`, preview: `inbox/.previews/${name}.jpg` });
  }
  return result;
}
