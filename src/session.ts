import { resolve } from "node:path";
import { installedBrowsers, openInBrowser, profiles, readCookies, type Cookie, type Profile } from "./browser";
import { Problem, SESSION_DIR, readJson, writeJson } from "./util";

export type { Cookie };

// The seller's own browser is the login. We remember which profile works
// (never the cookies themselves) and read it fresh each time.
const SOURCE_PATH = resolve(SESSION_DIR, "source.json");
const REFRESH_URL = "https://www.trademe.co.nz/a/token-refresh";
const LOGIN_URL = "https://www.trademe.co.nz/a/login";

const isTradeMe = (domain: string) => /(^|\.)trademe\.co\.nz$/.test(domain.replace(/^\./, ""));

export function cookieHeader(cookies: Cookie[], target: string) {
  const url = new URL(target);
  if (url.protocol !== "https:" || !isTradeMe(url.hostname)) throw Error("cookies are only sent to Trade Me over https");
  return cookies.filter(cookie => {
    const host = cookie.domain.replace(/^\./, "");
    const hostMatches = url.hostname === host || url.hostname.endsWith("." + host);
    const pathMatches = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : cookie.path + "/");
    return hostMatches && pathMatches && cookie.value;
  }).sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join("; ");
}

async function refresh(cookies: Cookie[]) {
  let response: Response;
  try {
    response = await fetch(REFRESH_URL, { headers: { cookie: cookieHeader(cookies, REFRESH_URL), accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Problem("could not reach trademe.co.nz", "check the internet connection, then try again");
  }
  if (!response.ok) return undefined;
  const body = await response.json().catch(() => ({})) as { accessToken?: string };
  return body.accessToken;
}

async function tryProfile(profile: Profile) {
  const cookies = await readCookies(profile);
  if (!cookies.length) return undefined;
  const token = await refresh(cookies);
  return token ? { token, clientId: cookies.find(c => c.name === "trademeclientid")?.value ?? "", profile } : undefined;
}

// Remembered profile first, then every other profile that has Trade Me cookies.
async function findLogin() {
  const all = await profiles();
  const remembered = await readJson<{ path: string }>(SOURCE_PATH);
  const ordered = [...all.filter(p => p.path === remembered?.path), ...all.filter(p => p.path !== remembered?.path)];
  for (const profile of ordered) {
    const found = await tryProfile(profile);
    if (found) {
      if (found.profile.path !== remembered?.path) await writeJson(SOURCE_PATH, { browser: profile.browser, profile: profile.profile, path: profile.path });
      return found;
    }
  }
  return { all };
}

export async function accessToken() {
  const found = await findLogin();
  if ("token" in found) return { token: found.token!, clientId: found.clientId! };
  if (!found.all.length) throw new Problem("no Chrome, Arc, Brave or Edge found on this Mac", "install Google Chrome, then: bun tm login");
  throw new Problem("not logged in to Trade Me in any browser on this Mac", "run: bun tm login");
}

export async function login({ timeoutMinutes = 10 } = {}) {
  const first = await findLogin();
  if ("token" in first) return first.profile!;
  const browsers = await installedBrowsers();
  if (!browsers.length) throw new Problem("no Chrome, Arc, Brave or Edge found on this Mac", "install Google Chrome, then: bun tm login");
  const app = browsers.includes("Google Chrome") ? "Google Chrome" : browsers[0];
  await openInBrowser(app, LOGIN_URL);
  console.log(`opened the Trade Me login page in ${app}. waiting for the login (browsers save it within about 30 seconds)...`);
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(5000);
    const found = await findLogin();
    if ("token" in found) return found.profile!;
  }
  throw new Problem(`still not logged in after ${timeoutMinutes} minutes`, `make sure the seller logged in to Trade Me in ${app} (not Safari), then: bun tm login`);
}

export async function logout() {
  await Bun.file(SOURCE_PATH).delete().catch(() => {});
}
