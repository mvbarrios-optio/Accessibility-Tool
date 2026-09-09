# Accessibility Audit Playbook

How to run a full baseline (or retest) pass with this toolkit, end to end, and produce a
formal evidence pack. Run it once at the start for the "before" evidence, and again after
the fixes for the "after" evidence.

If you just want to find and fix issues, `GETTING-STARTED.md` is the shorter path — the
PDF and evidence-pack steps here exist for audits that have to be *filed*, not just acted on.

Each numbered step names who or what runs it: **(you, terminal)** for steps needing a real
terminal with network access and the Playwright browsers installed, **(you, browser)** for
steps done by hand in a browser, or **(Claude)** for steps that can be delegated to an
agent session with browser access.

## 0. Before you start

- Confirm `urls.json` lists every page in scope. If the page inventory changed, update
  this file first — everything downstream keys off it. To rebuild it from the site's
  sitemap: `npm run urls:find -- https://www.example.com --write`. Keep the same list
  for the retest, or the two passes aren't comparable; if you scoped the baseline with
  `--sample`, record which pages it covered.
- Decide the date stamp for this pass (the baseline date, or today's date for a retest)
  and whether files should be tagged `before` or `after`.
- Decide where the evidence pack will be filed (shared drive, ticket attachment, repo
  folder) and create the destination folder for this pass, e.g. `2026-07 Baseline Reports`.
- On a fresh machine, run `npm run setup`. The axe pass covers all three engines by
  default, and a missing engine makes the run exit non-zero rather than quietly producing
  a one-browser baseline. Decide up front which engines this pass covers and keep it the
  same for the retest — a baseline and an "after" run scanned with different engine sets
  aren't comparable.

## 1. Run the automated scans **(you, terminal)**

```
npm start
```

That runs axe (all selected engines), Lighthouse, and the extra checks in order, and
prints a summary of what completed. To run them separately — for instance to re-run just
one after a fix:

```
node axe-scan.js
bash lighthouse-scan.sh
npm run scan:extra
```

All of them read `urls.json` and write into `audits/`. Narrow the axe pass with
`--browsers=chromium` or `--browsers=firefox,webkit` if a pass only needs one engine;
expect roughly 3× the single-browser runtime for the full set. Lighthouse is Chromium-only
and takes noticeably longer — a full Chrome launch per URL, so several minutes for ~20 pages.

Sanity check before moving on:
```
ls audits/raw/*-axe-chromium.json | wc -l
ls audits/raw/*-axe-firefox.json | wc -l
ls audits/raw/*-axe-webkit.json | wc -l
ls audits/raw/*-lighthouse.report.json | wc -l
```
Each axe count should match the number of URLs in `urls.json` for every engine you
scanned, and so should Lighthouse's. `npm start` exits non-zero if any step failed, and
`axe-scan.js` does the same if any page failed or any requested engine was missing — so
check the exit status too. A partial run here means a partial merge later. Per-page
failures are recorded with an `error` field in `audits/reports/axe-summary.json`.

Also read the measurement diagnostics in that summary: `midFadeElements`, `retried` and
`contrastDisagreements` tell you whether a page was measured while still animating. Any
page with unresolved `contrastDisagreements` has a `measurementWarnings` block in its JSON
that needs a human look before those nodes go into the evidence as failures — see the
README's "Measuring an animated page without inventing failures".

## 2. Convert axe and Lighthouse to PDF **(you, terminal)**

```
node axe-to-pdf.js
node lighthouse-to-pdf.js
```
`axe-to-pdf.js` produces one PDF per page *per engine* (`<page>-axe-<engine>.pdf`), each
labelled with the engine and its user-agent string. All PDF steps render in Chromium —
Playwright's `page.pdf()` doesn't exist in Firefox or WebKit — which is also why they need
a real terminal with a browser binary rather than a sandboxed environment.

## 3. Run the WAVE pass **(you, browser, or Claude)**

Scan the same list of URLs from `urls.json` through WAVE and produce
`audits/raw/<page>-wave.json` for each. There's no standalone script — WAVE's free tool has
no API — so run:

```
npm run wave:prompt
```

and paste what it prints into a Claude session with browser access. It contains the method
and the exact output filename for every URL in `urls.json`. `npm start` prints the same
thing when the scans finish, and both save it to `audits/reports/wave-prompt.txt` so it
survives whatever scrolls past.

If this pass has to be repeated regularly, WebAIM's paid API (100 free credits, then from
$0.025/page) turns it into a plain request returning JSON and removes the dependency on
their web interface, which can change at any time.

If a page's template is shared with other pages (e.g. blog posts), don't shortcut this to
"scan one, reuse for all" — real content differences (image counts, headings, contrast)
mean each page's numbers genuinely differ, and reused numbers would misrepresent that
specific page's audit in the evidence pack.

## 4. Convert WAVE to PDF **(you, terminal)**

```
node wave-to-pdf.js
```
Same Chromium requirement as step 2.

## 5. Merge **(you, terminal)**

```
node merge-pdfs.js
```
Produces `audits/reports/<page>-full-report.pdf` for every page that has at least one axe
PDF and a Lighthouse PDF. Each merged file stacks the engines in order — Chromium,
Firefox, WebKit — then Lighthouse, then WAVE (folded in if present, skipped with a console
note if not). Pages missing a Lighthouse PDF are named in the output rather than silently
dropped. Spot-check the page count:
```
ls audits/reports/*-full-report.pdf | wc -l
```

Then build the summary tables:
```
node combine-report.js
```
`audits/reports/browser-comparison.csv` is the one to read first — one row per page with a
violation count per engine, so anything that only reproduces in Firefox or WebKit stands
out. `combined-summary.csv` keeps the long format (one row per page per engine) for the
evidence pack. Note the Lighthouse column repeats the same Chromium score on every
engine's row; it isn't a per-engine measurement.

## 6. Rename for the evidence pack

Strip the domain and tag with the pass date and before/after state:
```
<page>_<before|after>_<YYYY-MM-DD>.pdf
```
e.g. `about_before_2026-07-27.pdf`, `homepage_after_2026-09-15.pdf`. Use `homepage` for
the site root. Keep the names domain-free so a page's before and after files sit next to
each other.

## 7. File the evidence

Move the renamed PDFs from `audits/reports/` into this pass's folder in whatever system
holds the audit record. There's no automated upload step: where the evidence lives is a
project decision, and a wrong destination is worse than a manual drag. Keep each pass in
its own dated folder rather than overwriting the last one — the whole point of a retest is
being able to compare the two.

## 8. Log it

Every distinct issue found needs its own row in your change log or issue tracker, with
page, component, and WCAG criterion. The exported reports are the evidence a row points
to, not a substitute for the row. Do this per finding, not once at the end.

## Closing the manual gap and producing the findings report

The steps above produce the *automated-tool* evidence. These four close the remaining
criteria and merge everything into one report. Do them in the same pass:

### 9. The extra automated checks **(you, terminal)**

Already covered by `npm start` in step 1. To run it alone:

```
npm run scan:extra        # or: node extra-checks.js   (--fast to skip the ~10s/page animation waits)
```
Reads `urls.json`, writes `audits/raw/<page>-extra.json` + `audits/reports/extra-summary.json`.
Covers what axe/Lighthouse/WAVE can't: reflow at 320px, 200% zoom, text spacing, focus
visibility, skip link, target size, cross-page consistency, reduced motion (full list in
`COVERAGE.md`).

### 10. Snippet pass on unreachable states **(you, browser)**

For any page state the crawler can't see — logged-in pages, the mobile menu open, a form
showing errors — follow the instructions at the top of `console-snippet.js`: paste it in
DevTools, save the JSON it copies as `audits/raw/<page>-snippet.json`.

### 11. Manual audit **(you, keyboard + screen reader)**

```
npm run audit:manual      # resumable; npm run audit:manual:list shows progress
```
Walks every criterion that needs human judgement, with the test steps inline. Failures
recorded here (pages, component, severity, evidence filename) flow straight into the
findings report. This step is what makes the audit *complete*.

Answer `?` on any criterion the person running the pass cannot judge. It is recorded as
needing accessibility expertise and appears in the report under "Needs accessibility
expertise" as an open gap — the audit stays honest, and the row is a handover item rather
than a guess. Do not let a pass be recorded on anything nobody actually verified.

### 12. Generate the findings report **(you, terminal)**

```
npm run report:findings -- --label "Baseline 2026-08"
```
Writes `audits/reports/findings-report.md` + `findings.json`. The report shows all 55
criteria with a status each — anything still ⬜ NOT TESTED, 🔎 AUTO-CLEAN or 🙋 NEEDS
EXPERT means the audit isn't finished. The first two go back to step 11; NEEDS EXPERT rows
need a specialist to answer them.

### 13. Fix guide **(Claude)**

Hand `findings-report.md` to Claude — the exact prompt is embedded at the end of the
report. The result is a step-by-step fix guide any developer can follow, with one row per
fix ready to paste into an issue tracker. Log each fix in the change log as usual.

## Re-running for a retest

Repeat steps 1–12 with `before` swapped for `after` and a new date stamp, and re-answer
the manual pass with `node manual-audit.js --all`. Keep the baseline PDFs and the baseline
`findings-report.md` in their own dated folder rather than overwriting them — the retest
depends on being able to compare the two.
