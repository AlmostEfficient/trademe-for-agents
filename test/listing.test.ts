import { expect, test } from "bun:test";
import { buildRequest, checkItem, differences, feesAccepted, type Config, type Item } from "../src/listing";
import { changesFrom, editRequest } from "../src/manage";
import { cookieHeader, mergeSetCookies } from "../src/session";

const config: Config = {
  pickupSuburb: { id: 84, name: "Herne Bay" },
  paymentMethods: ["cash", "ping"],
  shipping: "arranged",
  pickup: true,
  listingType: "buy-now",
  durationDays: 7,
  allowOffers: false,
};
const item = (overrides: Partial<Item> = {}): Item => ({
  title: "Peak Design Everyday Backpack 30L", description: "used a few times.", condition: "used",
  categoryId: 8982, price: { buyNow: 199.99 }, photos: ["01.jpg"], ...overrides,
});

test("buy now listing uses defaults and stays free", () => {
  const request = buildRequest(item(), config, [11]);
  expect(request).toMatchObject({ Category: "8982", BuyNowPrice: 199.99, Quantity: 1, Pickup: 1, PickupSuburbId: 84, ShippingOptions: [{ Type: 1 }], PaymentMethods: [4, 32], PromotionId: 1, IsFeatured: false });
  expect("StartPrice" in request).toBe(false);
});

test("auction omits quantity and defaults reserve to start", () => {
  const request = buildRequest(item({ price: { start: 20 } }), config, [11]);
  expect(request).toMatchObject({ StartPrice: 20, ReservePrice: 20 });
  expect("Quantity" in request).toBe(false);
  expect("BuyNowPrice" in request).toBe(false);
  expect(() => buildRequest(item({ price: { start: 20, reserve: 10 } }), config, [11])).toThrow(/reserve/);
  expect(() => buildRequest(item({ price: { start: 20, buyNow: 20 } }), config, [11])).toThrow(/above the reserve/);
});

test("shipping shapes", () => {
  expect(buildRequest(item({ shipping: "pickup-only" }), config, [1])).toMatchObject({ Pickup: 2, ShippingOptions: [] });
  expect(buildRequest(item({ shipping: "free" }), config, [1]).ShippingOptions).toEqual([{ Type: 3 }]);
  expect(buildRequest(item({ shipping: [{ method: "NZ Post", price: 12.5 }] }), config, [1]).ShippingOptions).toEqual([{ Type: 4, Price: 12.5, Method: "NZ Post" }]);
  expect(() => buildRequest(item({ shipping: "pickup-only", pickup: false }), config, [1])).not.toThrow();
  expect(() => buildRequest(item({ shipping: [], pickup: false }), config, [1])).toThrow();
});

test("drafts report every missing piece", () => {
  const problems = checkItem({ title: "", description: "", condition: "used", categoryId: null, price: {}, photos: [] }, config);
  expect(problems.length).toBe(5);
  expect(checkItem(item({ title: "x".repeat(81) }), config)[0]).toMatch(/80/);
  expect(checkItem(item({ paymentMethods: ["bitcoin"] }), config)[0]).toMatch(/bitcoin/);
});

test("cents are handled exactly", () => {
  expect(buildRequest(item({ price: { buyNow: 19.99 } }), config, [1]).BuyNowPrice).toBe(19.99);
  expect(() => buildRequest(item({ price: { buyNow: 19.999 } }), config, [1])).toThrow();
});

test("fees: zero passes, anything else needs an explicit ceiling", () => {
  expect(() => feesAccepted({ TotalCost: 0, FeeItems: { List: [] } }, undefined)).not.toThrow();
  expect(() => feesAccepted({ TotalCost: 0.25 }, undefined)).toThrow(/\$0\.25/);
  expect(() => feesAccepted({ TotalCost: 0.25 }, 0.25)).not.toThrow();
  expect(() => feesAccepted({ TotalCost: 1 }, 0.25)).toThrow();
});

test("verification spots differences and tolerates Trade Me's omissions", () => {
  const request = buildRequest(item({ price: { start: 20 } }), config, [1, 2]);
  const live = { ...request, Description: ["used a few times."], ReservePrice: undefined, ShippingOptions: [{ Type: 1, Price: 0, Method: "To be arranged" }] };
  expect(differences(request, live)).toEqual([]);
  expect(differences(request, { ...live, PhotoIds: [2, 1] })).toEqual(["photo order"]);
  const pickupOnly = buildRequest(item({ shipping: "pickup-only" }), config, [1]);
  expect(differences(pickupOnly, { ...pickupOnly, ShippingOptions: [{ Type: 2, Price: 0 }] })).toEqual([]);
});

test("edits keep every sale term and refuse unknown fields", () => {
  const current = { ListingId: 5, Title: "old", Description: ["d"], PhotoIds: [1], BuyNowPrice: 10, ShippingOptions: [{ Type: 1 }], Photos: [], ImmutableFields: [] };
  const changes = changesFrom(current, { title: "new", description: "d", photoIds: [1] });
  expect(changes).toEqual({ Title: "new" });
  expect(editRequest(current, changes)).toMatchObject({ Title: "new", BuyNowPrice: 10, ShippingOptions: [{ Type: 1 }] });
  expect(() => editRequest({ ...current, SurpriseField: 1 }, changes)).toThrow(/doesn't know/);
  expect(() => editRequest({ ...current, ImmutableFields: ["Title"] }, changes)).toThrow(/locked/);
});

test("cookies only go to Trade Me and follow rotations", () => {
  const cookies = [{ name: "a", value: "1", domain: ".trademe.co.nz", path: "/" }, { name: "b", value: "2", domain: "www.trademe.co.nz", path: "/a" }];
  expect(cookieHeader(cookies, "https://www.trademe.co.nz/a/token-refresh")).toBe("b=2; a=1");
  expect(cookieHeader(cookies, "https://api.trademe.co.nz/x")).toBe("a=1");
  expect(() => cookieHeader(cookies, "https://evil.example/")).toThrow();
  const rotated = mergeSetCookies(cookies, ["a=9; Domain=trademe.co.nz; Path=/", "b=; Path=/a; Max-Age=0"], "https://www.trademe.co.nz/a/token-refresh");
  expect(rotated).toEqual([{ name: "a", value: "9", domain: ".trademe.co.nz", path: "/" }]);
});
