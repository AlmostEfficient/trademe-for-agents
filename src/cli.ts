import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { findBrowser } from "./browser";
import { tradeMeClient, type Client } from "./client";
import { PAYMENT_IDS, buildRequest, checkItem, defaultItem, differences, feesAccepted, loadConfig, loadItem, type Config, type Shipping } from "./listing";
import { changesFrom, editRequest, liveListings, platform, withdraw } from "./manage";
import { fromAlbum, fromDownloads } from "./collect";
import { addPhotos, editPhoto, inboxPreviews, uploadPhotos } from "./photos";
import { login, logout } from "./session";
import { CONFIG_PATH, INBOX_DIR, LISTINGS_DIR, Problem, SESSION_DIR, itemDir, listingUrl, readJson, sha256, writeJson } from "./util";

const HELP = `trade me for agents

setup
  bun tm doctor [--local]            check readiness (--local skips account/network)
  bun tm login                       log in to Trade Me in a browser window
  bun tm logout                      forget the Trade Me login
  bun tm setup [--suburb <name>] [--payments cash,bank-deposit,ping] [--shipping arranged|pickup-only|free] [--auction]
  bun tm suburb <name>               find a pickup suburb
  bun tm category <words>            find a category ID

listing
  bun tm inbox                       list photos in inbox/ with viewable previews
  bun tm collect downloads [--minutes 60]   copy recent photos from Downloads (AirDrop) into inbox/
  bun tm collect album "<name>"      copy new photos from an Apple Photos album into inbox/ (Mac)
  bun tm new <item>                  start a draft in listings/<item>/
  bun tm add-photos <item> <files or folders...>
  bun tm photo <item> <01.jpg> [--crop l,t,r,b] [--rotate 90] [--reset]
  bun tm status [item]               what's drafted, ready, live
  bun tm validate <item> [--reupload] [--accept-fees <max>]
  bun tm publish <item> [--accept-fees <max>]

after listing
  bun tm listings                    everything live on the account
  bun tm edit <item> [--apply]       push title, description and photo changes
  bun tm withdraw <item> --confirm [--reason <text>]
  bun tm relist <item>               start a fresh copy of an ended listing
  bun tm reconcile <item>            sort out an interrupted publish or edit`;

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

const { positional: [command, ...args], flags } = parse(Bun.argv.slice(2));
const flag = (name: string) => typeof flags[name] === "string" ? flags[name] as string : undefined;
const acceptFees = flag("accept-fees") === undefined ? undefined : Number(flag("accept-fees"));
const need = (value: string | undefined, usage: string) => { if (!value) throw new Problem(`missing argument`, `usage: ${usage}`); return value; };

async function categories() {
  const cache = resolve(SESSION_DIR, "categories.json");
  const cached = await readJson<{ at: number; tree: any }>(cache);
  if (cached && Date.now() - cached.at < 7 * 86400_000) return cached.tree;
  const response = await fetch("https://api.trademe.co.nz/v1/Categories.json", { signal: AbortSignal.timeout(60000) }).catch(() => undefined);
  if (!response?.ok) throw new Problem("couldn't download Trade Me's category list", "check the internet connection, then try again");
  const tree = await response.json();
  await writeJson(cache, { at: Date.now(), tree });
  return tree;
}

function flattenCategories(tree: any) {
  const out: { id: number; path: string; leaf: boolean }[] = [];
  const walk = (node: any) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const id = Number(String(node.Number ?? "").split("-").filter(Boolean).at(-1));
    if (Number.isSafeInteger(id) && id > 0) out.push({ id, path: String(node.Path ?? node.Name).replace(/^\//, "").replaceAll("/", " > "), leaf: node.IsLeaf === true });
    walk(node.Subcategories);
  };
  walk(tree);
  return out;
}

async function localities() {
  const cache = resolve(SESSION_DIR, "localities.json");
  const cached = await readJson<{ at: number; list: any }>(cache);
  if (cached && Date.now() - cached.at < 30 * 86400_000) return cached.list;
  const response = await fetch("https://api.trademe.co.nz/v1/Localities.json", { signal: AbortSignal.timeout(60000) }).catch(() => undefined);
  if (!response?.ok) throw new Problem("couldn't download Trade Me's suburb list", "check the internet connection, then try again");
  const list = await response.json();
  await writeJson(cache, { at: Date.now(), list });
  return list;
}

async function findSuburbs(text: string, districtId?: number) {
  const wanted = text.trim().toLowerCase();
  const out: { id: number; name: string; district: string; districtId: number; region: string }[] = [];
  for (const region of await localities()) for (const district of region.Districts ?? []) for (const suburb of district.Suburbs ?? []) {
    if (suburb.Name.toLowerCase().includes(wanted)) out.push({ id: suburb.SuburbId, name: suburb.Name, district: district.Name, districtId: district.DistrictId, region: region.Name });
  }
  const exact = out.filter(s => s.name.toLowerCase() === wanted);
  const pool = exact.length ? exact : out;
  return districtId ? [...pool.filter(s => s.districtId === districtId), ...pool.filter(s => s.districtId !== districtId)] : pool;
}

const describeShipping = (shipping: Shipping) => shipping === "arranged" ? "to be arranged" : shipping === "pickup-only" ? "none, pickup only" : shipping === "free" ? "free" : shipping.map(s => `${s.method} $${s.price}`).join(", ");

async function summary(slug: string, request: any, config: Config, client: Client, fees?: any) {
  const category = await client.request(`v1/categories/${request.Category}`).catch(() => undefined);
  const { item } = await loadItem(slug);
  const price = request.StartPrice !== undefined
    ? `auction from $${request.StartPrice}, reserve $${request.ReservePrice}${request.BuyNowPrice ? `, buy now $${request.BuyNowPrice}` : ""}`
    : `$${request.BuyNowPrice} buy now${request.IsCounterOffersAllowed ? ", offers allowed" : ""}`;
  console.log([
    `  title      ${request.Title}`,
    `  price      ${price}`,
    `  condition  ${request.IsBrandNew ? "brand new" : "used"}`,
    `  category   ${category?.Path?.replace(/^\//, "").replaceAll("/", " > ") ?? request.Category}`,
    `  photos     ${request.PhotoIds.length}`,
    `  pickup     ${request.Pickup === 3 ? "no pickup" : `${config.pickupSuburb.name}${request.Pickup === 2 ? " (pickup only)" : ""}`}`,
    `  shipping   ${describeShipping(item.shipping ?? config.shipping)}`,
    `  payment    ${(item.paymentMethods ?? config.paymentMethods).join(", ")}`,
    `  runs for   ${request.Duration} days`,
    ...(fees ? [`  fees now   $${fees.TotalCost.toFixed(2)} (a success fee applies if it sells)`] : []),
  ].join("\n"));
}

async function prepare(slug: string, reupload = false) {
  const config = await loadConfig();
  const loaded = await loadItem(slug);
  const problems = checkItem(loaded.item, config);
  if (problems.length) throw new Problem(`${slug} isn't ready:\n  - ${problems.join("\n  - ")}`);
  const client = await tradeMeClient();
  const category = await client.request(`v1/categories/${loaded.item.categoryId}`);
  if (category.IsLeaf === false) throw new Problem(`category ${loaded.item.categoryId} (${category.Path}) has subcategories`, "pick a more specific one with: bun tm category <words>");
  const photoIds = await uploadPhotos(client, loaded.dir, loaded.item, loaded.state, loaded.saveState, reupload);
  const request = buildRequest(loaded.item, config, photoIds);
  return { ...loaded, config, client, request, hash: sha256(JSON.stringify(request)) };
}

function requireUnpublished(state: any, slug: string) {
  if (state.listingId) throw new Problem(`${slug} is already live as ${state.listingUrl}`, `to change it: bun tm edit ${slug}. to list it again after it ends: bun tm relist ${slug}`);
  if (state.publishAttempt) throw new Problem(`an earlier publish of ${slug} didn't finish cleanly, so it might already be live`, `run: bun tm reconcile ${slug}`);
}

const commands: Record<string, () => Promise<void>> = {
  async help() { console.log(HELP); },

  async doctor() {
    let ok = true;
    const line = (pass: boolean, text: string, fix?: string) => { if (!pass) ok = false; console.log(`${pass ? "✓" : "✗"} ${text}${!pass && fix ? `\n    fix: ${fix}` : ""}`); };
    const [major, minor, patch] = Bun.version.split(".").map(Number);
    line(major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch >= 21))), `bun ${Bun.version}`, "install Bun 1.2.21 or newer: bun upgrade");
    line(process.platform === "darwin" && ["x64", "arm64"].includes(process.arch), `${process.platform}/${process.arch}`, "this version supports macOS on Apple Silicon or Intel; see README.md");
    try {
      const Sharp = (await import("sharp")).default;
      const jpeg = await Sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).jpeg().toBuffer();
      if ((await Sharp(jpeg).metadata()).width !== 2) throw Error("JPEG check failed");
      line(true, "photo tools: JPEG conversion works");
    } catch (error: any) {
      line(false, `photo tools: ${error.message}`, "run bun install --frozen-lockfile on this machine with optional dependencies enabled; see README.md");
    }
    const heic = await import("heic-convert").then(m => typeof m.default === "function", () => false);
    line(heic, "HEIC converter installed", "run: bun install --frozen-lockfile");
    const browser = findBrowser();
    line(Boolean(browser), browser ? `browser: ${browser}` : "no usable Chromium-based browser", "install Chrome/Edge/Brave/Chromium, or set TM_BROWSER to its executable's full path (check an existing override for typos)");
    try {
      const { rm } = await import("node:fs/promises");
      for (const dir of [SESSION_DIR, LISTINGS_DIR, INBOX_DIR]) {
        await mkdir(dir, { recursive: true });
        const probe = resolve(dir, `.doctor-${crypto.randomUUID()}.tmp`);
        try { await Bun.write(probe, "write check"); } finally { await rm(probe, { force: true }); }
      }
      line(true, "workspace writable");
    } catch { line(false, "workspace is not writable", "move the repo to a folder owned by the current user"); }
    if (flags.local) {
      console.log(ok ? "\nlocal checks passed. next: bun tm login, bun tm setup, then bun tm doctor." : "\nfix the ✗ lines, then run bun tm doctor --local again.");
      if (!ok) process.exitCode = 1;
      return;
    }
    const config = await readJson<Config>(CONFIG_PATH).catch(() => undefined);
    let client: Client | undefined;
    try {
      client = await tradeMeClient();
      const me = await client.request("v1/mytrademe/summary");
      line(true, `logged in as ${me.Nickname}`);
      line(me.IsAddressVerified === true, "address verified", "Trade Me may block selling until the address is verified. do it in My Trade Me > account settings");
    } catch (error: any) {
      line(false, `Trade Me login: ${error.message}`, error.fix ?? "run: bun tm login");
    }
    line(Boolean(config?.pickupSuburb?.id), config ? `defaults: pickup ${config.pickupSuburb?.name ?? "missing"}` : "no config.json", "run: bun tm setup");
    console.log(ok ? "\nall good. ready to list." : "\nfix the ✗ lines above, then run bun tm doctor again.");
    if (!ok) process.exitCode = 1;
  },

  async login() {
    await login();
    const client = await tradeMeClient();
    const me = await client.request("v1/mytrademe/summary");
    console.log(`logged in as ${me.Nickname}.`);
    if (!await Bun.file(CONFIG_PATH).exists()) console.log("next: bun tm setup");
  },

  async logout() { await logout(); console.log("logged out. the workspace's browser profile is deleted too."); },

  async setup() {
    const existing = await readJson<Config>(CONFIG_PATH);
    let client: Client | undefined;
    try { client = await tradeMeClient(); } catch {}
    let me: any, prefs: any;
    if (client) [me, prefs] = await Promise.all([client.request("v1/mytrademe/summary"), client.request("v1/selling/preferences").catch(() => undefined)]);

    const suburbName = flag("suburb") ?? existing?.pickupSuburb?.name ?? me?.MembershipAddress?.Suburb;
    if (!suburbName) throw new Problem("don't know the pickup suburb yet", "log in first (bun tm login) so it can be read from the account, or pass --suburb <name>");
    const matches = await findSuburbs(suburbName, me?.ClosestDistrictId);
    if (!matches.length) throw new Problem(`no Trade Me suburb called "${suburbName}"`, "search with: bun tm suburb <part of the name>");
    const suburb = flag("suburb-id") ? matches.find(s => s.id === Number(flag("suburb-id"))) : matches[0];
    if (!suburb) throw new Problem("that --suburb-id isn't one of the matches", `run: bun tm suburb "${suburbName}"`);
    const ambiguous = !flag("suburb-id") && matches.filter(s => s.name.toLowerCase() === suburb.name.toLowerCase()).length > 1;

    const fromAccount = (prefs?.DefaultEnabledSellingMethods ?? []).map((id: number) => Object.keys(PAYMENT_IDS).find(name => PAYMENT_IDS[name] === id)).filter(Boolean);
    const payments = flag("payments")?.split(",").map(s => s.trim().toLowerCase().replace(/\s+/g, "-")) ?? existing?.paymentMethods ?? (fromAccount.length ? fromAccount : ["cash", "bank-deposit"]);
    for (const name of payments) if (!PAYMENT_IDS[name]) throw new Problem(`unknown payment method "${name}"`, `use: ${Object.keys(PAYMENT_IDS).join(", ")}`);
    const shipping = (flag("shipping") as Shipping | undefined) ?? existing?.shipping ?? "arranged";
    if (!["arranged", "pickup-only", "free"].includes(shipping as string) && !Array.isArray(shipping)) throw new Problem('--shipping takes arranged, pickup-only or free');

    const config: Config = {
      pickupSuburb: { id: suburb.id, name: suburb.name, district: suburb.district },
      paymentMethods: payments,
      shipping,
      pickup: existing?.pickup ?? true,
      listingType: flags.auction ? "auction" : flags["buy-now"] ? "buy-now" : existing?.listingType ?? "buy-now",
      durationDays: Number(flag("days") ?? existing?.durationDays ?? 7),
      allowOffers: existing?.allowOffers ?? false,
    };
    await writeJson(CONFIG_PATH, config);
    console.log(`saved config.json:
  pickup     ${suburb.name}, ${suburb.district}${ambiguous ? `  (there's more than one ${suburb.name}; check with: bun tm suburb "${suburb.name}")` : ""}
  payment    ${payments.join(", ")}${!flag("payments") && fromAccount.length ? " (from the account's selling preferences)" : ""}
  shipping   ${describeShipping(shipping)}
  type       ${config.listingType}, ${config.durationDays} days
confirm these with the seller. every item can override them in its listing.json.`);
  },

  async suburb() {
    const text = need(args.join(" "), "bun tm suburb <name>");
    const matches = await findSuburbs(text);
    if (!matches.length) return console.log("no matches. try part of the name.");
    for (const s of matches.slice(0, 20)) console.log(`${s.id}\t${s.name}, ${s.district}, ${s.region}`);
  },

  async category() {
    const words = need(args.join(" "), "bun tm category <words>").toLowerCase().split(/\s+/);
    const matches = flattenCategories(await categories()).filter(c => c.leaf && words.every(w => c.path.toLowerCase().includes(w)));
    if (!matches.length) return console.log("no leaf categories match all those words. try fewer or broader words.");
    for (const c of matches.slice(0, 30)) console.log(`${c.id}\t${c.path}`);
    if (matches.length > 30) console.log(`...and ${matches.length - 30} more. add a word to narrow it down.`);
  },

  async inbox() {
    const previews = await inboxPreviews();
    if (!previews.length) return console.log("inbox/ is empty. drop photos into it, or pass photo paths straight to add-photos.");
    for (const p of previews) console.log(`${p.file}\tpreview: ${p.preview}`);
  },

  async collect() {
    const source = need(args[0], 'bun tm collect downloads | album "<name>"');
    const copied = source === "downloads" ? await fromDownloads(Number(flag("minutes") ?? 60))
      : source === "album" ? await fromAlbum(need(args.slice(1).join(" "), 'bun tm collect album "<name>"'))
      : (() => { throw new Problem(`unknown source "${source}"`, 'use: downloads or album "<name>"'); })();
    console.log(copied.length ? `copied ${copied.length} new photo${copied.length === 1 ? "" : "s"} into inbox/. run bun tm inbox to see them.` : "no new photos found.");
  },

  async new() {
    const slug = need(args[0], "bun tm new <item>");
    const dir = itemDir(slug);
    if (await Bun.file(resolve(dir, "listing.json")).exists()) throw new Problem(`${slug} already exists`, "pick another name, or keep editing listings/" + slug + "/listing.json");
    await mkdir(resolve(dir, "photos"), { recursive: true });
    await writeJson(resolve(dir, "listing.json"), defaultItem(await loadConfig()));
    console.log(`created listings/${slug}/listing.json`);
  },

  async "add-photos"() {
    const slug = need(args[0], "bun tm add-photos <item> <files or folders...>");
    const { dir, item, state, saveItem, saveState } = await loadItem(slug);
    const added = await addPhotos(dir, item, state, args.slice(1));
    await saveState();
    await saveItem();
    console.log(`added ${added.length} photo${added.length === 1 ? "" : "s"}: ${added.map(f => `listings/${slug}/photos/${f}`).join(", ") || "none"}`);
  },

  async photo() {
    const slug = need(args[0], "bun tm photo <item> <01.jpg> [--crop l,t,r,b] [--rotate 90] [--reset]");
    const file = need(args[1], "bun tm photo <item> <01.jpg> [--crop l,t,r,b] [--rotate 90] [--reset]");
    const { dir, state, saveState } = await loadItem(slug);
    await editPhoto(dir, state, file, { crop: flag("crop")?.split(",").map(Number), rotate: flag("rotate") === undefined ? undefined : Number(flag("rotate")), reset: flags.reset === true });
    await saveState();
    console.log(`updated listings/${slug}/photos/${file}. the original is untouched.`);
  },

  async status() {
    const config = await loadConfig().catch(() => undefined);
    const slugs = args[0] ? [args[0]] : (await readdir(LISTINGS_DIR, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory()).map(d => d.name).sort();
    if (!slugs.length) return console.log("no items yet. start one with: bun tm new <item>");
    for (const slug of slugs) {
      const { item, state } = await loadItem(slug).catch(() => ({ item: undefined, state: {} as any }));
      if (!item) { console.log(`${slug}\tno listing.json`); continue; }
      const problems = config ? checkItem(item, config) : ["config.json missing"];
      const stage = state.withdrawnAt ? "withdrawn" : state.listingId ? `live ${state.listingUrl}` : state.publishAttempt ? "publish interrupted, run reconcile" : problems.length ? `draft: ${problems.join("; ")}` : "ready to validate";
      console.log(`${slug}\t${stage}`);
    }
  },

  async validate() {
    const slug = need(args[0], "bun tm validate <item>");
    const { state, saveState, client, request, hash, config } = await prepare(slug, flags.reupload === true);
    requireUnpublished(state, slug);
    await client.request("v1/selling/validate", request);
    const fees = await client.request("v1/selling/fees", request);
    feesAccepted(fees, acceptFees);
    state.validation = { hash, at: new Date().toISOString() };
    await saveState();
    console.log(`${slug} passed Trade Me's checks:`);
    await summary(slug, request, config, client, fees);
    console.log(`\nshow this to the seller. once they say go: bun tm publish ${slug}`);
  },

  async publish() {
    const slug = need(args[0], "bun tm publish <item>");
    const { state, saveState, client, request, hash, config } = await prepare(slug);
    requireUnpublished(state, slug);
    if (state.validation?.hash !== hash) throw new Problem("the listing changed since it was last validated (or was never validated)", `run: bun tm validate ${slug}, show the seller, then publish`);
    feesAccepted(await client.request("v1/selling/fees", request), acceptFees);
    // Record the attempt first. If anything goes wrong past this point we can't
    // be sure whether the listing exists, so reconcile must check before retrying.
    state.publishAttempt = { hash, at: new Date().toISOString(), title: request.Title };
    await saveState();
    const result = await client.request("v1/selling", request);
    const id = result.ListingId ?? result.Listing?.ListingId ?? result.ListingDetails?.ListingId;
    if (result.Success !== true || !Number.isSafeInteger(id)) throw new Problem("Trade Me's reply didn't confirm the listing", `run: bun tm reconcile ${slug}`);
    state.listingId = id;
    state.listingUrl = listingUrl(id);
    state.publishedAt = new Date().toISOString();
    delete state.publishAttempt;
    await saveState();
    await verify(slug, client, request, id);
    state.verifiedAt = new Date().toISOString();
    await saveState();
    console.log(`live: ${state.listingUrl}`);
    await summary(slug, request, config, client);
  },

  async listings() {
    const client = await tradeMeClient();
    const { listings, complete } = await liveListings(client);
    const local = new Map<number, string>();
    for (const slug of await readdir(LISTINGS_DIR).catch(() => [])) {
      const state = await readJson(resolve(LISTINGS_DIR, slug, "state.json")).catch(() => undefined);
      if (state?.listingId) local.set(state.listingId, slug);
    }
    if (!listings.length) console.log("nothing live right now.");
    for (const l of listings.sort((a, b) => (a.endsAt ?? "").localeCompare(b.endsAt ?? ""))) {
      console.log(`${l.id}\t${l.title}\t${l.price !== undefined ? `$${l.price}` : ""}\t${l.views ?? "?"} views${l.watchers !== undefined ? `, ${l.watchers} watching` : ""}\tends ${l.endsAt ?? "?"} UTC\t${local.get(l.id) ?? "(not in this workspace)"}`);
    }
    if (!complete) console.log("\nnote: Trade Me's newer listing feed didn't answer, so listings created on the website may be missing.");
    const [sold, unsold] = await Promise.all([
      client.request("v1/mytrademe/solditems/last45days", undefined, { rows: 20 }).catch(() => undefined),
      client.request("v1/mytrademe/unsolditems", undefined, { rows: 20 }).catch(() => undefined),
    ]);
    if (sold?.List?.length) { console.log("\nsold (last 45 days):"); for (const s of sold.List) console.log(`${s.ListingId}\t${s.Title}\t$${s.Price}\t${s.Buyer?.Nickname ?? ""}`); }
    if (unsold?.List?.length) { console.log("\nended without selling:"); for (const u of unsold.List) console.log(`${u.ListingId}\t${u.Title}\t${local.get(u.ListingId) ? `relist with: bun tm relist ${local.get(u.ListingId)}` : ""}`); }
  },

  async edit() {
    const slug = need(args[0], "bun tm edit <item> [--apply]");
    const config = await loadConfig();
    const { dir, item, state, saveState } = await loadItem(slug);
    const id = state.listingId;
    if (!id || state.withdrawnAt) throw new Problem(`${slug} isn't live`, `publish it first: bun tm validate ${slug}`);
    if (state.editAttempt) throw new Problem("an earlier edit didn't finish cleanly", `run: bun tm reconcile ${slug}`);
    const problems = checkItem(item, config);
    if (problems.length) throw new Problem(`listing.json has problems:\n  - ${problems.join("\n  - ")}`);
    const client = await tradeMeClient();
    if (await platform(client, id) === 2) throw new Problem("this listing lives on Trade Me's newer selling system, which this tool can't edit yet", `edit it on trademe.co.nz: ${listingUrl(id)}`);
    const current = await client.request(`v1/selling/listings/${id}`);
    const photoIds = await uploadPhotos(client, dir, item, state, saveState);
    const changes = changesFrom(current, { title: item.title, description: item.description, photoIds });
    if (!Object.keys(changes).length) return console.log("nothing to change. title, description and photos already match listing.json.");
    const request = editRequest(current, changes);
    const hash = sha256(JSON.stringify(request));
    const fees = await client.request("v1/selling/editfees", request);
    feesAccepted(fees, acceptFees, "edit");
    if (!flags.apply) {
      await client.request("v1/selling/validate", request);
      state.validation = { hash, at: new Date().toISOString() };
      await saveState();
      console.log(`will change: ${Object.keys(changes).map(k => k === "PhotoIds" ? "photos" : k.toLowerCase()).join(", ")}. no fees.\nprice, shipping and everything else stay as they are.\nonce the seller is happy: bun tm edit ${slug} --apply`);
      return;
    }
    if (state.validation?.hash !== hash || Date.now() - Date.parse(state.validation.at) > 30 * 60_000) throw new Problem("this edit hasn't been checked in the last 30 minutes", `run: bun tm edit ${slug} (without --apply) first`);
    state.editAttempt = { hash, at: new Date().toISOString() };
    await saveState();
    const result = await client.request("v1/selling/edit", request);
    if (result.Success !== true) throw new Problem("Trade Me didn't confirm the edit", `run: bun tm reconcile ${slug}`);
    await verify(slug, client, request, id);
    state.edits = [...(state.edits ?? []), { at: new Date().toISOString(), hash }];
    delete state.editAttempt;
    await saveState();
    console.log(`updated and checked: ${listingUrl(id)}`);
  },

  async withdraw() {
    const slug = need(args[0], "bun tm withdraw <item> --confirm");
    const { state, saveState } = await loadItem(slug);
    if (!state.listingId || state.withdrawnAt) throw new Problem(`${slug} isn't live`);
    if (flags.confirm !== true) throw new Problem("withdrawing takes the listing down for good", `ask the seller first, then run: bun tm withdraw ${slug} --confirm`);
    const client = await tradeMeClient();
    await withdraw(client, state.listingId, flag("reason") ?? "no longer for sale");
    // The selling lists lag behind by minutes; the listing's own end time is immediate.
    if (!await hasEnded(client, state.listingId)) throw new Problem("Trade Me accepted the withdrawal but the listing hasn't closed yet", `wait a minute, then check ${state.listingUrl}`);
    state.withdrawnAt = new Date().toISOString();
    await saveState();
    console.log(`withdrawn: ${state.listingUrl}`);
  },

  async relist() {
    const slug = need(args[0], "bun tm relist <item>");
    const { state, saveState } = await loadItem(slug);
    if (!state.listingId) throw new Problem(`${slug} was never published`, `run: bun tm validate ${slug}`);
    const client = await tradeMeClient();
    if (!state.withdrawnAt && !await hasEnded(client, state.listingId)) throw new Problem(`${slug} is still live`, "wait for it to end, or withdraw it first");
    // Keep the old listing's record, then clear the way for a fresh publish.
    const { photoSources, uploads, previous = [], ...last } = state;
    for (const key of Object.keys(state)) if (key !== "photoSources") delete (state as any)[key];
    state.previous = [...previous, last];
    await saveState();
    console.log(`ready to list again. tweak listing.json if anything changed (price, description), then: bun tm validate ${slug}`);
  },

  async reconcile() {
    const slug = need(args[0], "bun tm reconcile <item>");
    const { state, saveState } = await loadItem(slug);
    const client = await tradeMeClient();
    if (state.publishAttempt) {
      const age = Date.now() - Date.parse(state.publishAttempt.at);
      const { listings, complete } = await liveListings(client);
      const matches = listings.filter(l => l.title === state.publishAttempt!.title);
      if (matches.length === 1) {
        state.listingId = matches[0].id;
        state.listingUrl = listingUrl(matches[0].id);
        state.publishedAt = state.publishAttempt.at;
        delete state.publishAttempt;
        await saveState();
        return console.log(`it did go live: ${state.listingUrl}. recorded it. check it on Trade Me.`);
      }
      if (matches.length > 1) throw new Problem(`${matches.length} live listings share this title: ${matches.map(m => m.id).join(", ")}`, "check them on Trade Me and withdraw any duplicate there");
      if (age < 3 * 60_000) throw new Problem("not showing on Trade Me yet, but it's only been a moment", "wait 3 minutes and run reconcile again");
      if (!complete) throw new Problem("couldn't check every listing feed, so it's not safe to say it's missing", "check My Trade Me > selling on the website for this title");
      delete state.publishAttempt;
      delete state.validation;
      await saveState();
      return console.log(`it never went live. safe to try again: bun tm validate ${slug}`);
    }
    if (state.editAttempt && state.listingId) {
      // Edits are idempotent: re-running the check shows what, if anything, still differs.
      delete state.editAttempt;
      delete state.validation;
      await saveState();
      return console.log(`cleared the interrupted edit. run bun tm edit ${slug} to see whether anything still needs changing.`);
    }
    console.log("nothing to reconcile.");
  },
};

async function hasEnded(client: Client, id: number) {
  const details = await client.request(`v1/listings/${id}`);
  const end = Number(String(details.EndDate).match(/\d+/)?.[0]);
  const asAt = Number(String(details.AsAt).match(/\d+/)?.[0]) || Date.now();
  return Number.isFinite(end) && end <= asAt;
}

async function verify(slug: string, client: Client, request: any, id: number) {
  const live = await client.request(`v1/selling/listings/${id}`);
  await writeJson(resolve(itemDir(slug), "live.json"), live);
  const differs = differences(request, live);
  if (differs.length) throw new Problem(`it's live at ${listingUrl(id)}, but Trade Me saved a different ${differs.join(", ")} than requested`, `compare listings/${slug}/live.json with listing.json, then fix with: bun tm edit ${slug}`);
}

const run = commands[command ?? "help"] ?? (async () => { console.log(HELP); process.exitCode = 1; });
try {
  await run();
} catch (error: any) {
  if (error instanceof Problem) {
    console.error(`✗ ${error.message}${error.fix ? `\n  fix: ${error.fix}` : ""}`);
  } else {
    console.error(`✗ unexpected error: ${error?.stack ?? error}\n  fix: run bun tm doctor. if that's all green, this is a bug; the message above is what to report.`);
  }
  process.exitCode = 1;
}
