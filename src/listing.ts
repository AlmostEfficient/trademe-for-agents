import { resolve } from "node:path";
import { CONFIG_PATH, Problem, itemDir, readJson, same, writeJson } from "./util";

export const PAYMENT_IDS: Record<string, number> = { "bank-deposit": 1, "credit-card": 2, cash: 4, "safe-trader": 8, ping: 32, afterpay: 64 };

export type Shipping = "arranged" | "free" | "pickup-only" | { method: string; price: number }[];

export type Config = {
  pickupSuburb: { id: number; name: string; district?: string };
  paymentMethods: string[];
  shipping: Shipping;
  pickup: boolean;
  listingType: "buy-now" | "auction";
  durationDays: number;
  allowOffers: boolean;
  photoAlbum?: string;
};

// listing.json: written by the agent. Anything left out falls back to config.json.
export type Item = {
  title: string;
  description: string;
  condition: "used" | "new";
  categoryId: number | null;
  price: { buyNow?: number | null; start?: number | null; reserve?: number | null };
  photos: string[];
  notes?: string;
  shipping?: Shipping;
  pickup?: boolean;
  paymentMethods?: string[];
  durationDays?: number;
  allowOffers?: boolean;
};

// state.json: written only by the tool. Records what happened on Trade Me.
export type State = {
  photoSources?: { file: string; original: string; crop?: number[]; rotate?: number }[];
  uploads?: { file: string; sha256: string; photoId: number; at: string }[];
  validation?: { hash: string; at: string };
  publishAttempt?: { hash: string; at: string; title: string };
  listingId?: number;
  listingUrl?: string;
  publishedAt?: string;
  verifiedAt?: string;
  withdrawnAt?: string;
  editAttempt?: { hash: string; at: string };
  edits?: { at: string; hash: string }[];
  previous?: Omit<State, "previous" | "photoSources" | "uploads">[];
};

export async function loadConfig(): Promise<Config> {
  const config = await readJson<Config>(CONFIG_PATH);
  if (!config) throw new Problem("config.json is missing", "run: bun tm setup");
  if (!Number.isSafeInteger(config.pickupSuburb?.id)) throw new Problem("config.json has no pickup suburb", "run: bun tm suburb <name>, then bun tm setup --suburb <name>");
  return config;
}

export async function loadItem(slug: string) {
  const dir = itemDir(slug);
  const item = await readJson<Item>(resolve(dir, "listing.json"));
  if (!item) throw new Problem(`no item called ${slug}`, `run: bun tm new ${slug}`);
  const state = await readJson<State>(resolve(dir, "state.json")) ?? {};
  return { dir, item, state, saveState: () => writeJson(resolve(dir, "state.json"), state), saveItem: () => writeJson(resolve(dir, "listing.json"), item) };
}

const money = (value: unknown, label: string) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.5 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw new Problem(`${label} must be a dollar amount of at least $0.50 (got ${JSON.stringify(value)})`, `set ${label} in listing.json`);
  return Math.round(n * 100) / 100;
};

// Everything that can be caught without asking Trade Me.
export function checkItem(item: Item, config: Config) {
  const problems: string[] = [];
  if (!item.title?.trim()) problems.push("title is empty");
  else if (item.title.length > 80) problems.push(`title is ${item.title.length} characters; Trade Me allows 80`);
  if (!item.description?.trim()) problems.push("description is empty");
  if (!Number.isSafeInteger(item.categoryId)) problems.push("categoryId is not set (find one with: bun tm category <words>)");
  if (!item.photos?.length) problems.push("no photos (add some with: bun tm add-photos <item> <files>)");
  if (item.photos?.length > 20) problems.push(`${item.photos.length} photos; Trade Me allows 20`);
  if (!["used", "new"].includes(item.condition)) problems.push('condition must be "used" or "new"');
  const type = listingType(item, config);
  if (type === "buy-now" && item.price?.buyNow == null) problems.push("price.buyNow is not set");
  if (type === "auction" && item.price?.start == null) problems.push("price.start is not set");
  for (const name of item.paymentMethods ?? config.paymentMethods) if (!PAYMENT_IDS[name]) problems.push(`unknown payment method "${name}" (use: ${Object.keys(PAYMENT_IDS).join(", ")})`);
  return problems;
}

// Auction if a start price is given, otherwise Buy Now. Config is the tiebreak for empty drafts.
export const listingType = (item: Item, config: Config) =>
  item.price?.start != null ? "auction" : item.price?.buyNow != null ? "buy-now" : config.listingType;

export function buildRequest(item: Item, config: Config, photoIds: number[]) {
  const problems = checkItem(item, config);
  if (problems.length) throw new Problem(`listing.json isn't ready:\n  - ${problems.join("\n  - ")}`);
  if (!photoIds.length || photoIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Error("uploaded photo IDs are required");

  const shipping = item.shipping ?? config.shipping;
  const allowPickup = item.pickup ?? config.pickup;
  // Pickup: 1 = allowed, 2 = pickup only, 3 = no pickup.
  const pickup = shipping === "pickup-only" ? 2 : allowPickup ? 1 : 3;
  // ShippingOptions Type: 1 = to be arranged, 3 = free, 4 = fixed price with a method name.
  const shippingOptions =
    shipping === "pickup-only" ? [] :
    shipping === "arranged" ? [{ Type: 1 }] :
    shipping === "free" ? [{ Type: 3 }] :
    Array.isArray(shipping) && shipping.length ? shipping.map(option => {
      if (!option.method?.trim()) throw new Problem("each shipping option needs a method, like \"NZ Post tracked\"");
      return { Type: 4, Price: money(option.price, "shipping price"), Method: option.method.trim() };
    }) : (() => { throw new Problem('shipping must be "arranged", "free", "pickup-only" or a list of {method, price}'); })();
  if (pickup === 3 && !shippingOptions.length) throw new Problem("no pickup and no shipping means nobody can get the item");

  const prices: Record<string, number> = {};
  const type = listingType(item, config);
  if (type === "auction") {
    prices.StartPrice = money(item.price.start, "price.start");
    // Reserve defaults to the start price, so the item sells to the first bid.
    prices.ReservePrice = item.price.reserve == null ? prices.StartPrice : money(item.price.reserve, "price.reserve");
    if (prices.ReservePrice < prices.StartPrice) throw new Problem("price.reserve must be at least price.start");
    if (item.price.buyNow != null) {
      prices.BuyNowPrice = money(item.price.buyNow, "price.buyNow");
      if (prices.BuyNowPrice <= prices.ReservePrice) throw new Problem("price.buyNow must be above the reserve");
    }
  } else {
    prices.BuyNowPrice = money(item.price.buyNow, "price.buyNow");
  }

  return {
    Category: String(item.categoryId),
    Title: item.title.trim(),
    Description: [item.description.replace(/\r\n?/g, "\n").trim()],
    ...prices,
    // Any Quantity, even 1, makes a listing Buy Now only, so auctions omit it.
    ...(type === "buy-now" ? { Quantity: 1 } : {}),
    Duration: item.durationDays ?? config.durationDays,
    Pickup: pickup,
    PickupSuburbId: config.pickupSuburb.id,
    IsBrandNew: item.condition === "new",
    IsClassified: false,
    IsCounterOffersAllowed: type === "buy-now" && Boolean(item.allowOffers ?? config.allowOffers),
    IsFlatShippingCharge: false,
    PhotoIds: photoIds,
    ShippingOptions: shippingOptions,
    PaymentMethods: (item.paymentMethods ?? config.paymentMethods).map(name => PAYMENT_IDS[name]),
    // Basic promotion is free. Every paid extra is switched off.
    PromotionId: 1,
    IsBold: false, IsFeatured: false, IsHighlighted: false, HasGallery: false,
    HasGalleryPlus: false, HasSuperFeature: false, IsHomepageFeatured: false,
    ReturnListingDetails: true,
  };
}

export type ListingRequest = ReturnType<typeof buildRequest>;

export function assertNoFees(fees: any, what = "listing") {
  const items = fees?.FeeItems?.List ?? [];
  if (fees?.TotalCost === 0 && Array.isArray(items) && items.every((item: any) => item.Debit === 0)) return;
  const total = typeof fees?.TotalCost === "number" ? `$${fees.TotalCost.toFixed(2)}` : "an unknown amount";
  throw new Problem(`this ${what} would cost ${total} up front`, `nothing was charged. if the seller is happy to pay, re-run with --accept-fees ${typeof fees?.TotalCost === "number" ? fees.TotalCost : "<amount>"}`);
}

export function feesAccepted(fees: any, accepted: number | undefined, what?: string) {
  if (accepted !== undefined && typeof fees?.TotalCost === "number" && fees.TotalCost <= accepted) return;
  assertNoFees(fees, what);
}

export const normalizeDescription = (value: unknown) => {
  const text = Array.isArray(value) ? value.join("\n") : String(value ?? "");
  return text.replace(/\r\n?/g, "\n").trim();
};

// Compare what was asked for with what Trade Me saved. Returns the fields that differ.
export function differences(request: Record<string, any>, live: Record<string, any>) {
  const differs: string[] = [];
  for (const key of ["Title", "Pickup", "Quantity", "Duration", "BuyNowPrice", "StartPrice"]) {
    if (request[key] === undefined) continue;
    if (!same(request[key], live[key])) differs.push(key);
  }
  // Trade Me can leave the reserve out when it equals the start price.
  if (request.ReservePrice !== undefined && !(live.ReservePrice === request.ReservePrice || (live.ReservePrice === undefined && request.ReservePrice === request.StartPrice))) differs.push("ReservePrice");
  if (String(request.Category) !== String(live.Category)) differs.push("Category");
  if (request.PickupSuburbId !== live.PickupSuburbId) differs.push("PickupSuburbId");
  if (normalizeDescription(request.Description) !== normalizeDescription(live.Description)) differs.push("Description");
  if (!same(request.PhotoIds, live.PhotoIds)) differs.push("photo order");
  if (!Array.isArray(live.PaymentMethods) || !same([...request.PaymentMethods].sort(), [...live.PaymentMethods].sort())) differs.push("PaymentMethods");
  const liveShipping = (live.ShippingOptions ?? []) as any[];
  if (request.Pickup === 2) {
    // Pickup-only can come back as a single free Type 2 entry.
    if (liveShipping.some(option => option.Type !== 2 || option.Price !== 0)) differs.push("ShippingOptions");
  } else {
    const shape = (options: any[]) => options.map(o => o.Type === 4 ? { Type: 4, Price: o.Price, Method: o.Method } : { Type: o.Type });
    if (!same(shape(request.ShippingOptions), shape(liveShipping))) differs.push("ShippingOptions");
  }
  return differs;
}

export function defaultItem(config: Config): Item {
  return {
    title: "",
    description: "",
    condition: "used",
    categoryId: null,
    price: config.listingType === "auction" ? { start: null, reserve: null, buyNow: null } : { buyNow: null },
    photos: [],
    notes: "",
  };
}
