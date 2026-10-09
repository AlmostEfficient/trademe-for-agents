import { chmod, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openProfile } from "./browser";
import { Problem, SESSION_DIR, readJson, writeJson } from "./util";

// The workspace keeps its own browser profile and a copy of that profile's
// Trade Me cookies. Nothing here touches the user's everyday browser profile.
const PROFILE_DIR = resolve(SESSION_DIR, "browser-profile");
const COOKIES_PATH = resolve(SESSION_DIR, "cookies.json");
const REFRESH_URL = "https://www.trademe.co.nz/a/token-refresh";
const LOGIN_URL = "https://www.trademe.co.nz/a/login";

export type Cookie = { name: string; value: string; domain: string; path: string; expires?: number };

const isTradeMe = (domain: string) => /(^|\.)trademe\.co\.nz$/.test(domain.replace(/^\./, ""));
const now = () => Date.now() / 1000;

export function cookieHeader(cookies: Cookie[], target: string) {
  const url = new URL(target);
  if (url.protocol !== "https:" || !isTradeMe(url.hostname)) throw Error("cookies are only sent to Trade Me over https");
  return cookies.filter(cookie => {
    const host = cookie.domain.replace(/^\./, "");
    const hostMatches = url.hostname === host || url.hostname.endsWith("." + host);
    const pathMatches = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : cookie.path + "/");
    return hostMatches && pathMatches && (!cookie.expires || cookie.expires <= 0 || cookie.expires > now()) && cookie.value;
  }).sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join("; ");
}

// Apply Set-Cookie headers so rotated cookies are kept for next time.
export function mergeSetCookies(cookies: Cookie[], headers: string[], requestUrl: string) {
  const result = [...cookies];
  for (const header of headers) {
    const [pair, ...attributes] = header.split(";").map(part => part.trim());
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const cookie: Cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: new URL(requestUrl).hostname, path: "/" };
    for (const attribute of attributes) {
      const [key, value = ""] = attribute.split("=");
      const k = key.toLowerCase();
      if (k === "domain") cookie.domain = value.startsWith(".") ? value : "." + value;
      else if (k === "path") cookie.path = value || "/";
      else if (k === "max-age") cookie.expires = now() + Number(value);
      else if (k === "expires" && cookie.expires === undefined) cookie.expires = Date.parse(value) / 1000;
    }
    const index = result.findIndex(c => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
    if (index >= 0) result.splice(index, 1);
    if (!cookie.expires || cookie.expires > now()) result.push(cookie);
  }
  return result;
}

async function refresh(cookies: Cookie[]) {
  let response: Response;
  try {
    response = await fetch(REFRESH_URL, { headers: { cookie: cookieHeader(cookies, REFRESH_URL), accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Problem("could not reach trademe.co.nz", "check the internet connection, then try again");
  }
  const updated = mergeSetCookies(cookies, response.headers.getSetCookie(), REFRESH_URL);
  if (!response.ok) return { cookies: updated };
  const body = await response.json().catch(() => ({})) as { accessToken?: string };
  return { cookies: updated, accessToken: body.accessToken };
}

export async function accessToken() {
  const saved = await readJson<{ cookies: Cookie[] }>(COOKIES_PATH);
  if (!saved?.cookies?.length) throw new Problem("not logged in to Trade Me yet", "run: bun tm login");
  const result = await refresh(saved.cookies);
  await saveCookies(result.cookies);
  if (!result.accessToken) throw new Problem("the Trade Me login has expired", "run: bun tm login (if Trade Me remembers you, the window closes by itself)");
  const clientId = result.cookies.find(c => c.name === "trademeclientid")?.value ?? "";
  return { token: result.accessToken, clientId };
}

async function saveCookies(cookies: Cookie[]) {
  await writeJson(COOKIES_PATH, { savedAt: new Date().toISOString(), cookies });
  await chmod(COOKIES_PATH, 0o600).catch(() => {});
}

export async function login({ timeoutMinutes = 10 } = {}) {
  console.log("opening a browser window. log in to Trade Me there; it closes by itself once you're in.");
  const browser = await openProfile(PROFILE_DIR, LOGIN_URL);
  let closed = false;
  browser.exited?.then(() => { closed = true; });
  const deadline = Date.now() + timeoutMinutes * 60_000;
  try {
    while (Date.now() < deadline) {
      if (closed) throw new Problem("the login window was closed before logging in finished", "run: bun tm login, and leave the window open until it closes by itself");
      let raw: any[];
      try { raw = await browser.cookies(); }
      catch { throw new Problem("lost the connection to the login window", "run: bun tm login again"); }
      const cookies: Cookie[] = raw.filter(c => isTradeMe(c.domain)).map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, ...(c.expires > 0 ? { expires: c.expires } : {}) }));
      if (cookies.length) {
        const result = await refresh(cookies).catch(() => ({ cookies, accessToken: undefined }));
        if (result.accessToken) {
          await saveCookies(result.cookies);
          return;
        }
      }
      await Bun.sleep(2000);
    }
    throw new Problem(`still not logged in after ${timeoutMinutes} minutes`, "run: bun tm login again when ready");
  } finally {
    if (!closed) await browser.close();
  }
}

export async function logout() {
  await rm(SESSION_DIR, { recursive: true, force: true });
}
