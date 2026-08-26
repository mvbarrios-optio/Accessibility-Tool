# SOV AI Accessibility Audit Toolkit

Scripts for running an automated accessibility sweep (axe, Lighthouse, WAVE) across the Sovereign AI site and producing one merged PDF report per page.

## Folder layout

```
a11y-audit/
  urls.json                 List of pages to scan
  axe-scan.js                Runs axe-core against every URL -> audits/raw/<page>-axe.json
  axe-to-pdf.js               Converts axe JSON -> audits/raw/<page>-axe.pdf
  lighthouse-scan.sh          Runs Lighthouse (accessibility category) against every URL -> audits/raw/<page>-lighthouse.report.{html,json}
  lighthouse-to-pdf.js        Converts Lighthouse HTML report -> audits/raw/<page>-lighthouse.pdf
  wave-to-pdf.js               Converts WAVE JSON -> audits/raw/<page>-wave.pdf (see "WAVE scan" below — there's no wave-scan.js)
  merge-pdfs.js                Merges axe + Lighthouse + WAVE PDFs per page -> audits/reports/<page>-full-report.pdf
  audits/
    raw/                      Per-tool exports, one set per page
    reports/                  Final merged PDFs (what actually goes into evidence)
```

## Requirements

- Node.js and npm (the `devDependencies` in `package.json`: `@axe-core/playwright`, `lighthouse`, `pdf-lib`, `playwright`)
- Run `npx playwright install` once if Chromium isn't already installed for Playwright.
- All of these must be run from a real terminal on a machine with internet access and Playwright's Chromium installed — they will not run inside a sandboxed/bridged environment that lacks network access or a browser binary.

## Naming convention

Every file is named `<page>-<tool>.<ext>`, where `<page>` is the URL with the protocol and domain stripped, slashes turned into underscores, and the site root named `homepage`. Example: `https://www.sovereignai.gov.uk/about` → `about`. This matches the developer brief's screenshot convention (domain-free page name), just applied to whole-page tool reports instead of individual screenshots.

Final merged reports (after the rename step) follow: `<page>_<before|after>_<YYYY-MM-DD>.pdf` — e.g. `about_before_2026-07-27.pdf`. The date is the baseline date (or retest date for Phase 4), not necessarily the date the scan script physically ran.

## Running each tool

**axe:**
```
node axe-scan.js       # writes audits/raw/<page>-axe.json + audits/reports/axe-summary.json
node axe-to-pdf.js      # writes audits/raw/<page>-axe.pdf
```

**Lighthouse:**
```
bash lighthouse-scan.sh   # writes audits/raw/<page>-lighthouse.report.{html,json}
node lighthouse-to-pdf.js  # writes audits/raw/<page>-lighthouse.pdf
```
Note: `lighthouse-scan.sh` uses `sed -E 's|https?://||; ...'` to strip the protocol from URLs when building filenames. This must stay `-E` (extended regex) with no backslash before the `?` — on macOS's default BSD `sed`, `\?` is not a quantifier and silently fails to match, which breaks the filename match-up with axe's output and makes `merge-pdfs.js` skip every page.

**WAVE** (no script — see "WAVE scan" below for why):
```
node wave-to-pdf.js     # converts existing audits/raw/<page>-wave.json -> audits/raw/<page>-wave.pdf
```

**Merge:**
```
node merge-pdfs.js      # writes audits/reports/<page>-full-report.pdf
```
Requires an axe PDF and a Lighthouse PDF to exist for a page; the WAVE PDF is optional — if it's missing, the merge still runs with axe + Lighthouse only and logs a note.

## WAVE scan

WAVE's free web tool (`wave.webaim.org`) is a JavaScript single-page app with no official free API, so there's no reusable `wave-scan.js`. Producing `audits/raw/<page>-wave.json` for a set of URLs means, for each URL:

1. Navigate to `https://wave.webaim.org/report#/<full URL>` (this deep-link format works directly — no need to type into the form each time).
2. Wait for the report to fully load (the SPA doesn't repaint instantly on hash change — allow 8–9 seconds, and confirm `location.href` matches the target URL before reading data, since a too-short wait can return the previous page's stale numbers).
3. Read `window.wave.report.things.iconList` in the page's JS context — each entry has `.data.category`, `.data.title`, `.data.summary`. Group by `category|title` and count occurrences; `window.wave.report.aim` is the AIM score.
4. Write `{ url, aimScore, totalItems, categories: [{category, title, summary, count}, ...] }` to `audits/raw/<page>-wave.json`.

One caveat found in practice: dumping the full category+title+summary+count structure in a single JSON.stringify call sometimes trips a "cookie/query-string data" safety filter in the browser-automation JS tool, even though there's nothing sensitive in it — a false positive on the repeated key/value shape. Splitting the extraction into a small "counts" call and a separate "descriptions" call for any newly-seen issue type avoids it. Since WAVE's rule descriptions are fixed boilerplate text (not per-page), you only need to fetch a description once per unique category/title, not once per page.

## Google Drive evidence folder

Baseline (and later retest) reports are uploaded to:
```
SOV AI Evidence/
  2026-07 Baseline Reports/      (rename per phase, e.g. "2026-XX Retest Reports")
    homepage_before_2026-07-27.pdf
    about_before_2026-07-27.pdf
    ...
```
This mirrors the developer brief's target path (`/Accessibility/2026-07 Baseline/Reports/`) flattened to sit directly under the existing `SOV AI Evidence` folder, matching how the brief's screenshots are already stored there.

There's no automated upload path today — Claude's browser-automation session and its file-transfer bridge to your machine are governed by separate permission systems, and neither currently has blanket access to drag arbitrary local files into a Drive folder without you doing the literal drag yourself (or without spending an enormous number of tokens re-encoding each PDF's raw bytes). The practical path is: open the target Drive folder, then drag the renamed PDFs in from `audits/reports/` yourself.
