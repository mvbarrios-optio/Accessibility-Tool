// console-snippet.js — in-page accessibility checks you run from DevTools.
//
// WHEN TO USE THIS instead of extra-checks.js:
//   - Pages behind a login, or states the crawler can't reach (open modal,
//     mobile menu expanded, form error state, cookie banner visible).
//   - Quick spot checks while developing, without leaving the browser.
//
// HOW TO USE:
//   1. Open the target page in Chrome, in the exact state you want to audit.
//   2. Open DevTools > Console.
//   3. Copy everything from "COPY FROM HERE" to the end of this file, paste, Enter.
//   4. The results JSON is printed AND copied to your clipboard (DevTools `copy()`).
//   5. Save it as: audits/raw/<page>-snippet.json
//      (<page> = URL without protocol, slashes -> underscores, site root = the
//       host name — the same convention as every other tool in this kit.
//       The snippet prints the exact filename to use.)
//   6. generate-report.js picks these files up automatically.
//
// It checks: lang (3.1.1), viewport meta (1.4.4), headings (1.3.1/2.4.6),
// landmarks (1.3.1/2.4.1), img alt inventory (1.1.1/1.4.5), vague link text
// (2.4.4), label-in-name (2.5.3), placeholder-only labels (3.3.2),
// autocomplete (1.3.5), target size (2.5.8), positive tabindex (2.4.3),
// autoplay media (1.4.2/2.2.2), meta refresh (2.2.1), media inventory
// (1.2.x), live regions (4.1.3), outline:none in CSS (2.4.7),
// undifferentiated body links (1.4.1), long animations (2.2.2).
//
// ───────────────────────── COPY FROM HERE ─────────────────────────
(() => {
  const checks = [];
  const short = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const sel = el => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${el.id}`;
    let p = el.tagName.toLowerCase();
    const cls = (el.className && typeof el.className === 'string')
      ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    if (cls) p += '.' + cls;
    return p;
  };
  const visible = el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const detail = (el, note, extra) => Object.assign({ selector: sel(el), html: short(el.outerHTML), note }, extra || {});
  const push = (id, sc, status, details, summary) =>
    checks.push({ id, sc, status, summary, details: details.slice(0, 25), totalDetails: details.length });

  // lang (3.1.1)
  {
    const lang = document.documentElement.getAttribute('lang') || '';
    const ok = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(lang);
    push('lang', ['3.1.1'], ok ? 'pass' : 'fail',
      ok ? [] : [{ selector: 'html', html: '', note: lang ? `invalid lang="${lang}"` : 'missing lang attribute' }],
      ok ? `lang="${lang}"` : 'html lang missing or invalid');
  }

  // viewport-meta (1.4.4)
  {
    const m = document.querySelector('meta[name="viewport"]');
    const c = (m && m.getAttribute('content') || '').toLowerCase();
    const maxScale = c.match(/maximum-scale\s*=\s*([\d.]+)/);
    const blocked = /user-scalable\s*=\s*(no|0)/.test(c) || (maxScale && parseFloat(maxScale[1]) < 2);
    push('viewport-meta', ['1.4.4'], blocked ? 'fail' : 'pass',
      blocked ? [detail(m, `viewport meta blocks zoom: "${c}"`)] : [],
      blocked ? 'Zoom blocked by viewport meta' : 'Viewport meta OK');
  }

  // headings (1.3.1 / 2.4.6)
  {
    const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].map(el => ({
      el,
      level: el.matches('[role="heading"]') ? Number(el.getAttribute('aria-level') || 2) : Number(el.tagName[1]),
      text: short(el.textContent)
    }));
    const issues = [];
    const h1s = hs.filter(h => h.level === 1);
    if (!h1s.length) issues.push({ selector: 'html', html: '', note: 'no h1' });
    if (h1s.length > 1) h1s.slice(1).forEach(h => issues.push(detail(h.el, 'more than one h1')));
    let prev = 0;
    for (const h of hs) {
      if (prev && h.level > prev + 1) issues.push(detail(h.el, `skipped level: h${prev} -> h${h.level}`));
      if (!h.text) issues.push(detail(h.el, 'empty heading'));
      prev = h.level;
    }
    push('headings', ['1.3.1', '2.4.6'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? `${issues.length} heading issue(s)` : `Outline OK (${hs.length} headings)`);
    checks[checks.length - 1].outline = hs.map(h => `${'  '.repeat(h.level - 1)}h${h.level}: ${h.text}`);
  }

  // landmarks (1.3.1 / 2.4.1)
  {
    const mains = document.querySelectorAll('main, [role="main"]');
    const issues = [];
    if (!mains.length) issues.push({ selector: 'body', html: '', note: 'no <main> landmark' });
    if (mains.length > 1) issues.push({ selector: 'body', html: '', note: `${mains.length} main landmarks` });
    const missing = [];
    if (!document.querySelector('header, [role="banner"]')) missing.push('banner');
    if (!document.querySelector('nav, [role="navigation"]')) missing.push('nav');
    if (!document.querySelector('footer, [role="contentinfo"]')) missing.push('contentinfo');
    if (missing.length) issues.push({ selector: 'body', html: '', note: `missing landmarks: ${missing.join(', ')}` });
    push('landmarks', ['1.3.1', '2.4.1'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? issues.map(i => i.note).join('; ') : 'All key landmarks present');
  }

  // img-alt inventory (1.1.1 / 1.4.5) — for HUMAN review of alt quality
  {
    const imgs = [...document.querySelectorAll('img, [role="img"], svg')].filter(visible);
    const issues = [];
    const inventory = [];
    for (const img of imgs) {
      const alt = img.getAttribute('alt');
      const name = alt !== null ? alt : (img.getAttribute('aria-label') || (img.getAttribute('aria-labelledby') ? '(labelledby)' : null));
      inventory.push({ selector: sel(img), alt: name === null ? '(MISSING)' : (name || '(empty/decorative)') });
      if (img.tagName === 'IMG' && alt === null) issues.push(detail(img, 'img with no alt attribute'));
      else if (alt && /\.(png|jpe?g|gif|webp|svg)\b/i.test(alt)) issues.push(detail(img, `filename used as alt: "${alt}"`));
      else if (alt && /^(image|photo|picture|icon|img|logo)$/i.test(alt.trim())) issues.push(detail(img, `generic alt: "${alt}"`));
    }
    push('img-alt', ['1.1.1'], issues.length ? 'fail' : 'review', issues,
      `${imgs.length} image(s); ${issues.length} obvious alt problem(s). Review the inventory for wrong/unhelpful alt text.`);
    checks[checks.length - 1].inventory = inventory.slice(0, 60);
  }

  // vague-links (2.4.4)
  {
    // Link text that says nothing out of context. Multilingual (en, es, fr, de,
    // pt, it) so the check is not silently useless on a non-English site.
    const vague = new RegExp('^(' + [
      'read more', 'learn more', 'click here', 'more', 'here', 'details',
      'see more', 'view', 'link', 'continue', 'go',
      'leer m[a\u00e1]s', 'ver m[a\u00e1]s', 'aqu[i\u00ed]', 'm[a\u00e1]s info(rmaci[o\u00f3]n)?',
      'en savoir plus', 'lire la suite', 'cliquez ici', 'ici', 'plus',
      'mehr', 'weiterlesen', 'hier klicken', 'hier', 'mehr erfahren',
      'saiba mais', 'leia mais', 'clique aqui', 'ver mais',
      'per saperne di pi[u\u00f9]', 'clicca qui', 'leggi tutto'
    ].join('|') + ')\\.?$', 'i');
    const issues = [...document.querySelectorAll('a[href]')].filter(visible).filter(a => {
      const name = (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim();
      return vague.test(name);
    }).map(a => detail(a, `vague link text: "${short(a.textContent)}" -> ${a.getAttribute('href')}`));
    push('vague-links', ['2.4.4'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? `${issues.length} vague link(s)` : 'No vague link text found');
  }

  // label-in-name (2.5.3)
  {
    const issues = [];
    for (const el of document.querySelectorAll('a[href][aria-label], button[aria-label], [role="button"][aria-label], [role="link"][aria-label]')) {
      const visibleText = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const name = (el.getAttribute('aria-label') || '').toLowerCase();
      if (visibleText && name && !name.includes(visibleText)) {
        issues.push(detail(el, `visible text "${short(el.textContent)}" not contained in aria-label "${short(el.getAttribute('aria-label'))}"`));
      }
    }
    push('label-in-name', ['2.5.3'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? `${issues.length} control(s) whose accessible name drops the visible label` : 'aria-labels include visible text');
  }

  // placeholder-label (3.3.2)
  {
    const issues = [];
    for (const inp of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select')) {
      if (!visible(inp)) continue;
      const hasVisibleLabel = inp.labels && [...inp.labels].some(l => visible(l) && l.textContent.trim());
      const hasAria = inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby');
      if (!hasVisibleLabel && inp.getAttribute('placeholder')) {
        issues.push(detail(inp, hasAria ? 'placeholder + aria-label only — needs a persistent VISIBLE label' : 'placeholder is the only label'));
      } else if (!hasVisibleLabel && !hasAria && !inp.getAttribute('placeholder')) {
        issues.push(detail(inp, 'form control with no label at all'));
      }
    }
    push('placeholder-label', ['3.3.2'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? `${issues.length} field(s) without a visible persistent label` : 'All fields have visible labels');
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
      if (!visible(inp) || inp.getAttribute('autocomplete')) continue;
      const label = inp.labels && inp.labels[0] ? inp.labels[0].textContent : '';
      const hint = `${inp.name} ${inp.id} ${inp.type} ${label} ${inp.getAttribute('placeholder') || ''}`;
      if (inp.type === 'email') { issues.push(detail(inp, 'missing autocomplete="email"')); continue; }
      for (const [re, token] of tokens) {
        if (re.test(hint)) { issues.push(detail(inp, `likely missing autocomplete="${token}"`)); break; }
      }
    }
    push('autocomplete', ['1.3.5'], issues.length ? 'review' : 'pass', issues,
      issues.length ? `${issues.length} field(s) likely missing autocomplete` : 'No personal-data fields missing autocomplete');
  }

  // target-size (2.5.8)
  {
    const candidates = [...document.querySelectorAll(
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [role="button"], [role="link"], [onclick], [tabindex]:not([tabindex="-1"])'
    )].filter(visible);
    const centers = candidates.map(el => {
      const r = el.getBoundingClientRect();
      return { el, r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    const issues = [];
    for (const c of centers) {
      if (c.r.width >= 24 && c.r.height >= 24) continue;
      const st = getComputedStyle(c.el);
      if (c.el.tagName === 'A' && st.display.startsWith('inline')) {
        const parentText = (c.el.parentElement && c.el.parentElement.textContent.trim().length) || 0;
        if (parentText > c.el.textContent.trim().length + 3) continue;
      }
      let crowded = false;
      for (const o of centers) {
        if (o.el !== c.el && Math.hypot(o.cx - c.cx, o.cy - c.cy) < 24) { crowded = true; break; }
      }
      issues.push(detail(c.el, `${Math.round(c.r.width)}x${Math.round(c.r.height)}px${crowded ? ' + crowded' : ' (isolated — verify spacing exception)'}`,
        { status: crowded ? 'fail' : 'review' }));
    }
    push('target-size', ['2.5.8'], issues.length ? (issues.some(i => i.status === 'fail') ? 'fail' : 'review') : 'pass',
      issues, issues.length ? `${issues.length} small target(s)` : 'All targets ≥24x24 or exempt');
  }

  // tabindex-positive (2.4.3)
  {
    const issues = [...document.querySelectorAll('[tabindex]')]
      .filter(el => Number(el.getAttribute('tabindex')) > 0)
      .map(el => detail(el, `tabindex="${el.getAttribute('tabindex')}"`));
    push('tabindex-positive', ['2.4.3', '1.3.2'], issues.length ? 'fail' : 'pass', issues,
      issues.length ? `${issues.length} positive tabindex` : 'No positive tabindex');
  }

  // autoplay-media (1.4.2 / 2.2.2) + meta-refresh (2.2.1)
  {
    const issues = [];
    for (const m of document.querySelectorAll('video, audio')) {
      const autoplays = m.hasAttribute('autoplay') || (m.readyState > 2 && !m.paused);
      if (autoplays) {
        const silent = m.muted || m.volume === 0;
        issues.push(detail(m, silent ? 'autoplaying (muted) — needs pause control if >5s' : 'autoplaying WITH AUDIO', { audible: !silent }));
      }
    }
    push('autoplay-media', ['1.4.2', '2.2.2'],
      issues.length ? (issues.some(i => i.audible) ? 'fail' : 'review') : 'pass',
      issues, issues.length ? `${issues.length} autoplaying media` : 'No autoplaying media');
    const mr = document.querySelector('meta[http-equiv="refresh" i]');
    const secs = mr ? parseInt(mr.getAttribute('content'), 10) : NaN;
    push('meta-refresh', ['2.2.1'], mr && secs > 0 ? 'fail' : 'pass',
      mr && secs > 0 ? [detail(mr, `auto refresh after ${secs}s`)] : [],
      mr && secs > 0 ? 'Timed meta refresh present' : 'No timed meta refresh');
  }

  // media-inventory (1.2.1–1.2.5) — for the manual media pass
  {
    const media = [...document.querySelectorAll('video, audio, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="player"]')];
    const inv = media.map(m => ({
      selector: sel(m),
      type: m.tagName.toLowerCase(),
      src: short(m.currentSrc || m.getAttribute('src') || ''),
      captionTracks: m.querySelectorAll ? m.querySelectorAll('track[kind="captions"], track[kind="subtitles"]').length : 0
    }));
    push('media-inventory', ['1.2.1', '1.2.2', '1.2.3', '1.2.5'], media.length ? 'review' : 'pass',
      inv.map(i => ({ selector: i.selector, html: '', note: `${i.type} src=${i.src} captionTracks=${i.captionTracks}` })),
      media.length ? `${media.length} media element(s) — run the manual 1.2.x checks on each` : 'No audio/video on this page');
  }

  // live-regions (4.1.3)
  {
    const regions = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"], output')];
    push('live-regions', ['4.1.3'], 'review',
      regions.map(r => detail(r, `live region: aria-live=${r.getAttribute('aria-live') || r.getAttribute('role')}`)),
      regions.length
        ? `${regions.length} live region(s) found — verify dynamic messages actually land inside them`
        : 'No live regions found — if this page shows dynamic status messages (form success, filters, loading), they will NOT be announced');
  }

  // outline-none (2.4.7) — CSS that kills focus outlines
  {
    const hits = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; } // cross-origin
      for (const rule of rules || []) {
        if (rule.selectorText && /:focus/.test(rule.selectorText) &&
            /outline\s*:\s*(none|0)/.test(rule.cssText) && !/box-shadow|outline-offset|border/.test(rule.cssText)) {
          hits.push({ selector: rule.selectorText.slice(0, 80), html: '', note: rule.cssText.slice(0, 120) });
        }
      }
    }
    push('outline-none', ['2.4.7'], hits.length ? 'review' : 'pass', hits,
      hits.length ? `${hits.length} CSS rule(s) remove focus outline without an obvious replacement` : 'No outline-stripping :focus rules found in readable CSS');
  }

  // body-links (1.4.1) — inline links relying on colour alone
  {
    const issues = [];
    for (const a of document.querySelectorAll('p a[href], li a[href]')) {
      if (!visible(a)) continue;
      const st = getComputedStyle(a);
      const parentText = (a.parentElement.textContent || '').trim().length;
      if (parentText <= a.textContent.trim().length + 3) continue; // link is the whole line
      if (!/underline/.test(st.textDecorationLine) && st.borderBottomStyle === 'none') {
        issues.push(detail(a, 'inline link with no underline — relies on colour alone unless contrast vs surrounding text ≥3:1 + hover cue'));
      }
    }
    push('body-links', ['1.4.1'], issues.length ? 'review' : 'pass', issues,
      issues.length ? `${issues.length} inline link(s) without underline — verify` : 'Inline links underlined or none present');
  }

  // long-animations (2.2.2)
  {
    const n = document.getAnimations ? document.getAnimations().filter(a => a.playState === 'running')
      .filter(a => { const t = a.effect && a.effect.getTiming(); return t && (t.iterations === Infinity || (Number(t.duration) || 0) * (Number(t.iterations) || 1) > 5000); }).length : 0;
    push('long-animations', ['2.2.2'], n ? 'review' : 'pass', [],
      n ? `${n} long/infinite animation(s) running — each needs pause/stop/hide` : 'No long-running animations right now');
  }

  const pageStem = (location.host + location.pathname).replace(/\/$/, '').replace(/\//g, '_');
  const result = {
    tool: 'console-snippet',
    url: location.href,
    page: pageStem,
    title: document.title,
    generatedAt: new Date().toISOString(),
    state: 'NOTE: describe the page state here if not default (e.g. "mobile menu open")',
    checks
  };
  const json = JSON.stringify(result, null, 2);
  const fails = checks.filter(c => c.status === 'fail').length;
  const reviews = checks.filter(c => c.status === 'review').length;
  console.log(`a11y snippet: ${fails} fail, ${reviews} review, ${checks.filter(c => c.status === 'pass').length} pass`);
  console.log(`Save as: audits/raw/${pageStem}-snippet.json`);
  try { copy(json); console.log('✓ JSON copied to clipboard'); }
  catch (e) {
    try { navigator.clipboard.writeText(json).then(() => console.log('✓ JSON copied to clipboard')); }
    catch (e2) { console.log(json); }
  }
  return result;
})();
