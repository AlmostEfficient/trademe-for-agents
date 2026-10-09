import type { Client } from "./client";
import { normalizeDescription } from "./listing";
import { Problem, same } from "./util";

// Trade Me's edit call needs the whole sell form back: anything left out is
// reset to its default. These are the fields it accepts, checked against the
// official "Edit an item" reference and the first-party client in October 2026.
const EDITABLE = new Set(`Category Title Subtitle Description StartPrice ReservePrice BuyNowPrice Duration EndDateTime Pickup PickupSuburbId IsBrandNew AuthenticatedMembersOnly IsClassified OpenHomes SendPaymentInstructions OtherPaymentMethod IsOrNearOffer IsPriceOnApplication IsBold IsFeatured IsHomepageFeatured HasGallery HasGalleryPlus Quantity IsFlatShippingCharge HasAgreedWithLegalNotice AutoRelistLimit HomePhoneNumber MobilePhoneNumber IsHighlighted HasSuperFeature PhotoIds ShippingOptions PaymentMethods Attributes IsClearance ExternalReferenceId Contacts DonationRecipient CatalogueId PromotionId ExcludeFromShippingPromotion SKU GeographicLocation WasPrice EmbeddedContent IsBranded ShortDescription ShippingCalculatorInputs AdditionalData VariantDefinition SecondCategory PremiumPackageCode ProductSpecification ListingExtras HasGoodFor2Relists IsCounterOffersAllowed MaximumOffers ShippingTemplateId IsComingSoon Files ListingId`.split(" "));
const READ_ONLY = new Set(`Photos StartDate AvailablePaymentMethodsForEdit IsSafePaymentsCompliant RequiredMinimumReserve HasBeenExtended ListingExtrasLedger AvailablePromotions ImmutableFields RemainingGalleryPlusRelists ReturnListingDetails __type`.split(" "));

export type EditChanges = { Title?: string; Description?: string[]; PhotoIds?: number[] };

export function editRequest(current: Record<string, any>, changes: EditChanges) {
  if (!Number.isSafeInteger(current.ListingId)) throw Error("seller details have no listing ID");
  if (current.VariantDefinition || current.ListingExtras?.length) throw new Problem("this listing has variants or paid extras", "edit it on trademe.co.nz instead");
  const request: Record<string, any> = {};
  for (const [key, value] of Object.entries(current)) {
    if (EDITABLE.has(key)) request[key] = structuredClone(value);
    else if (!READ_ONLY.has(key)) throw new Problem(`Trade Me returned a field this tool doesn't know (${key}), so editing stopped to avoid resetting it`, "check whether it's safe to send back unchanged and add it to the right list in src/manage.ts, or edit this listing on trademe.co.nz");
  }
  for (const [key, value] of Object.entries(changes)) {
    if ((current.ImmutableFields ?? []).includes(key) && !same(current[key], value)) throw new Problem(`Trade Me has locked ${key} on this listing (usually because it has bids)`);
    request[key] = structuredClone(value);
  }
  request.ReturnListingDetails = true;
  return request;
}

export function changesFrom(current: Record<string, any>, wanted: { title: string; description: string; photoIds: number[] }): EditChanges {
  const changes: EditChanges = {};
  if (wanted.title.trim() !== current.Title) changes.Title = wanted.title.trim();
  if (normalizeDescription(wanted.description) !== normalizeDescription(current.Description)) changes.Description = [normalizeDescription(wanted.description)];
  if (!same(wanted.photoIds, current.PhotoIds)) changes.PhotoIds = wanted.photoIds;
  return changes;
}

// Listings made on Trade Me's newer system (platform 2) reject the classic edit call.
export async function platform(client: Client, id: number) {
  const details = await client.request(`v1/listings/${id}`);
  return details.ListingPlatform as number | undefined;
}

// Every live listing for this account, from both of Trade Me's selling systems.
export async function liveListings(client: Client) {
  const found = new Map<number, { id: number; title: string; price?: number; views?: number; watchers?: number; endsAt?: string }>();
  for (let page = 1; page <= 50; page++) {
    const result = await client.request("v1/mytrademe/sellingitems/all", undefined, { page, rows: 100 });
    for (const l of result.List ?? []) found.set(l.ListingId, { id: l.ListingId, title: l.Title, price: l.BuyNowPrice || l.StartPrice, views: l.ViewCount, endsAt: tmDate(l.EndDate) });
    if (!result.List?.length || page * 100 >= result.TotalCount) break;
  }
  let complete = true;
  try {
    for (let page = 1; page <= 50; page++) {
      const result = (await client.liveListings(page))?.yourLiveListings;
      for (const item of result?.items ?? []) {
        const card = item.contentViews?.myTradeMeListingContentCard;
        const id = Number(item.id);
        found.set(id, { ...found.get(id), id, title: card?.title ?? found.get(id)?.title, price: card?.details?.buyNowPrice ?? card?.details?.startPrice ?? found.get(id)?.price, views: item.listingStats?.viewCount, watchers: item.listingStats?.watchlistCount, endsAt: item.endDate?.slice(0, 16).replace("T", " ") });
      }
      if (!result?.items?.length || page * 25 >= result.count) break;
    }
  } catch {
    // This query's ID changes with Trade Me releases. The classic list still works,
    // but can miss listings created on trademe.co.nz itself.
    complete = false;
  }
  return { listings: [...found.values()], complete };
}

const tmDate = (value?: string) => {
  const ms = Number(value?.match(/\d+/)?.[0]);
  return ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : undefined;
};

export async function withdraw(client: Client, id: number, reason: string) {
  const fees = await client.request("v1/selling/withdrawfees", { ListingId: id, Type: 2, Reason: reason });
  if (fees.TotalCost !== 0) throw new Problem(`withdrawing would cost $${fees.TotalCost}`, "nothing was charged. withdraw it on trademe.co.nz if that's ok");
  if (await platform(client, id) === 2) {
    const result = await client.graphql("SubmitSduiWithdrawListingForm",
      "mutation SubmitSduiWithdrawListingForm($input: SduiWithdrawListingFormInput!) { submitSduiWithdrawListingForm(input: $input) { success } }",
      { input: { listingId: String(id), keyedTypedValues: [{ key: "MemberSuppliedReason", value: { strValue: reason } }] } });
    if (result.submitSduiWithdrawListingForm?.success !== true) throw new Problem("Trade Me didn't confirm the withdrawal", "run: bun tm listings, to see whether it's still live");
  } else {
    await client.request("v1/selling/withdraw", { ListingId: id, Type: 2, Reason: reason, ReturnListingDetails: true });
  }
}
