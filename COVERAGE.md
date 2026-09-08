# WCAG 2.2 A/AA Coverage Map — what verifies each criterion

This answers "does the toolkit verify everything?" — per criterion, which tool
produces evidence for it, and what remains a human job. Generated from
`criteria.json` (the single source of truth also used by `manual-audit.js`
and `generate-report.js`).

**Legend**
- **axe** = axe-scan.js (multi-engine) — *good* means axe alone reliably detects failures; *partial* means it catches some failure modes only.
- **extra** = extra-checks.js (the named check ids).
- **snippet** = console-snippet.js run in DevTools (for logged-in pages / special states).
- **manual** = requires human judgement — guided by manual-audit.js.
- WAVE adds corroborating evidence on several criteria but is not the sole source for any.

The honest headline: **automated tools alone fully verify only 1 of the 55
criteria (3.1.1)**. Everything else is either partially automated (the tools
find *some* failure modes and inventory the rest for review) or fully manual.
That matches the industry rule of thumb (automated ≈ 30% of criteria). The
toolkit's job is to make the other 70% fast and impossible to forget — not to
pretend it's automated.

| SC | Criterion | Level | axe | extra-checks | snippet | Manual needed? |
|---|---|---|---|---|---|---|
| 1.1.1 | Non-text Content | A | partial | — | img-alt | yes |
| 1.2.1 | Audio-only and Video-only (Prerecorded) | A | — | — | media-inventory | yes |
| 1.2.2 | Captions (Prerecorded) | A | partial | — | media-inventory | yes |
| 1.2.3 | Audio Description or Media Alternative | A | — | — | media-inventory | yes |
| 1.2.4 | Captions (Live) | AA | — | — | — | yes |
| 1.2.5 | Audio Description (Prerecorded) | AA | — | — | media-inventory | yes |
| 1.3.1 | Info and Relationships | A | partial | headings, landmarks | headings, landmarks | yes |
| 1.3.2 | Meaningful Sequence | A | — | tabindex-positive | tabindex-positive | yes |
| 1.3.3 | Sensory Characteristics | A | — | — | — | yes |
| 1.3.4 | Orientation | AA | — | — | — | yes |
| 1.3.5 | Identify Input Purpose | AA | partial | autocomplete | autocomplete | yes |
| 1.4.1 | Use of Colour | A | — | — | body-links | yes |
| 1.4.2 | Audio Control | A | partial | autoplay-media | autoplay-media | yes |
| 1.4.3 | Contrast (Minimum) | AA | good | — | — | yes |
| 1.4.4 | Resize Text | AA | partial | viewport-meta, zoom-200 | viewport-meta | yes |
| 1.4.5 | Images of Text | AA | — | — | img-alt | yes |
| 1.4.10 | Reflow | AA | — | reflow-320 | — | yes |
| 1.4.11 | Non-text Contrast | AA | — | — | — | yes |
| 1.4.12 | Text Spacing | AA | — | text-spacing | text-spacing | yes |
| 1.4.13 | Content on Hover or Focus | AA | — | — | — | yes |
| 2.1.1 | Keyboard | A | partial | focus-visible | — | yes |
| 2.1.2 | No Keyboard Trap | A | — | — | — | yes |
| 2.1.4 | Character Key Shortcuts | A | — | — | — | yes |
| 2.2.1 | Timing Adjustable | A | partial | — | meta-refresh | yes |
| 2.2.2 | Pause, Stop, Hide | A | — | reduced-motion, autoplay-media | long-animations | yes |
| 2.3.1 | Three Flashes or Below Threshold | A | — | — | — | yes |
| 2.4.1 | Bypass Blocks | A | partial | skip-link | landmarks | yes |
| 2.4.2 | Page Titled | A | good | page-title, title-duplicates | page-title | yes |
| 2.4.3 | Focus Order | A | — | tabindex-positive, focus-visible | tabindex-positive | yes |
| 2.4.4 | Link Purpose (In Context) | A | partial | — | vague-links | yes |
| 2.4.5 | Multiple Ways | AA | — | — | — | yes |
| 2.4.6 | Headings and Labels | AA | — | headings | headings | yes |
| 2.4.7 | Focus Visible | AA | — | focus-visible | outline-none | yes |
| 2.4.11 | Focus Not Obscured (Minimum) | AA | — | focus-obscured | — | yes |
| 2.5.1 | Pointer Gestures | A | — | — | — | yes |
| 2.5.2 | Pointer Cancellation | A | — | — | — | yes |
| 2.5.3 | Label in Name | A | good | — | label-in-name | yes |
| 2.5.4 | Motion Actuation | A | — | — | — | yes |
| 2.5.7 | Dragging Movements | AA | — | — | — | yes |
| 2.5.8 | Target Size (Minimum) | AA | partial | target-size | target-size | yes |
| 3.1.1 | Language of Page | A | good | lang | lang | no |
| 3.1.2 | Language of Parts | AA | partial | — | — | yes |
| 3.2.1 | On Focus | A | — | — | — | yes |
| 3.2.2 | On Input | A | — | — | — | yes |
| 3.2.3 | Consistent Navigation | AA | — | consistent-nav | — | yes |
| 3.2.4 | Consistent Identification | AA | — | — | — | yes |
| 3.2.6 | Consistent Help | A | — | consistent-help | — | yes |
| 3.3.1 | Error Identification | A | — | — | — | yes |
| 3.3.2 | Labels or Instructions | A | partial | placeholder-label | placeholder-label | yes |
| 3.3.3 | Error Suggestion | AA | — | — | — | yes |
| 3.3.4 | Error Prevention (Legal, Financial, Data) | AA | — | — | — | yes |
| 3.3.7 | Redundant Entry | A | — | — | — | yes |
| 3.3.8 | Accessible Authentication (Minimum) | AA | — | — | — | yes |
| 4.1.2 | Name, Role, Value | A | good | — | aria-state | yes |
| 4.1.3 | Status Messages | AA | — | — | live-regions | yes |

## Totals

- axe contributes evidence on **18** criteria (fully reliable on very few — see per-row rating).
- extra-checks.js contributes on **20** criteria — this is the layer axe/Lighthouse/WAVE were missing (reflow, zoom, text spacing, focus visibility, skip link, target size, consistency across pages, reduced motion…).
- The console snippet contributes on **27** criteria, including states the crawler can't reach.
- **21** criteria have no automated signal at all — manual-audit.js walks you through every one.
- **54/55** criteria need a human decision to be marked Pass. generate-report.js refuses to call a criterion "pass" from automation alone (it shows AUTO-CLEAN instead) precisely so the audit can't quietly overstate coverage.

## The complete verification recipe

1. `npm start` — axe (all engines) + Lighthouse + the extra checks below, in one
   command — plus the WAVE pass (browser, see the README)
2. `node extra-checks.js` — the automated checks above, if run on its own
3. Console snippet on any page state the crawler can't reach (menus open, forms in error state, logged-in pages)
4. `npm run audit:manual` — guided answers for everything that needs eyes and ears
   (keyboard, screen reader, judgement calls). Answer `?` on anything you cannot judge:
   it is recorded as needing accessibility expertise and stays an open gap in the report,
   which is the honest outcome and far better than a guessed pass.
5. `node generate-report.js` — merges 1–4, shows exactly what's still unverified, and produces the findings report for the fix guide
