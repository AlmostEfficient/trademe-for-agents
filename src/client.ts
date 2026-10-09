import { accessToken } from "./session";
import { Problem } from "./util";

// These are the same requests trademe.co.nz makes for a signed-in seller.
// Trade Me can change them without notice; failures say so plainly.
const LIVE_LISTINGS_HASH = "c0232b78542e2437ba39eca072a48d52433e718a14cd642f1721f632d5a82a90";

export type Client = Awaited<ReturnType<typeof tradeMeClient>>;

export async function tradeMeClient() {
  const { token, clientId } = await accessToken();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-trademe-uniqueclientid": clientId,
    accept: "application/json",
    origin: "https://www.trademe.co.nz",
    referer: "https://www.trademe.co.nz/",
  };

  async function send(url: string, init: RequestInit, label: string) {
    let response: Response;
    try { response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(60000) }); }
    catch { throw new Problem(`could not reach Trade Me for ${label}`, "check the internet connection, then try again"); }
    if (response.status === 401 || response.status === 403) throw new Problem("Trade Me rejected the login", "run: bun tm login");
    if (response.status === 429) throw new Problem("Trade Me is rate limiting requests", "wait a minute, then try again");
    if (response.status >= 500) throw new Problem(`Trade Me had a server error (${response.status}) during ${label}`, "wait a minute and try again. if publishing, run bun tm reconcile first");
    const text = await response.text();
    let body: any;
    try { body = JSON.parse(text); }
    catch { throw new Problem(`Trade Me sent an unexpected reply for ${label} (${response.status}): ${text.slice(0, 200)}`); }
    return { response, body };
  }

  return {
    async request<T = any>(path: string, body?: unknown, query?: Record<string, string | number | boolean>): Promise<T> {
      if (!/^v1\/[a-z0-9/_-]+$/i.test(path)) throw Error("invalid Trade Me API path");
      const url = new URL(`https://api.trademe.co.nz/${path}.json`);
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
      const method = body === undefined ? "GET" : "POST";
      const { response, body: result } = await send(url.href, {
        method, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, path);
      if (!response.ok || result.Success === false) {
        const reason = result.ErrorDescription || result.Description || result.Message || JSON.stringify(result).slice(0, 300);
        throw new Problem(`Trade Me said: ${reason}`, hintFor(reason));
      }
      return result as T;
    },
    async graphql(operationName: string, query: string | undefined, variables: object, persistedHash?: string): Promise<any> {
      const { response, body: result } = await send("https://api.trademe.co.nz/graphql/", {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ operationName, variables, ...(query ? { query } : {}), ...(persistedHash ? { extensions: { persistedQuery: { version: 1, sha256Hash: persistedHash } } } : {}) }),
      }, operationName);
      if (!response.ok || result.errors?.length || !result.data) throw new Problem(`Trade Me ${operationName} failed: ${JSON.stringify(result.errors ?? result).slice(0, 300)}`);
      return result.data;
    },
    liveListings(page: number, pageSize = 25) {
      return this.graphql("ListUserLiveListings", undefined, { page, pageSize, filter: {} }, LIVE_LISTINGS_HASH);
    },
  };
}

// Turn Trade Me's validation messages into a next step.
const HINTS: [RegExp, string][] = [
  [/categor/i, "pick a leaf category: bun tm category <words>, then set categoryId in listing.json"],
  [/title/i, "titles must be 1-80 characters. shorten the title in listing.json"],
  [/photo|image/i, "photos may have expired on Trade Me's side. run validate again with --reupload"],
  [/ping/i, "this account can't take Ping payments yet. remove \"ping\" from paymentMethods in config.json or listing.json, or set Ping up on trademe.co.nz"],
  [/afterpay/i, "remove \"afterpay\" from paymentMethods; it needs a separate Trade Me setup"],
  [/payment/i, "check paymentMethods in listing.json or config.json"],
  [/suburb|locat/i, "find a pickup suburb with: bun tm suburb <name>, then update config.json"],
  [/address|verif|phone/i, "Trade Me needs the account verified before selling. open trademe.co.nz > My Trade Me > account settings and finish verification"],
  [/reserve/i, "the reserve must be at least the start price, and Buy Now must be above the reserve"],
  [/price/i, "check the price in listing.json"],
  [/shipping|delivery/i, "check shipping in listing.json: \"arranged\", \"free\", \"pickup-only\" or a list of {method, price}"],
  [/duration|days/i, "pick a durationDays this category allows (7 is safe for most)"],
];

export function hintFor(message: string) {
  return HINTS.find(([pattern]) => pattern.test(message))?.[1];
}
