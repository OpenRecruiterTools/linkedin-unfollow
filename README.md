# LinkedIn Unfollow

**Tired of the AI slop in your LinkedIn feed? Unfollow everyone in one click.**

Unfollow everyone in your LinkedIn feed, at human pace, in your own browser.
Free, open source, no account, no server, no telemetry.

You stay connected to everyone — unfollowing is not disconnecting. You just stop
seeing their posts, and your feed goes quiet.

[**Download for Chrome →**](https://github.com/OpenRecruiterTools/linkedin-unfollow/releases/latest/download/linkedin-unfollow.zip)

---

## Install it

Four steps, about two minutes. It is not on the Chrome Web Store — [see why](#why-it-is-not-in-the-chrome-web-store).

### 1. Download the zip

Take `linkedin-unfollow.zip` from the
[latest release](https://github.com/OpenRecruiterTools/linkedin-unfollow/releases/latest),
then unzip it **somewhere you will keep it**. Chrome loads the extension from
that folder every time it starts, so do not leave it in Downloads and then empty
Downloads.

![Downloading the zip from the releases page](docs/assets/install-1-release.png)

### 2. Open `chrome://extensions` and turn on Developer mode

Type the address in by hand — it will not come up in search results. The switch
is in the top-right corner.

![Chrome's extensions page with Developer mode on](docs/assets/install-2-extensions.png)

### 3. Click "Load unpacked" and pick the folder

Pick the folder *itself*, the one holding `manifest.json` — not a file inside it.

![The loaded extension card](docs/assets/install-3-loaded.png)

### 4. Pin the icon, sign in to LinkedIn, and click it

Click the jigsaw-piece icon, find LinkedIn Unfollow, click the pin. Then go to
[linkedin.com](https://www.linkedin.com/), sign in as normal, and click the icon.

![The popup, open](docs/assets/install-5-popup.png)

---

## Use it

Three buttons and a number box. Work through them in order; do not skip to the
third one.

1. **Check count** — how many accounts you follow, and the first few names.
   Changes nothing.
2. **Preview** — the list of people it *would* unfollow, read by exactly the same
   call. Sends no unfollow at all.
3. **Unfollow** — set "Unfollow up to" to **1** first. Run it. Check that person
   really is unfollowed on LinkedIn. *Then* set it to 25, or 500, or clear the
   box to work through everyone.

While it runs there is a progress line and a **Stop** button. Stop ends the run
after the person it is on.

---

## How it works

It makes the same two requests linkedin.com's own "Following" page makes, from
your own signed-in browser:

| | |
|---|---|
| **List** | `GET /voyager/api/graphql?…MYNETWORK_CURATION_HUB…PEOPLE_FOLLOW…` — the total comes straight from LinkedIn's `totalResultCount`, so "you follow 735 people" is the real number, not a count of rows on screen. |
| **Unfollow** | `POST /voyager/api/feed/dash/followingStates/urn:li:fsd_followingState:urn:li:fsd_profile:<id>` with `{"patch":{"$set":{"following":false}}}` — one person, one request. |

Around those two calls:

- **Paced like a human.** One person every 0.8–1.6 seconds, randomised, one
  request at a time. Never a burst.
- **Stops on any LinkedIn challenge.** 429, 451, 401 and 403 end the run on the
  spot, and so do two non-200s in a row. Nothing is ever retried.
- **You can stop it.** Stop takes effect after the person it is on, so you are
  never left wondering whether the last one landed.
- **Never more than you asked for.** The limit is enforced in the engine, and one
  run will not do more than 5,000 whatever you type.
- **Nothing leaves your browser.** No account, no server, no analytics, no
  telemetry, no third-party requests of any kind. The only host it talks to is
  `www.linkedin.com`, with your own cookies. Read `src/` — it is about 1,800 lines
  and there is no build step, so what you install is what you can read.
- **Nothing is bypassed.** The CSRF token is your own `JSESSIONID` cookie, read
  through Chrome's `cookies` API. No security measure is defeated, worked around
  or forged; if you are not signed in, it simply fails.

If LinkedIn rotates the hashed query id the list call depends on, there is a
second engine that clicks the Following page instead, exactly as a person would.
See [docs/fallback.md](docs/fallback.md).

---

## FAQ

**Is this against LinkedIn's terms?**
Yes — automating your account is. LinkedIn's User Agreement prohibits using
"bots or other automated methods" to access the service, and LinkedIn restricts
and permanently bans accounts for it. This tool does not pretend otherwise. Use
it on your own account, with your eyes open, or do not use it.

**Does it bypass any security measure?**
No. It sends the requests the page itself sends, signed with your own session
cookie, at a fraction of the rate a person clicking could manage. It does not
defeat rate limits, solve challenges, rotate identities, or touch anyone else's
account — and when LinkedIn puts up a challenge it stops rather than working
around it.

**Will I lose my connections?**
No. Unfollowing is not disconnecting. Your connections stay connections; you
just stop seeing their posts. You can follow anyone again by hand.

**Can I undo it?**
No. Not in bulk. Unfollowing 800 people would have to be reversed 800 times by
hand. This is why "Preview" and a limit of 1 exist — use them.

**How long does 800 people take?**
Roughly fifteen minutes. The popup can be closed while it runs.

**Does it work on Edge, Brave, Arc?**
It is a standard MV3 extension, so any Chromium browser that can load an unpacked
extension should run it. Only Chrome is tested.

**Do you see any of my data?**
No. There is nothing to see it with: no account, no backend, no analytics.

---

## Disclaimer

**Read this before you install it.**

Automating your LinkedIn account may breach LinkedIn's User Agreement. LinkedIn
detects automation and restricts, suspends and permanently bans accounts for it,
including accounts that have done nothing else wrong. **That risk is entirely
yours.** The pacing and the stop conditions in this extension reduce it; nothing
removes it.

This software is provided as is, without warranty of any kind. The author is not
responsible for any restriction, suspension or loss of your LinkedIn account, for
any people you unfollow and cannot get back, or for any other consequence of
running it. It performs an irreversible bulk action on your own account: preview
first, try one, and never run it against an account you cannot afford to lose.

It is for your own account only. Do not use it on an account you do not own or
have not been asked to operate.

---

## Why it is not in the Chrome Web Store

Store policy forbids extensions that facilitate breaking another site's terms of
service, and an honest reading of LinkedIn's terms puts automating your own
account in that territory. Loading it unpacked keeps the decision — and the code
you are running, which you can read — with you.

---

## Development

```bash
npm install
npm test      # vitest, with an in-memory chrome mock — nothing touches LinkedIn
npm run lint  # eslint
npm run zip   # dist/linkedin-unfollow-v1.0.0.zip
```

There is no build step. `src/` is what ships.

| Path | What it is |
|---|---|
| `src/linkedin.js` | The two API calls, and the parser for the list response. |
| `src/background.js` | The engine: pacing, limits, stop conditions, message router. |
| `src/dom-fallback.js` | The click-the-page engine, kept for when the query id rotates. |
| `src/popup/` | The one screen. |
| `tests/` | 79 tests. Every fixture is invented; no real person appears in them. |

---

## Credits

Built by [Dominic Gonsalves](https://www.linkedin.com/in/dominic-g-6a9a5680/),
founder of [Formatix AI](https://formatix.ai) —
GitHub [@FormatixAI](https://github.com/FormatixAI).

Want search export, saved lists, an AI copilot and 30-odd other things on
LinkedIn? That is the bigger project this was carved out of:
[**LinkedIn Toolkit**](https://github.com/OpenRecruiterTools/linkedin-toolkit).

MIT licensed. See [LICENSE](LICENSE).
