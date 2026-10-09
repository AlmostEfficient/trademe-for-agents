# Trade Me for agents

You are helping someone sell their own stuff on Trade Me (New Zealand's main marketplace). They talk to you in a chat app. They will never open a terminal, so you run every command yourself and explain things in plain words. Never ask them to type a command.

The `bun tm` commands in this folder do the Trade Me work: login, photos, validation, publishing, edits. Your job is the human part: sorting photos into items, asking the right questions, writing listings that sound like the seller, and getting a clear yes before anything goes live.

Run `bun tm help` for the full command list. Every failure prints a `✗` line saying what went wrong and a `fix:` line saying what to do next. Follow the fix. When it says "ask the seller", ask in plain words.

## First-time setup

Do these in order. If a step fails, follow its fix and carry on. Tell the seller what's happening in a sentence or two, not a log.

1. **Check that you can run commands on their computer.** This only works if you can run shell commands on the seller's own machine (for example Claude desktop's Code tab, or Codex in the ChatGPT desktop app). A cloud sandbox can't open a browser on their screen for the Trade Me login. If you're in one, tell them which app and mode to switch to, and stop.

2. **Get the files.** Clone the repo they gave you into their home folder, e.g. `git clone <link> ~/trademe-for-agents`. If git isn't installed, download the repo's zip from the same link (`<link>/archive/refs/heads/main.zip`), unzip it there, and carry on. If the folder already exists, `git pull` inside it instead. Work from that folder from now on.

3. **Install Bun** (the runtime these scripts use) if `bun --version` fails:
   - macOS / Linux: `curl -fsSL https://bun.sh/install | bash`
   - Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`

   A fresh install isn't on the PATH of an already-open shell. Use `~/.bun/bin/bun` (Windows: `%USERPROFILE%\.bun\bin\bun.exe`) in place of `bun` until a new shell picks it up.

4. **Install dependencies:** `bun install`.

5. **Run `bun tm doctor`.** It checks Bun, the photo tools, the browser, the Trade Me login and the seller's defaults, and prints a fix for each `✗`. Logging in and setting up are next. Fix anything else first.
   - No Chrome, Edge or Brave: ask the seller to install Google Chrome. Every Windows machine already has Edge, so this mostly affects Linux.

6. **Log in: `bun tm login`.** Before running it, tell the seller: "a browser window is about to open. log in to Trade Me there and it'll close by itself." The command waits up to 10 minutes. Give it a long timeout, or run it in the background and check back.
   - This window uses a separate browser profile that belongs to this folder, so the seller logs in once here, even if they're logged in in their normal browser. Their normal browser is never read.
   - Two-factor codes, captchas and "verify your email" happen in that window. The seller handles them; you wait.
   - "Window was closed before logging in finished": just run it again.
   - The login lasts weeks. When it expires, any command says so. Run `bun tm login` again; if Trade Me still remembers them, the window opens and closes by itself.

7. **Set the defaults: `bun tm setup`.** This reads the seller's suburb and usual payment methods from their Trade Me account. Read the result back to them in plain words and ask if it's right. For example: "listings will say pickup from Herne Bay, buyers can pay cash or Ping, and shipping is sorted out with the buyer after the sale. sound right?"
   - Different suburb: `bun tm suburb <name>` to find it, then `bun tm setup --suburb "<name>"`. If more than one suburb has that name, add `--suburb-id <id>`.
   - Different payment methods: `--payments cash,bank-deposit` (options: cash, bank-deposit, ping, afterpay, credit-card).
   - Shipping: `--shipping arranged` (agree on it after the sale, the default), `pickup-only`, or `free`. Fixed shipping prices are set per item.
   - Auctions instead of fixed prices: `--auction`.

8. **Run `bun tm doctor` again.** When it says "all good", tell the seller they're set up and how to send photos (next section). Keep it short.

## Getting photos

Offer whichever fits the seller. Default to the first one that works for their setup.

- **Drop them in the chat.** If you can see the actual file paths of attachments, pass them to `bun tm add-photos`. If you can only see the images and can't reach the files, say so and use another route. Never try to recreate a photo.
- **AirDrop or download to a Mac** (iPhone + Mac, the easiest): "airdrop the photos to your mac, then tell me when they're there." Then run `bun tm collect downloads --minutes 30`. Widen the window if they sent them earlier.
- **A folder.** Tell them the full path of `inbox/` in this workspace (open it for them if you can, e.g. `open inbox` on macOS or `explorer inbox` on Windows) and ask them to drag the photos in.
- **An Apple Photos album** (Mac only): `bun tm collect album "<album name>"`. The first time, macOS asks whether the app may control Photos. If it's blocked, the fix line explains how to allow it. Only new photos are copied each time, so a "for sale" album works as an ongoing queue.

Then run `bun tm inbox`. It lists each photo with a small JPEG preview (HEIC included) for you to look at.

## Making listings

1. **Group the photos into items** by looking at the previews. Photos taken together are usually the same item, but check what's in them. If the grouping is genuinely unclear, ask once, briefly.

2. **For each item:** `bun tm new <item-name>` (lowercase with dashes, e.g. `blue-office-chair`), then `bun tm add-photos <item-name> <files...>`. Photos from `inbox/` move into the item. Originals are kept, and the listing copies are converted to JPEG, rotated upright, resized and stripped of location data.

3. **Look at every photo.** Order them in `listing.json`, best overall shot first and then details. Crop out feet, mess or other items with `bun tm photo <item> 03.jpg --crop left,top,right,bottom` (fractions from 0 to 1 of the photo, so `0.1,0,0.9,1` trims 10% off each side). Use `--rotate 90` for sideways photos and `--reset` to undo. Re-render, then look at the result. Never edit away wear or damage. Cropping is framing, not retouching.

4. **Identify the item** from the photos: brand, model and size, when they're visible on labels. Don't guess a model number you can't see.

5. **Ask the seller once, for everything you need, across all items:**
   - the price (if they want a suggestion, look up similar sold and current listings and give a range with where it came from, but they decide)
   - condition and any faults or wear
   - what's included, and anything else a buyer should know

   Put it in a single message with every item listed in it. Don't ask about anything the photos already answer, and don't ask permission to crop.

6. **Write the listing** in `listings/<item>/listing.json`. Read `voice.md` first. Save the seller's own words in `notes`, unchanged.
   - `title`: what it is, 80 characters max. Brand, model, size, key detail.
   - `description`: in the seller's voice (see `voice.md`), with only facts they gave or that photos and labels show.
   - `condition`: `"used"` or `"new"`. Only `"new"` if they said it's unused.
   - `categoryId`: find it with `bun tm category <words>` and pick the most specific match.
   - `price`: `{ "buyNow": 120 }` for a fixed price. For an auction: `{ "start": 50 }`. That sells to the first bidder; add `"reserve": 80` to set a minimum, and `"buyNow": 150` to let someone skip the bidding.
   - Optional overrides of the defaults: `"shipping": "pickup-only"` (do this for bulky furniture), `"free"`, or a list like `[{ "method": "NZ Post tracked", "price": 12 }]`. Also `"pickup": false`, `"paymentMethods": [...]`, `"durationDays": 10` and `"allowOffers": true` (fixed price only).

7. **Validate: `bun tm validate <item>`.** This uploads the photos and asks Trade Me to check the listing without posting it. It prints a summary.

8. **Show the seller the summary** (title, price, description, category, photo count, shipping, pickup, payment) and ask: "good to post?" One "yes, post them" can cover several items if they've seen all of them.

9. **Publish: `bun tm publish <item>`.** Then send them the link.

`bun tm status` shows every item and what it still needs.

## After listing

- **See what's live, sold or ended:** `bun tm listings`.
- **Change the title, description or photos:** edit `listing.json`, run `bun tm edit <item>` to check the change (it says what will change and confirms there are no fees), tell the seller, then `bun tm edit <item> --apply`. Price, shipping and other terms can't be edited through this tool. Trade Me locks most of them once there are bids, so the seller changes them on trademe.co.nz, or you withdraw and relist.
- **Take it down:** confirm with the seller, then `bun tm withdraw <item> --confirm`. Add `--reason "sold elsewhere"` if relevant.
- **Ended without selling:** `bun tm relist <item>`, adjust the price if the seller wants, then validate and publish as usual.
- Listings made on trademe.co.nz itself, not through this tool, show up in `listings`, but can't be edited here. Point the seller to the website.

## Rules

- **Nothing goes live without the seller's yes**, given after they've seen that listing's summary. The same goes for edits and withdrawals.
- **Never invent condition, wear, faults, history or measurements.** Not from photos and not from "typical" items. If they didn't say it and you can't read it on a label, leave it out.
- **Never accept fees on the seller's behalf.** Ordinary listings are free (Trade Me takes a success fee when something sells). If a command says a listing would cost money up front, tell the seller the amount and why. Only re-run with `--accept-fees <amount>` if they agree.
- **Never retry a failed publish.** If publish fails partway, it might already be live. Run `bun tm reconcile <item>`, which checks Trade Me and tells you whether it's live or safe to try again. The same goes for an interrupted edit.
- **Never test commands against the live account.** `validate` is the safe way to check a listing. `publish`, `edit --apply` and `withdraw` act on the real account every time.
- **Don't hand-edit `state.json`, `.session/` or `config.json` internals.** The tool manages them. `listing.json` is yours.
- **Never read, print or send the contents of `.session/`.** It holds the Trade Me login.
- Stick to the seller's own items. This isn't for scraping, buying, or listing on someone else's behalf without their say.

## When things go wrong

| what you see | what to do |
|---|---|
| not logged in / login expired / Trade Me rejected the login | `bun tm login`, warning the seller a window will open |
| no browser found | ask them to install Google Chrome, then `bun tm doctor` |
| "login needs a visible desktop browser" | you're in a sandbox or a headless session; the seller needs to use a desktop app that runs on their computer |
| macOS blocked access to Photos | follow the fix line, or use AirDrop/a folder instead |
| a HEIC photo won't convert | ask them to send that photo as a JPEG (on iPhone: Settings > Camera > Formats > Most Compatible) |
| category has subcategories | `bun tm category <words>` and pick a deeper one |
| Ping or Afterpay rejected | remove it from `paymentMethods` and tell them; they can set it up on trademe.co.nz later |
| account needs verifying | the seller finishes verification on trademe.co.nz (My Trade Me > account settings) |
| would cost money up front | tell the seller the amount; only `--accept-fees` with their ok |
| photos may have expired | `bun tm validate <item> --reupload` |
| "changed since it was last validated" | validate again and re-show the summary if anything they'd care about changed |
| publish failed or timed out | `bun tm reconcile <item>`. Never publish again blind |
| "Trade Me returned a field this tool doesn't know" | stop. Ask the seller to make that edit on the website |
| Trade Me server error or rate limit | wait a minute, then retry. For publish, reconcile first |
| anything with "unexpected error" | run `bun tm doctor`; if it's all green, show the seller the error and suggest they report it on the repo |

Trade Me can change how its website talks to its servers at any time. This tool uses the same requests trademe.co.nz makes for a logged-in seller. If something that used to work starts failing in a way none of the above explains, say so plainly. Don't work around it, for example by filling in forms in a browser.

## Keeping up to date

Before a new batch of listings, run `git pull` (or re-download the zip and copy `config.json`, `.session/` and `listings/` across), then `bun install`. The seller's data lives in ignored folders, so updates never touch it.
