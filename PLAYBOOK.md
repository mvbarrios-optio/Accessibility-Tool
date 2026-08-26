# Accessibility Audit Playbook

How to run a full baseline (or retest) pass with this toolkit, end to end. This maps onto Phase 0 ("Baseline audit") and Phase 4 ("Retest and evidence pack") of the SOV AI Accessibility Developer Brief — run it once at the start for the "before" evidence, and again at the end for the "after" evidence.

Each numbered step names who/what runs it: **(you, terminal)** for steps that need a real terminal with network access and Chromium installed, or **(Claude)** for steps that can be delegated in a Cowork session.

## 0. Before you start

- Confirm `urls.json` lists every page in scope. If the brief's page inventory changed, update this file first — everything downstream keys off it.
- Decide the date stamp for this pass (baseline date, or today's date for a retest) and whether files should be tagged `before` or `after`.
- Confirm the target Drive subfolder exists inside `SOV AI Evidence` (e.g. `2026-07 Baseline Reports` or `2026-XX Retest Reports`). Create it if it's a new pass.

## 1. Run the automated scans **(you, terminal)**

From the `a11y-audit` folder:
```
node axe-scan.js
bash lighthouse-scan.sh
```
Both read `urls.json` and write into `audits/raw/`. Lighthouse takes noticeably longer (a full Chrome launch per URL) — expect several minutes for ~20 pages.

Sanity check before moving on:
```
ls audits/raw/*-axe.json | wc -l
ls audits/raw/*-lighthouse.report.json | wc -l
```
Both counts should match the number of URLs in `urls.json`. If Lighthouse's count is short, check for errors in its console output before continuing — a partial run here means a partial merge later.

## 2. Convert axe and Lighthouse to PDF **(you, terminal)**

```
node axe-to-pdf.js
node lighthouse-to-pdf.js
```
These need Playwright's Chromium, which is why they run in your terminal rather than in Cowork's sandboxed tools — the sandbox has no browser binary and no route to install one.

## 3. Run the WAVE pass **(Claude)**

Hand this step to Claude in a Cowork session with the Claude-in-Chrome browser extension connected. Ask it to scan the same list of URLs from `urls.json` via WAVE and produce `audits/raw/<page>-wave.json` for each — see the README's "WAVE scan" section for the exact method (there's no standalone script for this step, since WAVE's free tool has no API).

If a page's template is shared with other pages (e.g. blog posts), don't shortcut this to "scan one, reuse for all" — real content differences (image counts, headings, contrast) mean each page's numbers genuinely differ, and reused numbers would misrepresent that specific page's audit in the evidence pack.

## 4. Convert WAVE to PDF **(you, terminal)**

```
node wave-to-pdf.js
```
Same Chromium requirement as step 2.

## 5. Merge **(you, terminal, or Claude if working from the same machine via the device bridge)**

```
node merge-pdfs.js
```
Produces `audits/reports/<page>-full-report.pdf` for every page that has both an axe and a Lighthouse PDF (WAVE is folded in if present, skipped with a console note if not). Spot-check the page count:
```
ls audits/reports/*-full-report.pdf | wc -l
```

## 6. Rename for the evidence pack

Strip the domain and tag with the pass date and before/after state:
```
<page>_<before|after>_<YYYY-MM-DD>.pdf
```
e.g. `about_before_2026-07-27.pdf`, `homepage_after_2026-09-15.pdf`. Use `homepage` for the site root — matches the brief's own screenshot-naming example. Don't leave the `www.sovereignai.gov.uk_` prefix on these; the brief's convention is page-name-only.

## 7. Upload to Drive

Open `SOV AI Evidence` → the pass's subfolder, and drag the renamed PDFs in from `audits/reports/`. This is currently a manual step — see the README's Google Drive section for why it isn't automated end-to-end.

## 8. Log it

Per the brief: every distinct issue found needs a row in the Change Log tab with page, component, and WCAG criterion — the exported reports are the evidence a row points to, not a substitute for the row. Do this per finding, not just once at the end.

## Re-running for a retest (Phase 4)

Repeat steps 1–7 with `before` swapped for `after` and a new date stamp. Keep the baseline PDFs in their own dated Drive subfolder rather than overwriting them — Phase 4 explicitly depends on being able to compare the two.
