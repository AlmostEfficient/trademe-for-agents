import { mkdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { INBOX_DIR, Problem, SESSION_DIR } from "./util";

// A tiny upload page for the seller's phone, reachable on the same Wi-Fi only.
// The random token in the link is the only way in, and the server stops itself
// once nobody has used it for a while.

function lanAddress() {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter(a => a.family === "IPv4" && !a.internal).map(a => ({ name, address: a.address })));
  // Wi-Fi and Ethernet are en*, VPNs and virtual adapters are utun/bridge/etc.
  const pick = candidates.find(c => /^en\d/.test(c.name)) ?? candidates[0];
  if (!pick) throw new Problem("this Mac isn't on a network", "connect it to Wi-Fi, or use AirDrop or the inbox folder instead");
  return pick.address;
}

const page = (token: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>photos for trade me</title>
<style>
:root{--bg:#faf8f5;--fg:#1d1b19;--muted:#6f6a64;--accent:#3554d1;--card:#fff;--line:#e6e1da}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--fg:#f1eee9;--muted:#a49e96;--accent:#8ea2ff;--card:#211f1d;--line:#34312e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.4 -apple-system,system-ui,sans-serif;padding:24px 16px 48px}
main{max-width:480px;margin:0 auto}h1{font-size:26px;margin:0 0 6px}p{color:var(--muted);margin:0 0 20px}
label,button{display:block;width:100%;padding:16px;border-radius:14px;font:600 18px -apple-system,system-ui,sans-serif;text-align:center;border:0;margin-bottom:10px}
.take{background:var(--accent);color:#fff}.pick{background:var(--card);color:var(--fg);border:1px solid var(--line)}
input{display:none}#status{margin:16px 0;color:var(--muted);min-height:1.4em}
.done{background:var(--fg);color:var(--bg);margin-top:20px}.done[hidden]{display:none}
#grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}#grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px}
</style></head><body><main>
<h1>photos for trade me</h1>
<p>snap the thing from a few angles. they go straight to your mac.</p>
<label class="take">take photos<input id="cam" type="file" accept="image/*" capture="environment" multiple></label>
<label class="pick">pick from my photos<input id="lib" type="file" accept="image/*" multiple></label>
<div id="status"></div><div id="grid"></div>
<button id="done" class="done" hidden>all done</button>
<script>
let sent = 0;
const status = document.getElementById("status"), grid = document.getElementById("grid");
async function upload(files) {
  for (const file of files) {
    status.textContent = "sending " + file.name + "...";
    const body = new FormData(); body.append("photo", file);
    try {
      const r = await fetch("/${token}/upload", { method: "POST", body });
      if (!r.ok) throw new Error(await r.text());
      sent++;
      const img = document.createElement("img"); img.src = URL.createObjectURL(file); grid.prepend(img);
      status.textContent = sent + (sent === 1 ? " photo" : " photos") + " on your mac. keep going, or tap all done.";
      done.hidden = false;
    } catch (e) { status.textContent = "that one didn't send. check you're still on the same wifi and try again."; return; }
  }
}
const done = document.getElementById("done");
done.addEventListener("click", async () => {
  done.disabled = true;
  try {
    const r = await fetch("/${token}/done", { method: "POST" });
    if (!r.ok) throw new Error();
    document.querySelector("main").innerHTML = "<h1>got them</h1><p>" + sent + (sent === 1 ? " photo is" : " photos are") + " on your mac. your ai's sorting them now. you can close this.</p>";
  } catch { done.disabled = false; status.textContent = "couldn't reach your mac. check the wifi and tap all done again."; }
});
for (const id of ["cam", "lib"]) document.getElementById(id).addEventListener("change", e => { upload([...e.target.files]); e.target.value = ""; });
</script></main></body></html>`;

export async function servePhone({ idleMinutes = 20 } = {}) {
  const token = randomBytes(12).toString("base64url");
  const address = lanAddress();
  await mkdir(INBOX_DIR, { recursive: true });
  let lastUsed = Date.now();
  let received = 0;
  let finish: (reason: "done" | "idle") => void = () => {};
  const finished = new Promise<"done" | "idle">(resolve => { finish = resolve; });
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    maxRequestBodySize: 60 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      const [, given, action] = url.pathname.split("/");
      if (given !== token) return new Response("not found", { status: 404 });
      lastUsed = Date.now();
      if (request.method === "GET" && !action) return new Response(page(token), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (request.method === "POST" && action === "upload") {
        const file = (await request.formData()).get("photo");
        if (!(file instanceof File) || !/^image\//.test(file.type || "image/") || !file.size) return new Response("not a photo", { status: 400 });
        const safe = basename(file.name || "photo.jpg").replace(/[^\w.-]+/g, "_").slice(-80) || "photo.jpg";
        let name = `phone-${Date.now()}-${safe}`;
        if (!/\.(jpe?g|png|webp|heic|heif)$/i.test(name)) name += ".jpg";
        await Bun.write(join(INBOX_DIR, name), file);
        received++;
        console.log(`received ${name}`);
        return new Response("ok");
      }
      if (request.method === "POST" && action === "done") {
        // Answer first, then close, so the phone sees the confirmation.
        setTimeout(() => finish("done"), 500);
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  });
  const link = `http://${address}:${server.port}/${token}`;
  const qrPath = resolve(SESSION_DIR, "phone-qr.png");
  await mkdir(SESSION_DIR, { recursive: true });
  await QRCode.toFile(qrPath, link, { width: 600, margin: 2 });
  Bun.spawn(["open", qrPath], { stdout: "ignore", stderr: "ignore" });
  console.log(`phone upload page is up.\n  link: ${link}\n  qr:   ${qrPath} (opened on screen)\nthe phone must be on the same Wi-Fi as this Mac. stops after ${idleMinutes} quiet minutes.`);
  const timer = setInterval(() => { if (Date.now() - lastUsed > idleMinutes * 60_000) finish("idle"); }, 10_000);
  const reason = await finished;
  clearInterval(timer);
  server.stop(true);
  const count = `${received} photo${received === 1 ? "" : "s"}`;
  console.log(reason === "done"
    ? `seller tapped all done. ${count} received. next: bun tm inbox`
    : `phone upload page closed after ${idleMinutes} quiet minutes. ${count} received.`);
}
