# Getting started — a WCAG 2.2 AA audit from beginning to end

A step-by-step walkthrough of the whole toolkit, written so anyone on the team can run an
audit without knowing the tools beforehand. `README.md` has the technical detail for each
script; `PLAYBOOK.md` has the formal evidence procedure. This file is the practical version.

If you only remember three commands, remember these:

```bash
npm run setup                                    # once per machine
npm start                                        # asks for the site, then scans it
npm run report:findings -- --label "Baseline"    # the report
```

You do not need to edit any file or remember any option: `npm start` asks which site to
check, finds its pages itself, and asks about anything it can't decide on its own.

Everything below explains what those do and what to do in between.

---

## What each piece does (quick map)

| Step | Tool | What it verifies | Output |
|---|---|---|---|
| 1 | `axe-scan.js` + `lighthouse-scan.sh` + WAVE | The classic automatable checks (~30% of the criteria) | `audits/raw/` |
| 2 | `extra-checks.js` | What axe does NOT cover: reflow, zoom, text spacing, focus visibility, skip link, target size, cross-page consistency, reduced motion… | `audits/raw/<page>-extra.json` |
| 3 | `console-snippet.js` | The same as step 2, but pasted into the browser console — for pages behind a login or in a special state (menu open, form showing errors) | `audits/raw/<page>-snippet.json` |
| 4 | `manual-audit.js` | Everything that needs human eyes and ears (keyboard, screen reader, judgement) — it walks you through criterion by criterion | `audits/manual/manual-results.json` |
| 5 | `generate-report.js` | Merges EVERYTHING and produces the findings report | `audits/reports/findings-report.md` |
| 6 | Claude | Turns the report into a step-by-step fix guide | a document for the developers |

Steps 1 and 2 are what `npm start` runs for you, in the right order.

`COVERAGE.md` shows, criterion by criterion (all 55), which tool verifies each one.
`criteria.json` is the source of truth used by steps 4 and 5 — don't edit it unless the
scope of the standard itself changes.

---

## Setup (once per machine)

```bash
npm run setup
```

That installs the npm dependencies and the three scan browsers (Chromium, Firefox,
WebKit — about 1GB, a few minutes). It checks your Node.js version first and stops with a
clear message if anything fails, so you can re-run it safely. To do it by hand instead:

```bash
npm install
npx playwright install chromium firefox webkit
```

**The pages to scan are defined in `urls.json`** (in the toolkit root): a JSON array with
one URL per page. Every scan (axe, Lighthouse, extra-checks) reads from there — to audit a
different site you change only that list, without touching any script.

**You normally don't touch this file.** The first time you run `npm start` it asks:

```
No pages to check yet — let's find them.

Which site do you want to check? (e.g. www.example.com)
> www.your-site.com
```

From that one answer it finds the site's sitemap (via `robots.txt` or the usual paths,
following nested sitemaps), shows you the pages, and asks whether to save them. Nothing is
written until you say yes, and an existing list is backed up to `urls.json.bak` first.

**If the site has no sitemap**, that is not a dead end — it offers to find the pages by
following the site's own links instead:

```
✗ no sitemap found for https://www.your-site.com. Checked robots.txt, /sitemap.xml, …

Find the pages by following the site's links instead? [Y/n]
```

Say yes and it walks the site from the home page. It only finds pages that are actually
linked, so anything unlinked or behind a login still has to be added by hand — it tells
you that rather than letting the list look complete.

To run just that step on its own:

```bash
npm run urls:find -- https://www.your-site.com            # sitemap, then offers to crawl
npm run urls:find -- https://www.your-site.com --crawl    # go straight to following links
```

Big sites need trimming, because a sitemap is usually much larger than an audit scope:

```bash
npm run urls:find -- https://www.your-site.com --exclude='/tag/|/author/'
npm run urls:find -- https://www.your-site.com --sample --limit=25
```

`--sample` keeps one page per template (`/blog/*`, `/products/*`, …) and tells you exactly
what it left out. It's a good way to scope a first pass — but the pages left out are not
audited, so don't treat a sampled run as full coverage.

**Auditing a staging site?** Its sitemap almost certainly lists the *production*
addresses. Webflow does this: `https://your-site.webflow.io/sitemap.xml` exists, but the
addresses inside point at the live domain. You don't need to do anything about it — it
notices and asks:

```
  1) your-site.webflow.io
     the address you gave (usually the staging or test site)
  2) www.your-live-domain.com
     what the sitemap lists (usually the live site)
Choose 1-2 [1]:
```

Pick 1 and every address is rewritten onto the staging site.

If a Webflow site serves no sitemap at all, it's turned off rather than unavailable:
enable *Site settings → SEO → Sitemap → auto-generate* (paid site plan), publish, and it
appears at `/sitemap.xml`.

Or write the list by hand:

```json
[
  "https://www.example.com",
  "https://www.example.com/about",
  "https://www.example.com/contact"
]
```

`urls.example.json` shows the shape. Check that it lists EVERY page in scope: a page that
isn't in the list doesn't get audited. Two exceptions: the console snippet doesn't use
`urls.json` (you open the page yourself and paste it in), and neither does
`manual-audit.js` (it asks per criterion; you note the affected pages as you answer).

**You don't need to create any folders**: `audits/raw/`, `audits/reports/` and
`audits/manual/` are created the first time each script runs.

---

## Step 1+2 — every automated scan, one command

```bash
npm start
```

This runs, in order:

1. **axe** in Chromium, Firefox and WebKit — three engines, because a contrast or
   accessible-name bug can appear in one and not the others.
2. **Lighthouse** (Chromium only — it has no Firefox or WebKit backend). This is the slow
   part: a full Chrome launch per page, so several minutes for ~20 pages.
3. **The extra checks** — roughly 15–20 s per page, because it makes four passes per page
   including two 5 s waits to catch long animations.

It prints progress as it goes and ends with a summary saying which steps produced evidence
and which didn't. If one step fails the others still run, and the command exits non-zero
so an incomplete scan set never looks like a clean pass.

Handy variations:

```bash
npm start -- --fast                  # skip the animation waits (you lose the 2.2.2 checks)
npm start -- --browsers=chromium     # axe in one engine only, when you want a quick look
npm start -- --skip=lighthouse       # skip a step: axe | lighthouse | extra
```

Any step can also be run on its own: `npm run scan:axe`, `npm run scan:lighthouse`,
`npm run scan:extra`.

**WAVE has no script**: it's done from the browser (see the README's "WAVE scan" section),
or you can ask Claude to do it in a session with a browser extension connected. If your
process needs the PDF evidence pack, those steps (`pdf:axe`, `merge`, …) are in
`PLAYBOOK.md` and are independent of this guide.

---

## Step 3 — console snippet (browser, only if it applies)

For each page or state the crawler can't see (login, mobile menu open, a form showing
errors, a cookie banner visible):

1. Open the page in Chrome and leave it in the exact state you want audited.
2. DevTools → Console.
3. Open `console-snippet.js`, copy from the line marked "COPY FROM HERE" to the end,
   paste, and press Enter.
4. The JSON is copied to your clipboard and the console tells you the exact filename.
5. Save it in `audits/raw/` under that name (`<page>-snippet.json`).
6. If the page was in a special state, edit the `"state"` field in the JSON and describe
   it (e.g. `"mobile menu open"`) — it shows up in the report.

If the site has no login and no special states, you can skip this step.

---

## Step 4 — guided manual audit (terminal + keyboard + screen reader)

```bash
npm run audit:manual
```

- It shows you each criterion in turn, numbered `[12/54]` so you know how far along you
  are: what it means, what the automated tools already covered, and the concrete steps to
  test it by hand.
- `npm start` offers to start these for you when the scans finish, so you don't have to
  remember the command.
- You answer with one letter: `p` pass · `f` fail · `n` not applicable ·
  **`?` I can't judge this** · `s` skip for now · `q` save and quit.
- **Use `?` freely.** Plenty of these criteria need real accessibility knowledge — live
  captions, flashing content, whether alt text is actually meaningful. `?` records that a
  person looked and could not decide, and asks what blocked you. The report then lists it
  under "Needs accessibility expertise" as an open gap, with your note, so it goes to
  someone qualified instead of being guessed at as a pass. Guessing `p` is the one thing
  that makes an audit worse than not doing it.
- If you answer `f`, it asks for: affected pages, component, what's wrong, severity, and
  optionally the evidence screenshot — all of which goes straight into the report.
- **It saves after every answer.** Quit with `q` and pick it up another day: on the next
  run it only asks what's still outstanding.
- Useful: `npm run audit:manual:list` (see progress) ·
  `node manual-audit.js --criteria 1.4.3,2.1.1` (revisit specific criteria) ·
  `node manual-audit.js --all` (re-ask everything, e.g. for the retest).

For this part you need to test with the keyboard only (Tab / Shift+Tab / Enter / Esc),
browser zoom, and a screen reader (NVDA in Chrome, or VoiceOver in Safari).

This is the step that makes the audit *complete*. Automated tools cover roughly 30% of the
criteria; this is the other 70%.

---

## Step 5 — generate the findings report (terminal)

```bash
npm run report:findings -- --label "Baseline 2026-08"
```

Produces:

- `audits/reports/findings-report.md` — the report: a 55-row status table, every failure
  with page and CSS selector, and a list of what's still unverified.
- `audits/reports/findings.json` — the same as data, if you need to process it.

**How to read the statuses:**

- ❌ FAIL — a confirmed problem; it goes into the fix guide.
- ⚠️ REVIEW — a tool flagged it but it needs human confirmation.
- ✅ PASS — verified.
- 🔎 AUTO-CLEAN — the tools found nothing, but the manual check is still pending.
  **Not a pass yet.**
- 🙋 NEEDS EXPERT — someone looked and could not judge it (answered `?`). An open gap,
  listed separately with whatever note they left, ready to hand to a specialist.
- ⬜ NOT TESTED — no source touched it. The audit isn't complete while any of these remain.
- ➖ N/A — marked not applicable during the manual audit.

If AUTO-CLEAN, NEEDS EXPERT or NOT TESTED rows remain, the audit is not finished. Go back
to step 4 for the first and last; NEEDS EXPERT rows need someone with accessibility
expertise to answer them.

---

## Step 6 — the fix guide (with Claude)

1. Start a conversation with Claude and attach `findings-report.md` (and `findings.json`
   if you want more technical detail).
2. The exact prompt to paste is at the end of the report itself — it asks for a fix guide
   with before/after code, how to verify each fix, and priority and effort.
3. With the fix guide in hand: log each correction in your change log (one row per change,
   with before/after screenshots).

---

## Retest (after the fixes)

Repeat steps 1–5 with a new label:

```bash
npm start
node manual-audit.js --all          # re-answer everything for the "after" state
npm run report:findings -- --label "Retest 2026-XX"
```

Save the baseline report before regenerating (copy it under another name or to another
folder): the before/after comparison is the evidence that the fixes landed.

---

## Common problems

- **"could not launch Chromium/Firefox/WebKit"** → the browsers aren't installed:
  run `npm run setup`, or `npx playwright install chromium firefox webkit`.
- **"no sitemap found"** → say yes to the crawl it offers, or pass the sitemap URL
  directly if it lives at an unusual path. On Webflow, check that *Site settings → SEO →
  Sitemap → auto-generate* is on and the site has been published.
- **The crawl found fewer pages than you expected** → it can only follow links. Pages that
  nothing links to, or that sit behind a login, have to be added to `urls.json` by hand.
  Raise `--max-pages=<n>` if it stopped at the cap (it says so when it does).
- **"These pages are on a different address than the one you gave"** → normal for a
  staging site, whose sitemap lists the live addresses. Just answer the question: 1 for
  the address you typed, 2 for what the sitemap lists. In a script, pass
  `--host=<the address you want>` instead.
- **"Dependencies are not installed yet"** → run `npm run setup` before `npm start`.
- **A page fails with a timeout** → raise the allowance:
  `NAV_TIMEOUT=90000 npm start`.
- **`bash: command not found` on the Lighthouse step (Windows)** → run that one step from
  Git Bash or WSL: `bash lighthouse-scan.sh`.
- **The snippet doesn't copy to the clipboard** → the JSON is printed in the console;
  copy it by hand (right click → Copy string contents).
- **Contrast findings that don't reproduce when you look at the page** → the scan already
  re-measures and flags these as `measurementWarnings` in the page JSON. Check the element
  by hand; if it really is a measurement artifact, record it in `known-artifacts.json`
  with the evidence and run `npm run scan:filter`. See the README's "Measuring an animated
  page without inventing failures".
- **The report says "none found" for a source** → that step hasn't been run yet (or the
  files aren't in `audits/raw/` under the expected name). The report works with whatever
  is there, but coverage stays incomplete and the table will show it.
- **manual-audit asks about things that don't apply to the site** → answer `n` (N/A). It's
  recorded as a conscious decision, which is exactly what a serious audit requires.
