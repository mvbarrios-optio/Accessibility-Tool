const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('fs');
const path = require('path');
const urls = require('./urls.json');
const { resolveEngines, launchEngine, pageName } = require('./browsers');

const RAW_DIR = './audits/raw';
const REPORTS_DIR = './audits/reports';
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 45000);
const SETTLE_MS = Number(process.env.SETTLE_MS || 2500);

// Firefox and WebKit can sit on 'networkidle' forever on sites with long-lived
// connections (analytics beacons, chat widgets), so fall back to 'load'.
async function gotoSettled(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  } catch (err) {
    if (!/timeout/i.test(err.message)) throw err;
    console.log(`  (networkidle timed out, retrying with load: ${url})`);
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
  }
}

// Sites that reveal content with scroll-driven animation (GSAP/ScrollTrigger,
// Framer Motion, AOS, IntersectionObserver fades) can be measured mid-fade, and
// axe then reports the blended colour as a contrast failure -- a different card
// per engine on every run.
//
// The ONLY thing done here is: walk the page so scroll-triggered reveals fire,
// return to the top, and wait for them to finish on their own.
//
// Deliberately NOT done (an earlier version did, and it manufactured failures):
//   - injecting `animation-duration: 0s` -- can strip values an animation supplies
//   - gsap.globalTimeline.progress(1) / ScrollTrigger.progress(1) -- pins
//     scroll-driven state to an end state that does not match the scroll position
//   - forcing `opacity: 1` on everything -- reveals elements meant to stay hidden
//   - reducedMotion: 'reduce' -- some sites BRANCH on that query, so it changes
//     the behaviour being measured instead of just observing it
// Letting the animations finish naturally is slower but measures the real page.
async function settleAnimations(page) {
  await page.evaluate(async () => {
    const step = 400;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 130));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 600));
    window.scrollTo(0, 0);
  }).catch(() => {});

  await page.waitForTimeout(SETTLE_MS);
  return waitForStableChrome(page);
}

// Many sites paint their header/nav from an attribute or class that their own
// script sets after load (`data-theme`, `element-theme`, `class="theme-dark"`,
// a colour-scheme attribute…). Measuring inside that initialisation window is
// how axe ends up reporting dark text over a dark background -- a state that
// lasts milliseconds and that no visitor sees at rest.
//
// Rather than hardcode one site's attribute, snapshot every attribute on <html>
// and <body> and wait until the whole snapshot stops changing.
//
// The list below is only what gets REPORTED in the summary, for diagnosis; the
// fingerprint covers every attribute regardless. `class` is deliberately not in
// it: on a framework-built site it is hundreds of characters of webfont classes
// in a different order per page — 65% of axe-summary.json on the first real run
// — and says nothing about the theme. Class changes still count towards
// settling. Override with THEME_ATTRS=data-theme,data-mode if a site keeps its
// theme state somewhere else.
const THEME_ATTRS = (process.env.THEME_ATTRS ||
  'data-theme,data-color-scheme,data-mode,color-scheme,element-theme,theme')
  .split(',').map(s => s.trim()).filter(Boolean);

function readChromeState(page, attrs) {
  return page.evaluate((names) => {
    const snap = el => (el ? el.getAttributeNames()
      .map(n => `${n}=${el.getAttribute(n)}`).sort().join('|') : '');
    const reported = {};
    for (const name of names) {
      const v = (document.documentElement.getAttribute(name)) ??
        (document.body && document.body.getAttribute(name));
      if (v !== null && v !== undefined) reported[name] = v;
    }
    return { fingerprint: `${snap(document.documentElement)}##${snap(document.body)}`, reported };
  }, attrs).catch(() => null);
}

// Stable across two reads, not merely present -- a value that is still being
// written is worse than no value at all.
async function waitForStableChrome(page) {
  let last = null;
  for (let i = 0; i < 12; i++) {
    const now = await readChromeState(page, THEME_ATTRS);
    if (now && last && now.fingerprint === last.fingerprint) return now.reported;
    last = now;
    await page.waitForTimeout(400);
  }
  return last ? last.reported : {};
}

// The precise signature of the initialisation race above: axe reports one
// foreground colour while the live computed style says another. Checking the
// two against each other -- instead of pattern-matching known-bad selectors --
// catches the race on any site without a per-project ignore list.
function toHex(rgb) {
  const m = String(rgb).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map(n => parseInt(n, 10));
  if ([r, g, b].some(Number.isNaN)) return null;
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}

async function contrastDisagreements(page, results) {
  const cc = (results.violations || []).find(v => v.id === 'color-contrast');
  if (!cc) return [];

  const claims = cc.nodes.map(n => ({
    // Nested arrays mean an iframe path; only the top frame is checked here.
    target: Array.isArray(n.target) ? n.target.find(t => typeof t === 'string') : n.target,
    axeFg: (((n.any || [])[0] || {}).data || {}).fgColor
  })).filter(c => c.target && c.axeFg);
  if (!claims.length) return [];

  return page.evaluate((list) => list.flatMap(({ target, axeFg }) => {
    let el;
    try { el = document.querySelector(target); } catch (e) { return []; }
    if (!el) return [];
    const live = getComputedStyle(el).color;
    return [{ target, axeFg, liveColor: live }];
  }), claims).then(rows => rows.filter(r => {
    const live = toHex(r.liveColor);
    return live && live.toLowerCase() !== String(r.axeFg).toLowerCase();
  })).catch(() => []);
}

// Diagnostic only: elements whose opacity is STILL CHANGING when we measure.
// Sampling twice matters -- a decorative element parked at opacity .5 by design
// is not mid-fade, and counting it cries wolf on every page.
async function midFadeCount(page) {
  return page.evaluate(async () => {
    const read = () => {
      const m = new Map();
      document.querySelectorAll('*').forEach(el => {
        const o = parseFloat(getComputedStyle(el).opacity);
        if (o > 0 && o < 1) m.set(el, o);
      });
      return m;
    };
    const a = read();
    await new Promise(r => setTimeout(r, 400));
    const b = read();
    let moving = 0;
    b.forEach((v, el) => { if (!a.has(el) || Math.abs(a.get(el) - v) > 0.01) moving++; });
    return moving;
  }).catch(() => -1);
}

(async () => {
  if (!Array.isArray(urls) || !urls.length) {
    console.error('✗ urls.json is empty — list the pages in scope first (see urls.example.json).');
    process.exitCode = 1;
    return;
  }

  let engines;
  try {
    engines = resolveEngines();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  console.log(`Engines: ${engines.map(e => e.label).join(', ')}`);
  console.log(`Pages:   ${urls.length}`);
  console.log(`Settle:  scroll pass + ${SETTLE_MS}ms, waits for <html>/<body> attributes to stabilise`);

  const summary = [];
  const unavailable = [];
  let failures = 0;
  let dirty = 0;
  let retries = 0;
  let unresolved = 0;

  for (const engine of engines) {
    let browser;
    try {
      browser = await launchEngine(engine);
    } catch (err) {
      console.warn(`\n⚠ Skipping ${engine.label} — ${err.message}`);
      unavailable.push(engine.key);
      continue;
    }

    const version = browser.version();
    console.log(`\n── ${engine.label} ${version} ──`);

    for (const url of urls) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await gotoSettled(page, url);
        await waitForStableChrome(page);
        let themeState = await settleAnimations(page);

        let midFade = await midFadeCount(page);
        let results = await new AxeBuilder({ page }).analyze();
        let disagreements = await contrastDisagreements(page, results);
        let retried = false;

        // A real failure reproduces; a measurement race does not.
        if (disagreements.length) {
          retried = true;
          retries++;
          await page.reload({ waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
          await waitForStableChrome(page);
          themeState = await settleAnimations(page);
          midFade = await midFadeCount(page);
          results = await new AxeBuilder({ page }).analyze();
          disagreements = await contrastDisagreements(page, results);
        }
        if (midFade > 0) dirty++;
        if (disagreements.length) unresolved++;

        // Kept in the JSON rather than filtered out: a colour axe and the
        // browser still disagree on needs a human decision, not a silent drop.
        if (disagreements.length) {
          results.measurementWarnings = {
            rule: 'color-contrast',
            note: 'axe reported a foreground colour the live computed style disagrees with, '
              + 'after a reload and re-measure. Verify by hand before treating as a failure.',
            nodes: disagreements
          };
        }

        const file = `${pageName(url)}-axe-${engine.key}.json`;
        fs.writeFileSync(path.join(RAW_DIR, file), JSON.stringify(results, null, 2));

        summary.push({
          url,
          browser: engine.key,
          browserLabel: engine.label,
          browserVersion: version,
          violations: results.violations.length,
          critical: results.violations.filter(v => v.impact === 'critical').length,
          serious: results.violations.filter(v => v.impact === 'serious').length,
          midFadeElements: midFade,
          themeState,
          retried,
          contrastDisagreements: disagreements.length
        });

        const warn = (midFade > 0 ? `  ⚠ ${midFade} element(s) mid-fade` : '')
          + (retried ? '  ↻ re-measured (colour race)' : '')
          + (disagreements.length ? `  ⚠ ${disagreements.length} contrast reading(s) unconfirmed` : '');
        console.log(`✓ [${engine.key}] ${url} (${results.violations.length} violations)${warn}`);
      } catch (err) {
        failures++;
        const message = String(err.message).split('\n')[0];
        summary.push({
          url,
          browser: engine.key,
          browserLabel: engine.label,
          browserVersion: version,
          violations: null,
          critical: null,
          serious: null,
          error: message
        });
        console.warn(`✗ [${engine.key}] ${url} — ${message}`);
      } finally {
        await context.close();
      }
    }

    await browser.close();
  }

  fs.writeFileSync(path.join(REPORTS_DIR, 'axe-summary.json'), JSON.stringify(summary, null, 2));

  const scanned = summary.filter(r => r.violations !== null).length;
  console.log(`\nDone: ${scanned}/${engines.length * urls.length} page-scans written to ${RAW_DIR}`);
  if (retries) {
    console.log(`↻ ${retries} page-scan(s) re-measured after catching a colour mid-initialisation.`);
  }
  if (unresolved) {
    console.log(`⚠ ${unresolved} page-scan(s) still report a contrast colour the browser disagrees with.`);
    console.log(`  See "measurementWarnings" in the page JSON, and verify those nodes by hand.`);
  }
  if (dirty) {
    console.log(`⚠ ${dirty} page-scan(s) measured with animations still running.`);
    console.log(`  Re-run with a longer settle:  SETTLE_MS=5000 node axe-scan.js`);
  }
  if (unavailable.length) {
    console.log(`Engines not installed (skipped): ${unavailable.join(', ')}`);
    console.log(`  npx playwright install ${unavailable.join(' ')}`);
  }
  // A requested-but-unavailable engine is an incomplete audit, not a success.
  if (!scanned || failures || unavailable.length) process.exitCode = 1;
})();
