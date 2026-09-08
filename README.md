# Accessibility Audit Toolkit

Scripts for running a full WCAG 2.2 A/AA audit against any website: an automated sweep
(axe, Lighthouse, WAVE), the automated checks those tools miss, a guided manual pass for
everything that needs human judgement, and one merged findings report at the end.

It is site-agnostic. Point `urls.json` at the pages in scope and nothing else needs
editing — no script contains a hardcoded domain, selector, or client name.

The axe pass runs in **all three Playwright engines** by default — Chromium, Firefox and
WebKit (Safari's engine) — so engine-specific accessibility differences (computed
accessible names, ARIA support, contrast rendering) show up in the evidence instead of
being hidden behind a single browser. See "Browser engines" below.

## Quick start — from zero to a findings report

Four commands, in order. You need Node.js ≥ 18 and npm installed; nothing else.

**1. Set up, once per machine:**

```bash
npm run setup
```

Installs the dependencies and the three scan browsers (~1GB, a few minutes), then tells
you what to do next. Re-running it is safe.

**2. Tell it what to scan.** Open `urls.json` and list every page in scope. It ships
empty — nothing runs until you fill it. Copy the shape from `urls.example.json`:

```json
[
  "https://www.example.com",
  "https://www.example.com/about",
  "https://www.example.com/contact"
]
```

**3. Run every automated scan with one command:**

```bash
npm start
```

That runs all three automated passes in order — axe-core in Chromium, Firefox and WebKit,
then Lighthouse, then the extra checks axe misses (reflow, zoom, focus, target size…) —
prints progress as it goes, and ends with a summary of what produced evidence and what
didn't. The `audits/` folders are created for you. Useful variations:

```bash
npm start -- --fast                  # skip the ~10s/page animation waits
npm start -- --browsers=chromium     # narrow the axe pass to one engine
npm start -- --skip=lighthouse       # skip a step (axe | lighthouse | extra)
```

Each pass can still be run on its own — see "Running each tool" below.

*Optional, for what crawlers can't reach:* for logged-in pages or special states (open
menu, form errors), paste `console-snippet.js` into DevTools on that page and save the
JSON it copies into `audits/raw/` — the file header has the exact steps.

**4. Answer the human-judgement checks** (keyboard, screen reader, judgement calls —
resumable, saves after every answer):

```bash
npm run audit:manual
```

**5. Build the findings report:**

```bash
npm run report:findings -- --label "Baseline"
```

Open `audits/reports/findings-report.md`: a status for all 55 WCAG 2.2 A/AA criteria,
every failure with page + CSS selector, and — at the end — a ready-made prompt for
turning it into a step-by-step fix guide with Claude.

That's the whole loop. `GETTING-STARTED.md` walks the same path in more practical detail,
`COVERAGE.md` shows which tool verifies which criterion, and the WAVE pass and PDF
evidence flow (below) are part of the formal evidence-pack process in `PLAYBOOK.md` —
not required just to find and fix issues.

## Folder layout

```
a11y-audit-toolkit/
  setup.js                   `npm run setup` — installs dependencies + the three browsers
  run-scans.js               `npm start` — runs axe + Lighthouse + extra checks in one go
  urls.json                  Pages to scan (ships empty)
  urls.example.json          The shape urls.json expects
  criteria.json              All 55 WCAG 2.2 A/AA criteria — the single source of truth
  known-artifacts.json       Per-project verified measurement artifacts (ships empty)
  browsers.js                Shared engine selection/launch helpers (Chromium, Firefox, WebKit)
  axe-scan.js                axe-core against every URL in every selected engine -> audits/raw/<page>-axe-<engine>.json
  extra-checks.js            The automated checks axe misses -> audits/raw/<page>-extra.json
  console-snippet.js         Paste-into-DevTools version, for states a crawler can't reach
  manual-audit.js            Interactive CLI for everything needing human judgement
  generate-report.js         Merges every source -> audits/reports/findings-report.md
  filter-known-artifacts.js  Sets aside verified measurement artifacts, auditably
  axe-to-pdf.js              axe JSON -> audits/raw/<page>-axe-<engine>.pdf
  lighthouse-scan.sh         Lighthouse (accessibility category) -> audits/raw/<page>-lighthouse.report.{html,json}
  lighthouse-to-pdf.js       Lighthouse HTML report -> audits/raw/<page>-lighthouse.pdf
  wave-to-pdf.js             WAVE JSON -> audits/raw/<page>-wave.pdf (see "WAVE scan"; there's no wave-scan.js)
  merge-pdfs.js              Every engine's axe PDF + Lighthouse + WAVE per page -> audits/reports/<page>-full-report.pdf
  combine-report.js          audits/reports/combined-summary.{json,csv} and browser-comparison.csv
  audits/
    raw/                     Per-tool exports, one set per page
    reports/                 Merged PDFs and the findings report
    manual/                  Manual-audit answers (resumable)
```

## Requirements

- Node.js ≥ 18 and npm. `npm run setup` handles everything below; the detail is here for
  anyone who wants to do it by hand or debug a failed setup.
- Dependencies: the `devDependencies` in `package.json` (`@axe-core/playwright`,
  `lighthouse`, `pdf-lib`, `playwright`), installed by `npm install`.
- Browser binaries, installed once: `npx playwright install chromium firefox webkit`
  (or `npm run install:browsers`). Chromium alone is enough only if you also restrict
  the scan to Chromium.
- All of these must run from a real terminal on a machine with internet access and the
  Playwright browsers installed — they will not run inside a sandboxed environment that
  lacks network access or a browser binary.

## Browser engines

`axe-scan.js` scans every URL in every selected engine. Selection, in order of precedence:

```
node axe-scan.js                                  # default: chromium, firefox, webkit
node axe-scan.js --browsers=firefox,webkit        # subset
node axe-scan.js --browsers firefox webkit        # same, space-separated
node axe-scan.js --browsers=safari                # aliases: chrome, safari, ff, gecko, edge, wk
node axe-scan.js --all                            # explicit "all three"
BROWSERS=firefox,webkit node axe-scan.js          # env var (used when no flag is passed)
```

Or via npm: `npm run scan:axe`, `scan:axe:chromium`, `scan:axe:firefox`, `scan:axe:webkit`.

Things worth knowing:

- **WebKit is Safari's engine, not Safari.** Playwright's `webkit` build is the same core
  Safari ships, but without Safari's UI layer or VoiceOver integration. It catches
  WebKit-specific accessibility-tree and CSS differences; it does not replace a manual
  VoiceOver/Safari pass.
- **Lighthouse stays Chrome-only.** `lighthouse-scan.sh` drives headless Chrome directly —
  Lighthouse has no Firefox or WebKit backend, so its score is a Chromium-only figure.
  That's why `combined-summary.csv` repeats the same Lighthouse score on each engine's row.
- **PDF rendering is always Chromium.** Playwright's `page.pdf()` is unsupported in Firefox
  and WebKit, so `axe-to-pdf.js`, `lighthouse-to-pdf.js` and `wave-to-pdf.js` render in
  Chromium regardless of which engines did the scanning. Chromium therefore has to be
  installed even for a Firefox/WebKit-only audit.
- **A missing engine is a failed run, not a silent skip.** If a requested engine isn't
  installed, `axe-scan.js` warns, scans the engines it does have, prints the
  `npx playwright install` line needed, and exits non-zero — so a partial pass can't
  quietly become the baseline.
- **Firefox and WebKit hang on `networkidle`** for sites with long-lived connections, so
  navigation falls back to `waitUntil: 'load'` after a timeout (45s, override with
  `NAV_TIMEOUT`). The fallback is logged per page.

## Measuring an animated page without inventing failures

Sites that reveal content with scroll-driven animation (GSAP/ScrollTrigger, Framer Motion,
AOS, IntersectionObserver fades) can be measured mid-fade, and axe then reports the blended
colour as a contrast failure — a different set of findings on every run. `axe-scan.js`
handles this by *observing* rather than *overriding*:

- It walks the full page so scroll-triggered reveals fire, returns to the top, and waits
  for them to finish on their own (`SETTLE_MS`, default 2500).
- It waits for the attributes on `<html>` and `<body>` to stop changing, because many
  sites paint their header from a `data-theme`-style attribute their own script sets after
  load. Measuring inside that window is how axe ends up reporting dark text on a dark
  background — a state lasting milliseconds that no visitor sees at rest. Override the
  attributes reported in the summary with `THEME_ATTRS=data-theme,data-mode`.
- For every contrast violation it compares the colour axe reported against the element's
  live computed style. When they disagree, it reloads and re-measures once: **a real
  failure reproduces, a measurement race doesn't.** Anything still disagreeing after the
  retry is written to `measurementWarnings` in the page JSON for a human to check — it is
  never silently dropped.
- It counts elements whose opacity is *still changing* at measurement time and reports
  them per page, so you can tell a settled scan from a rushed one.

What it deliberately does **not** do, because each of these manufactures failures:
inject `animation-duration: 0s`, jump GSAP timelines to their end state, force
`opacity: 1` on everything, or set `reducedMotion: 'reduce'` (some sites branch on that
query, which changes the behaviour being measured instead of observing it).

If a page still reports a contrast artifact you have verified by hand, record it in
`known-artifacts.json` with the evidence and run `npm run scan:filter` — matched nodes
move into a `knownArtifacts` block in the same JSON rather than disappearing.

## Naming convention

axe files carry the engine: `<page>-axe-<engine>.<ext>`, e.g. `about-axe-firefox.json` /
`about-axe-webkit.pdf`. Lighthouse and WAVE files keep `<page>-<tool>.<ext>` since they
only ever run in one engine. Files from an older single-browser run (`<page>-axe.json`,
with no engine suffix) are still read and treated as Chromium, so existing `audits/raw/`
contents don't need renaming.

Otherwise every file is named `<page>-<tool>.<ext>`, where `<page>` is the URL with the
protocol and domain stripped, slashes turned into underscores, and the site root named
`homepage`. Example: `https://www.example.com/about` → `about`.

Final merged reports (after the rename step) follow:
`<page>_<before|after>_<YYYY-MM-DD>.pdf` — e.g. `about_before_2026-07-27.pdf`. The date is
the baseline date (or the retest date), not necessarily the date the script physically ran.

## Running each tool

**axe** (all engines by default — see "Browser engines" for narrowing it):
```
node axe-scan.js       # writes audits/raw/<page>-axe-<engine>.json + audits/reports/axe-summary.json
node axe-to-pdf.js     # writes audits/raw/<page>-axe-<engine>.pdf (rendered in Chromium)
```
`axe-summary.json` has one row per page *per engine*, with `browser`, `browserVersion`,
the measurement diagnostics described above, and an `error` field for any page that failed
to scan.

**Lighthouse:**
```
bash lighthouse-scan.sh    # writes audits/raw/<page>-lighthouse.report.{html,json}
node lighthouse-to-pdf.js  # writes audits/raw/<page>-lighthouse.pdf
```
Note: `lighthouse-scan.sh` uses `sed -E 's|https?://||; ...'` to strip the protocol from
URLs when building filenames. This must stay `-E` (extended regex) with no backslash
before the `?` — on macOS's default BSD `sed`, `\?` is not a quantifier and silently fails
to match, which breaks the filename match-up with axe's output and makes `merge-pdfs.js`
skip every page.

**WAVE** (no script — see "WAVE scan" below for why):
```
node wave-to-pdf.js     # converts existing audits/raw/<page>-wave.json -> <page>-wave.pdf
```

**Merge:**
```
node merge-pdfs.js      # writes audits/reports/<page>-full-report.pdf
```
One merged PDF per page, containing each engine's axe report in order (Chromium, Firefox,
WebKit), then Lighthouse, then WAVE. Requires at least one axe PDF and a Lighthouse PDF
for the page — pages with no Lighthouse PDF are skipped with a console note, as is a
missing WAVE PDF (merge continues without it).

**Combined summary:**
```
node combine-report.js  # writes combined-summary.{json,csv} + browser-comparison.csv
```
`combined-summary.csv` is long format (one row per page per engine, with a `Browser`
column); `browser-comparison.csv` is one row per page with a violation-count column per
engine, which is the quicker way to spot an issue that only reproduces in Firefox or WebKit.

## WAVE scan

WAVE's free web tool (`wave.webaim.org`) is a JavaScript single-page app with no official
free API, so there's no reusable `wave-scan.js`. Producing `audits/raw/<page>-wave.json`
for a set of URLs means, for each URL:

1. Navigate to `https://wave.webaim.org/report#/<full URL>` (this deep-link format works
   directly — no need to type into the form each time).
2. Wait for the report to fully load (the SPA doesn't repaint instantly on hash change —
   allow 8–9 seconds, and confirm `location.href` matches the target URL before reading
   data, since a too-short wait can return the previous page's stale numbers).
3. Read `window.wave.report.things.iconList` in the page's JS context — each entry has
   `.data.category`, `.data.title`, `.data.summary`. Group by `category|title` and count
   occurrences; `window.wave.report.aim` is the AIM score.
4. Write `{ url, aimScore, totalItems, categories: [{category, title, summary, count}, …] }`
   to `audits/raw/<page>-wave.json`.

One caveat found in practice: dumping the full category+title+summary+count structure in a
single `JSON.stringify` call sometimes trips a "cookie/query-string data" safety filter in
browser-automation JS tools, even though there's nothing sensitive in it — a false positive
on the repeated key/value shape. Splitting the extraction into a small "counts" call and a
separate "descriptions" call for any newly-seen issue type avoids it. Since WAVE's rule
descriptions are fixed boilerplate (not per-page), you only need to fetch a description
once per unique category/title, not once per page.

## Evidence pack

`PLAYBOOK.md` covers the formal evidence process end to end: what to run, in what order,
how to name the merged PDFs, and how to file them so a baseline and a retest can be
compared. There's no automated upload step — where the reports end up (shared drive,
ticket attachment, repo) is a project decision, so the last step is a deliberate manual one.

## Full-criteria verification layer

Automated scans (axe + Lighthouse + WAVE) only cover roughly 30% of the 55 WCAG 2.2 A/AA
criteria. Four more pieces close the rest of the gap and end in a single findings report:

```
criteria.json          All 55 criteria: what each means, which tool verifies it, manual test
                       steps. Single source of truth for manual-audit.js and generate-report.js.
extra-checks.js        Automated checks axe misses: reflow @320px (1.4.10), 200%-zoom overflow +
                       zoom-blocking viewport meta (1.4.4), text spacing (1.4.12), focus visible
                       (2.4.7), focus not obscured (2.4.11), skip link (2.4.1), target size (2.5.8),
                       heading/landmark structure (1.3.1), autocomplete (1.3.5), placeholder-only
                       labels (3.3.2), positive tabindex (2.4.3), lang (3.1.1), autoplay media
                       (1.4.2), reduced motion / long animations (2.2.2), plus site-level checks:
                       duplicate titles (2.4.2), consistent nav (3.2.3), consistent help (3.2.6).
                       -> audits/raw/<page>-extra.json + audits/reports/extra-summary.json
console-snippet.js     The same style of checks as a paste-into-DevTools snippet, for pages or
                       states the crawler can't reach (logged-in, menu open, form in error state).
                       Also inventories images/media/live regions for the manual pass.
                       -> save output as audits/raw/<page>-snippet.json
manual-audit.js        Interactive CLI for everything that needs human judgement. Shows what to
                       test and how, records pass/fail/N-A (+ pages, component, severity, evidence),
                       resumable, one answer per criterion. -> audits/manual/manual-results.json
generate-report.js     Merges axe + extra + snippet + manual (+ Lighthouse scores) into
                       audits/reports/findings-report.md and findings.json — grouped by criterion,
                       with a 55-row status table that refuses to mark anything "pass" on
                       automation alone, and a coverage-gap list so an incomplete audit is visible.
COVERAGE.md            The per-criterion map of which tool verifies what.
```

npm scripts: `setup`, `start`, `scan:extra`, `scan:extra:fast`, `scan:filter`,
`audit:manual`, `audit:manual:list`, `report:findings`.

`extra-checks.js` is Chromium-only by design (layout probes + tab-order simulation);
engine-specific accessibility-tree differences are already covered by the multi-engine axe
pass. `--fast` skips the two ~5s animation waits per page.

**Order for a full pass:** `npm start` (axe + Lighthouse + extra) → WAVE → snippet on any
unreachable states → `npm run audit:manual` → `npm run report:findings`. The end of
`findings-report.md` contains the prompt for turning it into a developer fix guide with Claude.
