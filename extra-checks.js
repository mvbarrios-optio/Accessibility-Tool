// extra-checks.js — automated checks for WCAG criteria that axe/Lighthouse/WAVE
// do NOT (or only partially) cover. Complements axe-scan.js; does not replace it.
//
// Covers (fully or partially): 1.3.1 (headings/landmarks), 1.3.5 (autocomplete),
// 1.4.2 (autoplay audio), 1.4.4 (zoom/viewport meta), 1.4.10 (reflow @320px),
// 1.4.12 (text spacing), 2.2.2 (reduced motion / long animations), 2.4.1 (skip link),
// 2.4.2 (page titles + uniqueness), 2.4.3 (tabindex>0 + tab sequence), 2.4.7 (focus
// visible), 2.4.11 (focus not obscured), 2.5.8 (target size), 3.1.1 (lang),
// 3.2.3 (consistent nav), 3.2.6 (consistent help), 3.3.2 (placeholder-only labels).
//
// Usage:
//   node extra-checks.js            # all URLs in urls.json, Chromium
//   node extra-checks.js --fast     # skip the two ~5s animation waits per page
//   MAX_TABS=80 node extra-checks.js
//
// Output:
//   audits/raw/<page>-extra.json          one file per page
//   audits/reports/extra-summary.json     per-page counts + site-level checks
//
// Chromium-only by design: these are layout/behaviour probes, and the tab-order
// simulation relies on Chromium's focus behaviour. Engine-specific a11y-tree
// differences are already covered by the multi-engine axe pass.

const fs = require('fs');
const path = require('path');
const urls = require('./urls.json');
const { engineByName, launchEngine, pageName } = require('./browsers');

const RAW_DIR = './audits/raw';
const REPORTS_DIR = './audits/reports';
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 45000);
const MAX_TABS = Number(process.env.MAX_TABS || 60);
const FAST = process.argv.includes('--fast');
const ANIM_WAIT = FAST ? 0 : 5200; // 2.2.2 targets motion lasting > 5 seconds

async function gotoSettled(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  } catch (err) {
    if (!/timeout/i.test(err.message)) throw err;
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
  }
}

// ─── In-page static checks (run in one evaluate) ────────────────────────────
function staticChecks() {
  const out = [];
  const short = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const sel = el => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let p = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`#${node.id}`); break; }
      const cls = (node.className && typeof node.className === 'string')
        ? node.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      if (cls) p += '.' + cls;
      const sibs = node.parentElement
        ? [...node.parentElement.children].filter(c => c.tagName === node.tagName) : [];
      if (sibs.length > 1) p += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      parts.unshift(p);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const detail = (el, note, extra) => Object.assign(
    { selector: sel(el), html: short(el.outerHTML), note }, extra || {});
  const push = (id, sc, status, details, summary) =>
    out.push({ id, sc, status, summary, details: details.slice(0, 25), totalDetails: details.length });

  // viewport-meta (1.4.4)
  {
    const m = document.querySelector('meta[name="viewport"]');
    const c = (m && m.getAttribute('content') || '').toLowerCase();
    const noScale = /user-scalable\s*=\s*(no|0)/.test(c);
    const maxScale = c.match(/maximum-scale\s*=\s*([\d.]+)/);
    const blocked = noScale || (maxScale && parseFloat(maxScale[1]) < 2);
    push('viewport-meta', ['1.4.4'], blocked ? 'fail' : 'pass',
      blocked ? [detail(m, `viewport meta blocks zoom: "${c}"`)] : [],
      blocked ? 'Pinch/browser zoom is blocked by the viewport meta tag'
              : 'Viewport meta does not block zooming');
  }

  // lang (3.1.1)
  {
    const lang = document.documentElement.getAttribute('lang') || '';
    const ok = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(lang);
    push('lang', ['3.1.1'], ok ? 'pass' : 'fail',
      ok ? [] : [detail(document.documentElement, lang ? `invalid lang="${lang}"` : 'missing lang attribute on <html>')],
      ok ? `lang="${lang}"` : 'html element lang attribute missing or invalid');
  }

  // headings (1.3.1 / 2.4.6)
  {
    const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].map(el => ({
      el,
      level: el.matches('[role="heading"]')
        ? Number(el.getAttribute('aria-level') || 2)
        : Number(el.tagName[1]),
      text: short(el.textContent)
    }));
    const issues = [];
    const h1s = hs.filter(h => h.level === 1);
    if (!h1s.length) issues.push({ selector: 'html', html: '', note: 'no h1 on the page' });
    if (h1s.length > 1) h1s.slice(1).forEach(h => issues.push(detail(h.el, 'more than one h1')));
    let prev = 0;
    for (const h of hs) {
      if (prev && h.level > prev + 1) issues.push(detail(h.el, `skipped heading level: h${prev} -> h${h.level}`));
      if (!h.text) issues.push(detail(h.el, 'empty heading'));
      prev = h.level;
    }
    push('headings', ['1.3.1', '2.4.6'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? `${issues.length} heading structure issue(s)` : `Outline OK (${hs.length} headings)`);
    out[out.length - 1].outline = hs.map(h => `${'  '.repeat(h.level - 1)}h${h.level}: ${h.text}`);
  }

  // landmarks (1.3.1 / 2.4.1)
  {
    const mains = document.querySelectorAll('main, [role="main"]');
    const issues = [];
    if (!mains.length) issues.push({ selector: 'body', html: '', note: 'no <main> landmark' });
    if (mains.length > 1) issues.push({ selector: 'body', html: '', note: `${mains.length} main landmarks (should be exactly 1)` });
    const missing = [];
    if (!document.querySelector('header, [role="banner"]')) missing.push('banner/header');
    if (!document.querySelector('nav, [role="navigation"]')) missing.push('nav');
    if (!document.querySelector('footer, [role="contentinfo"]')) missing.push('contentinfo/footer');
    if (missing.length) issues.push({ selector: 'body', html: '', note: `missing landmarks: ${missing.join(', ')}` });
    push('landmarks', ['1.3.1', '2.4.1'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? issues.map(i => i.note).join('; ') : 'banner, nav, main and contentinfo all present');
  }

  // autocomplete (1.3.5)
  {
    // Field-name hints. Deliberately multilingual (en, es, fr, de, pt, it): a
    // form labelled in the site's own language still owes its users autocomplete.
    const tokens = [
      [/e-?mail|correo|courriel/i, 'email'],
      [/first.?name|fname|nombre|pr[eé]nom|vorname|primeiro.?nome/i, 'given-name'],
      [/last.?name|lname|surname|apellido|nom.?de.?famille|nachname|sobrenome|cognome/i, 'family-name'],
      [/full.?name|your.?name|^name$|nom.?complet|vollst[aä]ndiger.?name/i, 'name'],
      [/phone|tel|mobile|m[oó]vil|t[eé]l[eé]phone|portable|telefon|celular/i, 'tel'],
      [/address|direcci[oó]n|street|adresse|stra[sß]e|endere[cç]o|indirizzo/i, 'street-address'],
      [/post.?code|zip|c[oó]digo.?postal|postleitzahl|plz|cap$/i, 'postal-code'],
      [/city|town|ciudad|ville|stadt|cidade|citt[aà]/i, 'address-level2'],
      [/country|pa[ií]s|pays|land$|paese/i, 'country-name'],
      [/company|organi[sz]ation|empresa|entreprise|unternehmen|azienda/i, 'organization']
    ];
    const issues = [];
    for (const inp of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea')) {
      if (!visible(inp)) continue;
      const label = inp.labels && inp.labels[0] ? inp.labels[0].textContent : '';
      const hint = `${inp.name} ${inp.id} ${inp.type} ${label} ${inp.getAttribute('placeholder') || ''}`;
      if (inp.type === 'email') {
        if (!inp.getAttribute('autocomplete')) issues.push(detail(inp, 'email field missing autocomplete="email"'));
        continue;
      }
      for (const [re, token] of tokens) {
        if (re.test(hint) && !inp.getAttribute('autocomplete')) {
          issues.push(detail(inp, `likely personal-data field missing autocomplete="${token}"`));
          break;
        }
      }
    }
    push('autocomplete', ['1.3.5'], issues.length ? 'review' : 'pass', issues,
      issues.length ? `${issues.length} field(s) likely missing an autocomplete token (verify each collects the user's own data)`
                    : 'No obvious personal-data fields missing autocomplete');
  }

  // placeholder-label (3.3.2)
  {
    const issues = [];
    for (const inp of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select')) {
      if (!visible(inp)) continue;
      const hasVisibleLabel = inp.labels && [...inp.labels].some(l => visible(l) && l.textContent.trim());
      const hasAria = inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby');
      const hasPlaceholder = !!inp.getAttribute('placeholder');
      if (!hasVisibleLabel && hasPlaceholder) {
        issues.push(detail(inp, hasAria
          ? 'placeholder + aria-label only: no persistent VISIBLE label (3.3.2 needs one)'
          : 'placeholder is the only label — fails 3.3.2 (and disappears while typing)'));
      } else if (!hasVisibleLabel && !hasAria && !hasPlaceholder) {
        issues.push(detail(inp, 'form control with no label at all'));
      }
    }
    push('placeholder-label', ['3.3.2'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? `${issues.length} field(s) without a persistent visible label` : 'All visible form fields have labels');
  }

  // autoplay-media (1.4.2 / 2.2.2)
  {
    const issues = [];
    for (const m of document.querySelectorAll('video, audio')) {
      const autoplays = m.hasAttribute('autoplay') || (m.readyState > 2 && !m.paused);
      if (!autoplays) continue;
      const silent = m.muted || m.volume === 0 || !m.hasAttribute('src') && !m.querySelector('source');
      issues.push(detail(m, silent
        ? 'autoplaying media (muted) — needs pause/stop control if it runs >5s (2.2.2)'
        : 'autoplaying media WITH AUDIO — needs pause/mute within 3s reach (1.4.2)',
        { audible: !silent }));
    }
    if (document.querySelector('marquee, blink')) {
      issues.push(detail(document.querySelector('marquee, blink'), 'marquee/blink element'));
    }
    const audible = issues.some(i => i.audible);
    push('autoplay-media', ['1.4.2', '2.2.2'], issues.length ? (audible ? 'fail' : 'review') : 'pass',
      issues, issues.length ? `${issues.length} autoplaying media element(s)` : 'No autoplaying media detected');
  }

  // meta-refresh (2.2.1)
  {
    const m = document.querySelector('meta[http-equiv="refresh" i]');
    const secs = m ? parseInt(m.getAttribute('content'), 10) : NaN;
    const bad = m && secs > 0;
    push('meta-refresh', ['2.2.1'], bad ? 'fail' : 'pass',
      bad ? [detail(m, `page auto-refreshes/redirects after ${secs}s with no user control`)] : [],
      bad ? 'Timed meta refresh present' : 'No timed meta refresh');
  }

  // tabindex-positive (2.4.3 / 1.3.2)
  {
    const issues = [...document.querySelectorAll('[tabindex]')]
      .filter(el => Number(el.getAttribute('tabindex')) > 0)
      .map(el => detail(el, `tabindex="${el.getAttribute('tabindex')}" overrides natural focus order`));
    push('tabindex-positive', ['2.4.3', '1.3.2'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? `${issues.length} element(s) with positive tabindex` : 'No positive tabindex values');
  }

  // target-size (2.5.8)
  {
    const candidates = [...document.querySelectorAll(
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [onclick], [tabindex]:not([tabindex="-1"])'
    )].filter(visible);
    const centers = candidates.map(el => {
      const r = el.getBoundingClientRect();
      return { el, r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    const issues = [];
    for (const c of centers) {
      if (c.r.width >= 24 && c.r.height >= 24) continue;
      // Inline-text-link exemption
      const st = getComputedStyle(c.el);
      if (c.el.tagName === 'A' && st.display.startsWith('inline')) {
        const parentText = (c.el.parentElement && c.el.parentElement.textContent.trim().length) || 0;
        const ownText = c.el.textContent.trim().length;
        if (parentText > ownText + 3) continue; // link inside a sentence
      }
      // Spacing exception: no other target centre within 24px
      let crowded = false;
      for (const o of centers) {
        if (o.el === c.el) continue;
        if (Math.hypot(o.cx - c.cx, o.cy - c.cy) < 24) { crowded = true; break; }
      }
      const size = `${Math.round(c.r.width)}x${Math.round(c.r.height)}px`;
      issues.push(detail(c.el, crowded
        ? `target ${size} (<24x24) with another target within 24px — fails 2.5.8`
        : `target ${size} (<24x24) but isolated — likely passes via spacing exception, verify`,
        { status: crowded ? 'fail' : 'review' }));
    }
    const anyFail = issues.some(i => i.status === 'fail');
    push('target-size', ['2.5.8'], issues.length ? (anyFail ? 'fail' : 'review') : 'pass', issues,
      issues.length ? `${issues.length} small target(s) (${issues.filter(i => i.status === 'fail').length} crowded)` : 'All targets ≥24x24 or exempt');
  }

  return out;
}

// ─── Reflow / overflow detection (run at a given viewport) ──────────────────
function overflowCheck() {
  const vw = document.documentElement.clientWidth;
  const doc = document.documentElement;
  const overflow = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0) - vw;
  const offenders = [];
  if (overflow > 2) {
    const flagged = new Set();
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 2 || r.left < -2) {
        let p = el.parentElement, skip = false;
        while (p) { if (flagged.has(p)) { skip = true; break; } p = p.parentElement; }
        if (skip) continue;
        flagged.add(el);
        offenders.push({
          selector: el.id ? `#${el.id}` : el.tagName.toLowerCase() +
            (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
          html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 80),
          note: `extends to ${Math.round(r.right)}px (viewport ${vw}px)`
        });
        if (offenders.length >= 15) break;
      }
    }
  }
  return { viewport: vw, overflowPx: Math.max(0, overflow), offenders };
}

// ─── Text spacing (1.4.12) ──────────────────────────────────────────────────
function clippedSet() {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.textContent || !el.textContent.trim()) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const clips = /(hidden|clip)/.test(st.overflow + st.overflowX + st.overflowY);
    if (clips && (el.scrollWidth > el.clientWidth + 3 || el.scrollHeight > el.clientHeight + 3)) {
      out.push(el.id ? `#${el.id}` : el.tagName.toLowerCase() + '|' + el.textContent.trim().slice(0, 40));
    }
  }
  return out;
}

const TEXT_SPACING_CSS = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

// ─── Focus / tab-order pass (2.4.1, 2.4.3, 2.4.7, 2.4.11) ──────────────────
async function tabPass(page) {
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
  const stops = [];
  const seen = new Set();
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const grab = () => {
        const st = getComputedStyle(el);
        return [st.outlineStyle, st.outlineWidth, st.outlineColor, st.boxShadow,
                st.backgroundColor, st.borderColor, st.textDecorationLine].join('|');
      };
      const focused = grab();
      el.blur();
      const blurred = grab();
      el.focus({ preventScroll: false });
      const r = el.getBoundingClientRect();
      const cx = Math.max(1, Math.min(innerWidth - 1, r.left + r.width / 2));
      const cy = Math.max(1, Math.min(innerHeight - 1, r.top + r.height / 2));
      let obscuredBy = null;
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        let n = top;
        while (n && n !== document.body) {
          const pos = getComputedStyle(n).position;
          if (pos === 'fixed' || pos === 'sticky') {
            obscuredBy = n.id ? `#${n.id}` : n.tagName.toLowerCase() +
              (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/)[0] : '');
            break;
          }
          n = n.parentElement;
        }
      }
      const sel = el.id ? `#${el.id}` : el.tagName.toLowerCase() +
        (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
      return {
        selector: sel,
        tag: el.tagName.toLowerCase(),
        text: (el.getAttribute('aria-label') || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        href: el.getAttribute('href') || null,
        visibleWhenFocused: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden',
        focusStyleChanges: focused !== blurred,
        obscuredBy
      };
    });
    if (!info) break;
    const key = info.selector + '|' + info.text;
    if (seen.has(key)) break; // cycled back
    seen.add(key);
    stops.push(info);
  }
  return stops;
}

function checksFromTabPass(stops) {
  const checks = [];
  // skip-link (2.4.1)
  const first = stops[0];
  const isSkip = first && first.tag === 'a' && first.href && first.href.startsWith('#') &&
    /skip|main|content|saltar|contenido/i.test(first.text);
  checks.push({
    id: 'skip-link', sc: ['2.4.1'],
    status: isSkip ? (first.visibleWhenFocused ? 'pass' : 'fail') : 'fail',
    summary: !first ? 'No focusable elements found'
      : isSkip
        ? (first.visibleWhenFocused ? `First tab stop is a visible skip link ("${first.text}")`
                                     : `Skip link exists but is not visible when focused`)
        : `First tab stop is not a skip link (got ${first.tag} "${first.text}")`,
    details: first && !isSkip ? [{ selector: first.selector, html: '', note: `first Tab press lands on: <${first.tag}> "${first.text}"` }] : [],
    totalDetails: first && !isSkip ? 1 : 0
  });
  // focus-visible (2.4.7)
  const invisible = stops.filter(s => !s.focusStyleChanges);
  checks.push({
    id: 'focus-visible', sc: ['2.4.7'],
    status: invisible.length ? 'fail' : (stops.length ? 'pass' : 'review'),
    summary: invisible.length
      ? `${invisible.length}/${stops.length} tab stops show NO style change on focus`
      : (stops.length ? `All ${stops.length} sampled tab stops show a focus style` : 'No tab stops sampled'),
    details: invisible.slice(0, 25).map(s => ({ selector: s.selector, html: '', note: `<${s.tag}> "${s.text}" — no detectable focus indicator` })),
    totalDetails: invisible.length
  });
  // focus-obscured (2.4.11)
  const obscured = stops.filter(s => s.obscuredBy);
  checks.push({
    id: 'focus-obscured', sc: ['2.4.11'],
    status: obscured.length ? 'review' : 'pass',
    summary: obscured.length
      ? `${obscured.length} tab stop(s) covered by a fixed/sticky element at their centre (verify manually)`
      : 'No tab stop obscured by fixed/sticky elements',
    details: obscured.slice(0, 25).map(s => ({ selector: s.selector, html: '', note: `covered by ${s.obscuredBy}` })),
    totalDetails: obscured.length
  });
  return checks;
}

// ─── Site-level checks across pages ─────────────────────────────────────────
function siteChecks(pages) {
  const checks = [];
  // title-duplicates (2.4.2)
  const byTitle = {};
  for (const p of pages) (byTitle[p.title || ''] = byTitle[p.title || ''] || []).push(p.page);
  const dupes = Object.entries(byTitle).filter(([t, ps]) => ps.length > 1 || !t.trim());
  checks.push({
    id: 'title-duplicates', sc: ['2.4.2'],
    status: dupes.length ? 'fail' : 'pass',
    summary: dupes.length ? `${dupes.length} duplicate/empty title group(s)` : 'All page titles unique and non-empty',
    details: dupes.map(([t, ps]) => ({ selector: 'title', html: '', note: `"${t || '(empty)'}" used on: ${ps.join(', ')}` })),
    totalDetails: dupes.length
  });
  // consistent-nav (3.2.3)
  const sigs = {};
  for (const p of pages) if (p.navSignature) (sigs[p.navSignature] = sigs[p.navSignature] || []).push(p.page);
  const groups = Object.entries(sigs).sort((a, b) => b[1].length - a[1].length);
  checks.push({
    id: 'consistent-nav', sc: ['3.2.3'],
    status: groups.length > 1 ? 'review' : 'pass',
    summary: groups.length > 1
      ? `Navigation differs across pages: ${groups.length} distinct nav orders found (verify intentional)`
      : 'Primary navigation identical on every page',
    details: groups.length > 1 ? groups.map(([sig, ps]) => ({
      selector: 'nav', html: '', note: `[${ps.length} page(s): ${ps.slice(0, 6).join(', ')}${ps.length > 6 ? '…' : ''}] nav = ${sig.slice(0, 120)}`
    })) : [],
    totalDetails: groups.length > 1 ? groups.length : 0
  });
  // consistent-help (3.2.6)
  const helpSigs = {};
  for (const p of pages) (helpSigs[p.helpSignature || '(none)'] = helpSigs[p.helpSignature || '(none)'] || []).push(p.page);
  const helpGroups = Object.entries(helpSigs);
  checks.push({
    id: 'consistent-help', sc: ['3.2.6'],
    status: helpGroups.length > 1 ? 'review' : 'pass',
    summary: helpGroups.length > 1
      ? `Help/contact links appear in different places across pages (verify)`
      : 'Help/contact mechanism consistent across pages',
    details: helpGroups.length > 1 ? helpGroups.map(([sig, ps]) => ({
      selector: '', html: '', note: `[${ps.length} page(s): ${ps.slice(0, 6).join(', ')}${ps.length > 6 ? '…' : ''}] help links = ${sig.slice(0, 120)}`
    })) : [],
    totalDetails: helpGroups.length > 1 ? helpGroups.length : 0
  });
  return checks;
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const engine = engineByName('chromium');
  let browser;
  try {
    browser = await launchEngine(engine);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`extra-checks: ${urls.length} pages, Chromium ${browser.version()}${FAST ? ' (--fast: animation checks skipped)' : ''}`);

  const pageSummaries = [];
  let scanErrors = 0;

  for (const url of urls) {
    const name = pageName(url);
    const checks = [];
    let meta = { url, page: name };
    try {
      // Pass 1: default viewport — static checks + tab pass + text spacing
      const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
      const page = await context.newPage();
      await gotoSettled(page, url);

      checks.push(...await page.evaluate(staticChecks));
      meta.title = await page.title();
      meta.navSignature = await page.evaluate(() => {
        const nav = document.querySelector('nav, [role="navigation"]');
        return nav ? [...nav.querySelectorAll('a')].map(a => a.textContent.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean).join(' | ') : '';
      });
      meta.helpSignature = await page.evaluate(() => {
        const hits = [];
        for (const a of document.querySelectorAll('a[href]')) {
          if (/contact|help|support|get in touch|contacto|ayuda/i.test(a.textContent)) {
            const lm = a.closest('header, nav, main, footer, [role="banner"], [role="contentinfo"]');
            hits.push(`${(a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 30)}@${lm ? lm.tagName.toLowerCase() : 'body'}`);
          }
        }
        return [...new Set(hits)].sort().join(' | ');
      });

      // text-spacing (1.4.12)
      const before = await page.evaluate(clippedSet);
      await page.addStyleTag({ content: TEXT_SPACING_CSS });
      await page.waitForTimeout(400);
      const after = await page.evaluate(clippedSet);
      const newClipped = after.filter(s => !before.includes(s));
      checks.push({
        id: 'text-spacing', sc: ['1.4.12'],
        status: newClipped.length ? 'fail' : 'pass',
        summary: newClipped.length
          ? `${newClipped.length} element(s) clip their text once WCAG text-spacing is applied`
          : 'No content lost with increased text spacing',
        details: newClipped.slice(0, 25).map(s => ({ selector: s.split('|')[0], html: '', note: `clipped after spacing increase${s.includes('|') ? `: "${s.split('|')[1]}"` : ''}` })),
        totalDetails: newClipped.length
      });

      // tab pass — reload first to undo the injected CSS
      await gotoSettled(page, url);
      checks.push(...checksFromTabPass(await tabPass(page)));

      // long-animations without reduced-motion emulation
      if (!FAST) {
        await page.waitForTimeout(ANIM_WAIT);
        const anims = await page.evaluate(() => document.getAnimations()
          .filter(a => a.playState === 'running')
          .filter(a => { const t = a.effect && a.effect.getTiming(); return t && (t.iterations === Infinity || (Number(t.duration) || 0) * (Number(t.iterations) || 1) > 5000); })
          .length);
        checks.push({
          id: 'long-animations', sc: ['2.2.2'],
          status: anims ? 'review' : 'pass',
          summary: anims ? `${anims} animation(s) still running after 5s — need a pause/stop/hide control` : 'No CSS/WAAPI animations running past 5s',
          details: [], totalDetails: anims
        });
      }
      await context.close();

      // Pass 2: 320px reflow (1.4.10)
      const ctx320 = await browser.newContext({ viewport: { width: 320, height: 800 } });
      const p320 = await ctx320.newPage();
      await gotoSettled(p320, url);
      await p320.waitForTimeout(600);
      const r320 = await p320.evaluate(overflowCheck);
      checks.push({
        id: 'reflow-320', sc: ['1.4.10'],
        status: r320.overflowPx > 2 ? 'fail' : 'pass',
        summary: r320.overflowPx > 2
          ? `${r320.overflowPx}px of horizontal scroll at 320 CSS px (= 400% zoom)`
          : 'Content reflows at 320 CSS px with no horizontal scroll',
        details: r320.offenders.map(o => ({ selector: o.selector, html: o.html, note: o.note })),
        totalDetails: r320.offenders.length
      });
      await ctx320.close();

      // Pass 3: 640px ≈ 200% zoom at 1280 (1.4.4)
      const ctx640 = await browser.newContext({ viewport: { width: 640, height: 512 } });
      const p640 = await ctx640.newPage();
      await gotoSettled(p640, url);
      await p640.waitForTimeout(600);
      const r640 = await p640.evaluate(overflowCheck);
      checks.push({
        id: 'zoom-200', sc: ['1.4.4'],
        status: r640.overflowPx > 2 ? 'fail' : 'pass',
        summary: r640.overflowPx > 2
          ? `${r640.overflowPx}px horizontal overflow at 640px (≈200% zoom at 1280) — confirm with a real zoom pass`
          : 'No horizontal overflow at 200%-equivalent width',
        details: r640.offenders.map(o => ({ selector: o.selector, html: o.html, note: o.note })),
        totalDetails: r640.offenders.length
      });
      await ctx640.close();

      // Pass 4: prefers-reduced-motion (2.2.2)
      if (!FAST) {
        const ctxRM = await browser.newContext({ viewport: { width: 1280, height: 1024 }, reducedMotion: 'reduce' });
        const pRM = await ctxRM.newPage();
        await gotoSettled(pRM, url);
        await pRM.waitForTimeout(ANIM_WAIT);
        const rm = await pRM.evaluate(() => ({
          running: document.getAnimations().filter(a => a.playState === 'running')
            .filter(a => { const t = a.effect && a.effect.getTiming(); return t && (t.iterations === Infinity || (Number(t.duration) || 0) * (Number(t.iterations) || 1) > 5000); }).length,
          bodyVisible: !!document.body && document.body.getBoundingClientRect().height > 100
        }));
        checks.push({
          id: 'reduced-motion', sc: ['2.2.2'],
          status: rm.running ? 'fail' : (rm.bodyVisible ? 'pass' : 'review'),
          summary: rm.running
            ? `${rm.running} long/infinite animation(s) still run with prefers-reduced-motion enabled`
            : (rm.bodyVisible ? 'Reduced-motion preference honoured; page renders fully'
                              : 'Page appears empty under reduced motion — check content is not gated on animation'),
          details: [], totalDetails: rm.running
        });
        await ctxRM.close();
      }

      const fails = checks.filter(c => c.status === 'fail').length;
      const reviews = checks.filter(c => c.status === 'review').length;
      fs.writeFileSync(path.join(RAW_DIR, `${name}-extra.json`),
        JSON.stringify({ ...meta, checks }, null, 2));
      pageSummaries.push({ ...meta, fails, reviews, passes: checks.filter(c => c.status === 'pass').length });
      console.log(`✓ ${url} — ${fails} fail, ${reviews} review`);
    } catch (err) {
      scanErrors++;
      const message = String(err.message).split('\n')[0];
      pageSummaries.push({ url, page: name, error: message });
      console.warn(`✗ ${url} — ${message}`);
    }
  }

  await browser.close();

  const summary = {
    tool: 'extra-checks',
    generatedAt: new Date().toISOString(),
    fast: FAST,
    pages: pageSummaries,
    siteChecks: siteChecks(pageSummaries.filter(p => !p.error))
  };
  fs.writeFileSync(path.join(REPORTS_DIR, 'extra-summary.json'), JSON.stringify(summary, null, 2));

  const ok = pageSummaries.filter(p => !p.error).length;
  console.log(`\nDone: ${ok}/${urls.length} pages -> ${RAW_DIR}/<page>-extra.json + ${REPORTS_DIR}/extra-summary.json`);
  for (const c of summary.siteChecks) console.log(`  [site] ${c.id}: ${c.status} — ${c.summary}`);
  if (scanErrors) process.exitCode = 1;
})();
