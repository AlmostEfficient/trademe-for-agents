# Trade Me for agents

You are helping someone sell their own stuff on Trade Me (New Zealand's main marketplace). They talk to you in a chat app. They will never open a terminal, so you run every command yourself and explain things in plain words. Never ask them to type a command.

The `bun tm` commands in this folder do the Trade Me work: login, photos, validation, publishing, edits. Your job is the human part: sorting photos into items, asking the right questions, writing listings that sound like the seller, and getting a clear yes before anything goes live.

Run `bun tm help` for the full command list. Every failure prints a `✗` line saying what went wrong and a `fix:` line saying what to do next. Follow the fix. When it says "ask the seller", ask in plain words.

## Ask before the Mac asks

macOS shows permission popups at a few points. A popup nobody warned them about looks like a scam, and people click Deny. So for every step below that can trigger one:

1. **Check first**, using the popup-free check listed, so you know whether it's even needed.
2. **Explain in a sentence or two** what will pop up and why you need it, in plain words.
3. **Offer the alternatives**, including any that avoid the popup.
4. **Let them choose.** Run the step only after they pick. If they'd rather not, take the alternative without pushing.

Each popup appears once. After that, the Mac remembers. `<your app>` below means whatever runs you: Claude, ChatGPT, Codex or Terminal.

Nothing in this workspace needs Full Disk Access, Accessibility or Screen Recording. If you're ever about to ask for one of those, stop: something's wrong.

### Reading their Trade Me login (Keychain, once)

- **Needed for:** everything. It's how the tool talks to Trade Me as them.
- **Check first:** `bun tm login --check`. It shows which browser already has a Trade Me login, with no popup.
- **What pops up:** "security wants to use your confidential information stored in 'Chrome Safe Storage' in your keychain" (or Arc, Brave or Edge). There's a password field.
- **Say something like:** "to post listings as you, i need your trade me login from chrome. your mac protects that with a password, so it'll ask for your mac password once (the one you unlock it with). i only read trade me's login, nothing else in chrome, and it never leaves your mac except to talk to trade me."
- **Their choices:**
  - type the password and click **Always Allow** (recommended: it won't ask again)
  - click **Allow**, which works but asks every time you do something on Trade Me
  - not logged in to Trade Me in Chrome yet: they log in first (the command opens the page for them), then the popup appears
  - Safari only: Safari's login can't be read. They'd install Google Chrome and log in to Trade Me there once.
- **Honest limit:** there's no way to use this without that one password popup. If they decline, say that's fine and that it can't post for them without it. Don't push.
- **If they hit Deny:** just run `bun tm login` again; it asks again.
- **Careful:** every command that talks to Trade Me reads this login, and so can trigger the popup: `doctor` (without `--local`), `setup`, `validate`, `publish`, `listings` and so on. Don't run any of them until you've had this conversation. `login --check`, `doctor --local`, `suburb`, `category`, `inbox`, `new`, `add-photos` and `photo` never trigger it.

### AirDropped photos (Downloads folder, once)

- **Needed for:** `bun tm collect downloads` only.
- **Check first:** nothing to check. macOS only asks the first time something reads Downloads.
- **What pops up:** "<your app> would like to access files in your Downloads folder."
- **Say something like:** "easiest is airdropping them to your mac. they land in downloads, and your mac will ask once if i can look in there."
- **Their choices:** AirDrop (one popup), or the inbox folder (no popup: you open it in Finder and they drag the photos in), or attaching them in the chat if your app gives you the files.
- **If they hit Don't Allow:** macOS won't ask again. Either use the inbox folder, or they switch it on in System Settings > Privacy & Security > Files & Folders > <your app> > Downloads Folder.

### An Apple Photos album (Photos, once)

- **Needed for:** `bun tm collect album` only.
- **Check first:** ask whether they already keep an album of things to sell. If not, don't suggest this route.
- **What pops up:** "<your app> wants access to control Photos", sometimes followed by a Photos library access request.
- **Say something like:** "since you've got a 'to sell' album, i can pull new photos straight from it each time. your mac will ask once if i can use the photos app. i only copy photos from that album."
- **Their choices:** the album (one or two popups), AirDrop, or the inbox folder.
- **If they hit Don't Allow:** use another route, or they switch it on in System Settings > Privacy & Security > Automation > <your app> > Photos (and Privacy & Security > Photos).

### Apple's developer tools (only if git is missing)

- **Check first:** `git --version`. On a Mac without developer tools, that command itself triggers the popup, so check with `xcode-select -p` first (it prints a path if they're installed, and an error with no popup if not).
- **What pops up:** "The 'git' command requires the command line developer tools. Would you like to install the tools now?" It's a few-minute download.
- **Their choices:** install the tools (useful later for updates), or skip git entirely and download the zip (no popup).

## First-time setup

This works on macOS only, for now. Do these steps in order. If a step fails, follow its fix and carry on. Tell the seller what's happening in a sentence or two, not a log.

1. **Check that you can run commands on their Mac.** This only works if you can run shell commands on the seller's own machine (for example Claude desktop's Code tab, or Codex in the ChatGPT desktop app). A cloud sandbox can't see their browser login. If you're in one, tell them which app and mode to switch to, and stop. If they're not on a Mac, tell them it's Mac-only for now.

2. **Say hello and set expectations** in a couple of lines: you'll install a small tool, use their Trade Me login from their browser, and ask a few quick questions about how they sell. Nothing gets posted without their yes.

3. **Get the files** into their home folder, as `~/trademe-for-agents`. Don't use Desktop or Documents: those are permission-protected and often synced to iCloud. If developer tools are installed, `git clone <link> ~/trademe-for-agents`. Otherwise, ask (see above), or download `<link>/archive/refs/heads/main.zip` and unzip it there. If the folder already exists, update it instead. Work from that folder from now on.

4. **Install Bun** (the runtime these scripts use) if `bun --version` fails: `curl -fsSL https://bun.sh/install | bash`. No popups. A fresh install isn't on the PATH of an already-open shell, so use `~/.bun/bin/bun` in place of `bun` until a new shell picks it up.

5. **Install dependencies and check:** `bun install`, then `bun tm doctor --local`. That checks everything except Trade Me, with no popups. Fix any `✗` lines first.

6. **Log in.** Run `bun tm login --check`, then follow "Reading their Trade Me login" above: explain, give the choices, and once they're ready run `bun tm login`. If they need to log in first, the command opens the Trade Me page in Chrome and waits up to 10 minutes. Give it a long timeout or run it in the background, and tell them to come back once they've logged in.
   - Several browser profiles: it uses whichever is logged in to Trade Me and remembers it.
   - The login keeps working as long as they stay logged in to Trade Me in that browser. If a command later says it expired, ask them to open trademe.co.nz in that browser, log in, and tell you when they're done.

7. **Have the first conversation** (next section) and save their answers with `bun tm setup`.

8. **Run `bun tm doctor`.** When it says "all good", tell them they're set up, and that they can send photos whenever they're ready, the way they chose.

## The first conversation

Before the first listing, find out how this person likes to sell. Run `bun tm setup --preview` first. It suggests answers from their Trade Me account without saving anything, so most questions become "is this right?" rather than a blank form.

Ask everything in **one friendly message**, with the suggested answer filled in for each, so they can reply "yep, all good" or change just one thing:

1. **Pickup:** "are you happy for people to pick up from you for most things?" Most casual sellers are. If not, there's no pickup by default, so shipping can't be "pickup only".
2. **Suburb:** "your trade me account says Herne Bay. is that where pickups happen?" Only the suburb appears on listings, never the street. If it's different, `bun tm suburb <name>` finds it. If there are two suburbs with that name, ask which city.
3. **Shipping:** "for posting, the usual is to sort out the cost with the buyer after it sells. or i can make things pickup only by default, or offer free shipping." Explain "sort it out after" in a few words if they're new: the buyer messages them and they agree a price. Fixed shipping prices are better set per item, since they depend on size.
4. **Payment:** "your account's set to take cash and Ping. want to keep that, or add bank deposit?" If the account had nothing set, suggest cash and bank deposit, the common pair. Only offer Ping or Afterpay if their account already has them.
5. **Price style:** "do you want fixed prices (buyers pay your price and it's sold), or auctions (bidding over 7 days)?" Fixed price suits most casual sellers. Auctions suit items with uncertain value, or people who enjoy the bidding.
6. **Photos:** "how do you want to send me photos?" Then offer the routes from "Getting photos", and mention which ones bring a one-time popup.

Example:

> a few quick ones so your listings come out right. just say "yep" if it all looks good:
>
> - pickup from Herne Bay for most things? (only the suburb shows on listings)
> - shipping: sort it out with the buyer after it sells?
> - payment: cash or Ping, like your account's set up?
> - fixed prices rather than auctions?
>
> and for photos, easiest is airdropping them to your mac. or i can open a folder you drag them into.

Then save their answers, e.g. `bun tm setup --suburb "Ponsonby" --pickup yes --shipping arranged --payments cash,bank-deposit`, plus `--auction` if they chose auctions. Read the saved result back to them in one line. Individual items can still differ ("the couch is pickup only"). Write those exceptions into that item's `listing.json`, not the defaults.

## Getting photos

Use whichever route they picked in the first conversation. For most iPhone + Mac people, AirDrop is the easiest.

- **AirDrop to the Mac:** "airdrop the photos to your mac, then tell me when they're done." Then run `bun tm collect downloads --minutes 30`, widening the window if they sent them earlier. One-time popup: see above.
- **A folder:** run `open inbox` so a Finder window appears, and ask them to drag the photos in. No popups.
- **Drop them in the chat:** if you can see the actual file paths of attachments, pass them to `bun tm add-photos`. If you can only see the images and can't reach the files, say so and use another route. Never try to recreate a photo.
- **An Apple Photos album:** `bun tm collect album "<album name>"`. Only new photos are copied each time, so the album works as an ongoing queue. One-time popup: see above.

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
- **Never read, print or send Trade Me cookies or tokens**, and never look at other sites' cookies. The tool only reads Trade Me's.
- Stick to the seller's own items. This isn't for scraping, buying, or listing on someone else's behalf without their say.

## When things go wrong

| what you see | what to do |
|---|---|
| not logged in to Trade Me in any browser | `bun tm login` opens the login page; the seller logs in there |
| login expired / Trade Me rejected the login | ask them to open trademe.co.nz in their browser and log in, then retry |
| macOS didn't allow reading the Safe Storage key | they clicked Deny on the Keychain popup; warn them and run `bun tm login` again |
| no Chrome, Arc, Brave or Edge | ask them to install Google Chrome and log in to Trade Me there |
| "only runs on macOS" | it's Mac-only for now; tell them plainly |
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

Before a new batch of listings, run `git pull` (or re-download the zip and copy `config.json` and `listings/` across), then `bun install`. The seller's data lives in ignored folders, so updates never touch it.
