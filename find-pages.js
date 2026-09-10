// Builds urls.json so the page list doesn't have to be typed by hand: from the
// site's sitemap when there is one, or by following the site's own links when
// there isn't.
//
//   node find-pages.js https://www.example.com                 # finds the sitemap itself
//   node find-pages.js https://www.example.com/sitemap.xml     # or point straight at one
//   node find-pages.js ./sitemap.xml                           # or a local file
//   node find-pages.js https://www.example.com --crawl         # skip the sitemap, follow links
//
// Plenty of sites have no sitemap — a Webflow site without the SEO sitemap
// setting turned on returns 404 for /sitemap.xml. When none is found this
// offers to crawl instead, which needs nothing from the site but working links.
//
// Previews by default and writes nothing. Add --write once the list looks right:
//
//   node find-pages.js https://www.example.com --write
//
// Options:
//   --write               write urls.json (existing file is backed up to urls.json.bak)
//   --append              merge with the current urls.json instead of replacing it
//   --include=<regex>     keep only URLs matching this pattern
//   --exclude=<regex>     drop URLs matching this pattern
//   --limit=<n>           keep at most n URLs (after include/exclude/sample)
//   --sample[=n]          keep n URLs per page template (default 1) — see below
//   --keep-query          keep query strings (they are stripped by default)
//   --host=<hostname>     rewrite every URL onto this host (see below)
//   --crawl               find pages by following links instead of a sitemap
//   --max-pages=<n>       cap on pages visited while crawling (default 150)
//   --max-sitemaps=<n>    cap on nested sitemap fetches (default 50)
//
// --host exists because a staging site's sitemap usually lists the PRODUCTION
// URLs. Webflow is the common case: https://<site>.webflow.io/sitemap.xml is
// served, but every <loc> inside points at the site's live domain. Scanning
// that list would audit production while you believed you were auditing
// staging, so a host mismatch is reported loudly and --host fixes it:
//
//   node find-pages.js https://your-site.webflow.io --host=your-site.webflow.io
//
// Handles sitemap index files (nested sitemaps), gzipped sitemaps, robots.txt
// discovery, and the usual XML entity escaping. No new dependencies: Node's own
// fetch, zlib and fs do all of it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { interactive, askYesNo, askChoice, close } = require('./ask');

const TIMEOUT_MS = Number(process.env.SITEMAP_TIMEOUT || 20000);

// ── Arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const positional = argv.filter(a => !a.startsWith('--'));

const has = name => flags.some(f => f === `--${name}` || f.startsWith(`--${name}=`));
const valueOf = (name, fallback = null) => {
  const hit = flags.find(f => f.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const KNOWN = ['write', 'append', 'include', 'exclude', 'limit', 'sample', 'keep-query', 'host', 'crawl', 'max-pages', 'max-sitemaps', 'help'];
const unknown = flags.filter(f => !KNOWN.includes(f.replace(/^--/, '').split('=')[0]));

const USAGE = `Usage: node find-pages.js <site-url | sitemap-url | local-file> [options]

  --write             write urls.json (previews only without it)
  --append            merge with the current urls.json instead of replacing it
  --include=<regex>   keep only URLs matching this pattern
  --exclude=<regex>   drop URLs matching this pattern
  --limit=<n>         keep at most n URLs
  --sample[=n]        keep n URLs per page template (default 1)
  --keep-query        keep query strings (stripped by default)
  --host=<hostname>   rewrite every URL onto this host (for staging sitemaps
                      that list production URLs, e.g. Webflow's *.webflow.io)
  --crawl             find pages by following the site's links, for sites with
                      no sitemap (offered automatically when none is found)
  --max-pages=<n>     cap on pages visited while crawling (default 150)
  --max-sitemaps=<n>  cap on nested sitemap fetches (default 50)

Examples:
  node find-pages.js https://www.example.com
  node find-pages.js https://www.example.com --exclude='/tag/|/author/' --write
  node find-pages.js https://www.example.com --sample --limit=25 --write
  node find-pages.js https://site.webflow.io --host=site.webflow.io --write`;

if (has('help') || !positional.length) {
  console.log(USAGE);
  process.exit(positional.length ? 0 : 1);
}
if (unknown.length) {
  console.error(`✗ Unknown option(s): ${unknown.join(', ')}\n`);
  console.error(USAGE);
  process.exit(1);
}

const source = positional[0];
const WRITE = has('write');
const APPEND = has('append');
const KEEP_QUERY = has('keep-query');
const MAX_SITEMAPS = Number(valueOf('max-sitemaps', 50));
const CRAWL = has('crawl');
const MAX_PAGES = Number(valueOf('max-pages', 150));
const LIMIT = valueOf('limit') ? Number(valueOf('limit')) : null;
const SAMPLE = has('sample') ? Number(valueOf('sample', 1)) : null;

// Accepts a bare hostname, host:port, or a full origin — whichever the user types.
let REWRITE = null;
if (has('host')) {
  const raw = (valueOf('host') || '').trim();
  if (!raw) {
    console.error('✗ --host needs a hostname, e.g. --host=your-site.webflow.io');
    process.exit(1);
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    REWRITE = { host: parsed.host, protocol: /^https?:\/\//i.test(raw) ? parsed.protocol : null };
  } catch (e) {
    console.error(`✗ --host is not a valid hostname: ${raw}`);
    process.exit(1);
  }
}

for (const [label, value] of [['--limit', LIMIT], ['--sample', SAMPLE],
  ['--max-sitemaps', MAX_SITEMAPS], ['--max-pages', MAX_PAGES]]) {
  if (value !== null && (!Number.isFinite(value) || value < 1)) {
    console.error(`✗ ${label} needs a positive whole number.`);
    process.exit(1);
  }
}

let include = null;
let exclude = null;
try {
  if (valueOf('include')) include = new RegExp(valueOf('include'));
  if (valueOf('exclude')) exclude = new RegExp(valueOf('exclude'));
} catch (err) {
  console.error(`✗ Invalid regular expression: ${err.message}`);
  process.exit(1);
}

// ── Fetching ─────────────────────────────────────────────────────────────────
function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');   // last, so &amp;lt; does not become <
}

function gunzipIfNeeded(buffer, label) {
  // gzip magic number, in case a .gz body arrives without the extension.
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buffer);
    } catch (err) {
      throw new Error(`could not decompress ${label}: ${err.message}`);
    }
  }
  return buffer;
}

async function read(location) {
  if (/^https?:\/\//i.test(location)) {
    let res;
    try {
      res = await fetch(location, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'a11y-audit-toolkit sitemap reader' }
      });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError'
        ? `timed out after ${TIMEOUT_MS}ms fetching ${location}`
        : `could not fetch ${location} — ${err.message}`);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${location}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return gunzipIfNeeded(buf, location).toString('utf8');
  }

  const file = path.resolve(location);
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  return gunzipIfNeeded(fs.readFileSync(file), file).toString('utf8');
}

// ── Sitemap discovery ────────────────────────────────────────────────────────
// A bare site URL is the common case, so look where sitemaps actually live
// rather than making the user find the path.
async function discover(siteUrl) {
  const origin = new URL(siteUrl).origin;
  const found = [];

  try {
    const robots = await read(`${origin}/robots.txt`);
    for (const line of robots.split('\n')) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) found.push(m[1].trim());
    }
    if (found.length) {
      console.log(`Found ${found.length} sitemap(s) declared in robots.txt.`);
      return found;
    }
  } catch (e) {
    // robots.txt is optional; fall through to the conventional locations.
  }

  for (const candidate of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.xml.gz']) {
    try {
      const body = await read(origin + candidate);
      if (/<(urlset|sitemapindex)\b/i.test(body)) {
        console.log(`Found ${origin}${candidate}.`);
        return [origin + candidate];
      }
    } catch (e) { /* try the next one */ }
  }

  throw new Error(`no sitemap found for ${origin}. Checked robots.txt, /sitemap.xml, `
    + `/sitemap_index.xml, /sitemap-index.xml and /sitemap.xml.gz.\n`
    + `  If the sitemap lives elsewhere, pass its URL directly.`);
}

// ── Parsing ──────────────────────────────────────────────────────────────────
function locsIn(xml) {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map(m => decodeEntities(m[1]).trim())
    .filter(Boolean);
}

const isIndex = xml => /<sitemapindex\b/i.test(xml);

// Walks sitemap indexes depth-first, guarding against loops and runaway fan-out.
async function collect(entryPoints) {
  const queue = [...entryPoints];
  const seenSitemaps = new Set();
  const urls = [];
  const errors = [];
  let fetched = 0;

  while (queue.length) {
    const location = queue.shift();
    if (seenSitemaps.has(location)) continue;
    seenSitemaps.add(location);

    if (fetched >= MAX_SITEMAPS) {
      console.warn(`⚠ Stopped after ${MAX_SITEMAPS} sitemaps (--max-sitemaps). `
        + `${queue.length + 1} not read — the list below is incomplete.`);
      break;
    }

    let xml;
    try {
      xml = await read(location);
      fetched++;
    } catch (err) {
      console.warn(`⚠ Skipped ${location} — ${err.message}`);
      errors.push(err.message);
      continue;
    }

    const locs = locsIn(xml);
    if (isIndex(xml)) {
      console.log(`  index: ${location} → ${locs.length} nested sitemap(s)`);
      queue.push(...locs);
    } else {
      console.log(`  pages: ${location} → ${locs.length} URL(s)`);
      urls.push(...locs);
    }
  }

  return { urls, errors, fetched };
}

// ── Shaping the list ─────────────────────────────────────────────────────────
function normalise(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (REWRITE) {
    url.host = REWRITE.host;
    if (REWRITE.protocol) url.protocol = REWRITE.protocol;
  }
  url.hash = '';
  if (!KEEP_QUERY) url.search = '';
  // Trailing slashes are the most common source of duplicate entries.
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

// Groups URLs by page template: everything but the last path segment. So
// /post/a and /post/b share a group, while /about sits on its own. Accessibility
// failures are usually template-level, so one page per template is a legitimate
// scope decision -- but it IS a decision, so it is opt-in and reported.
const HOMEPAGE_TEMPLATE = '/ (homepage)';

function templateOf(u) {
  const { pathname } = new URL(u);
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length) return HOMEPAGE_TEMPLATE;
  if (segments.length === 1) return `/${segments[0]}`;
  return `/${segments.slice(0, -1).join('/')}/*`;
}

function sampleByTemplate(urls, perTemplate) {
  const groups = new Map();
  for (const u of urls) {
    const key = templateOf(u);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }

  // Selection order matters when --limit trims the result: take the homepage
  // first, then the largest templates, so a small limit lands on the pages that
  // represent the most of the site rather than whatever sorts first.
  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === HOMEPAGE_TEMPLATE) return -1;
    if (b[0] === HOMEPAGE_TEMPLATE) return 1;
    return b[1].length - a[1].length;
  });

  const kept = [];
  const report = [];
  for (const [key, members] of ordered) {
    kept.push(...members.slice(0, perTemplate));
    report.push({ template: key, total: members.length, kept: Math.min(perTemplate, members.length) });
  }
  return { kept, report };
}

// ── Crawling, for sites with no sitemap ──────────────────────────────────────
// Follows the site's own links from the starting page, breadth-first, staying on
// the same origin. Needs nothing from the site but working links.
//
// robots.txt is deliberately not consulted here. Every Webflow staging domain
// serves "Disallow: /", so honouring it would make this useless for exactly the
// case it exists for — auditing your own unpublished site. Use this on sites you
// are responsible for; the caps below keep it gentle either way.
const SKIP_EXTENSIONS = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|jpe?g|png|gif|svg|webp|avif|ico|mp4|webm|mov|mp3|wav|woff2?|ttf|otf|eot|js|css|json|xml|rss|txt)$/i;
const CRAWL_CONCURRENCY = 4;

function linksIn(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) {
    let raw = m[1].trim().replace(/^['"]|['"]$/g, '');
    raw = decodeEntities(raw).trim();
    if (!raw || /^(#|mailto:|tel:|javascript:|data:|sms:)/i.test(raw)) continue;
    try {
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      out.push(u);
    } catch (e) { /* an unparseable href is not a page */ }
  }
  return out;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'a11y-audit-toolkit page finder' }
  });
  if (!res.ok) return { ok: false, why: `${res.status} ${res.statusText}` };
  const type = res.headers.get('content-type') || '';
  // Only HTML has links worth following, and only HTML is a page to audit.
  if (!/text\/html|application\/xhtml/i.test(type)) return { ok: false, why: `not HTML (${type.split(';')[0]})` };
  return { ok: true, html: await res.text(), finalUrl: res.url || url };
}

async function crawl(startUrl) {
  const origin = new URL(startUrl).origin;
  const queued = new Set([new URL(startUrl).toString()]);
  const found = [];
  const failures = [];
  let frontier = [new URL(startUrl).toString()];

  console.log(`Crawling ${origin} (following links, up to ${MAX_PAGES} pages)…`);

  while (frontier.length && found.length < MAX_PAGES) {
    // Small batches: enough to be quick, few enough to stay polite.
    const batch = frontier.splice(0, CRAWL_CONCURRENCY);
    const next = [];

    await Promise.all(batch.map(async (url) => {
      if (found.length >= MAX_PAGES) return;
      let result;
      try {
        result = await fetchHtml(url);
      } catch (err) {
        failures.push(`${url} — ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
        return;
      }
      if (!result.ok) {
        failures.push(`${url} — ${result.why}`);
        return;
      }

      found.push(url);
      if (found.length % 10 === 0) console.log(`  …${found.length} pages so far`);

      for (const link of linksIn(result.html, url)) {
        if (link.origin !== origin) continue;               // same site only
        if (SKIP_EXTENSIONS.test(link.pathname)) continue;   // assets, not pages
        const key = link.toString();
        if (queued.has(key)) continue;
        queued.add(key);
        next.push(key);
      }
    }));

    frontier.push(...next);
  }

  console.log(`  ${found.length} page(s) reached.`);
  if (frontier.length && found.length >= MAX_PAGES) {
    console.log(`  ⚠ Stopped at the ${MAX_PAGES}-page cap with ${frontier.length} link(s) still unvisited.`);
    console.log(`    The list is incomplete — raise it with --max-pages=<n> if you need all of them.`);
  }
  if (failures.length) {
    console.log(`  ${failures.length} link(s) skipped (not a page, or would not load):`);
    for (const f of failures.slice(0, 5)) console.log(`      ${f}`);
    if (failures.length > 5) console.log(`      …and ${failures.length - 5} more`);
  }
  // A page unreachable by links is a page this cannot find — say so once, here,
  // rather than letting an incomplete list look authoritative later.
  console.log(`  Note: only pages reachable by following links are found. Anything`);
  console.log(`  unlinked (or behind a login) has to be added to urls.json by hand.`);
  return found;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const isWebAddress = /^https?:\/\//i.test(source);

// A site with no sitemap is common, not exceptional, so it must not be a dead
// end: offer the crawl instead of printing an error and stopping.
async function crawlFallback(reason) {
  if (!isWebAddress) return null;   // nothing to crawl from a local file
  console.log(`\n${reason}`);

  if (!CRAWL) {
    if (!interactive) {
      console.error(`\n✗ No sitemap, and not running in a terminal so this cannot be asked.`);
      console.error(`  Re-run following the site's links instead:`);
      console.error(`    node find-pages.js ${source} --crawl --write`);
      process.exit(1);
    }
    const go = await askYesNo(
      `\nFind the pages by following the site's links instead?`, true);
    if (!go) {
      console.log(`\nNothing found, so nothing saved.`);
      console.log(`You can list the pages by hand in urls.json — urls.example.json shows the shape.`);
      close();
      process.exit(1);
    }
  }
  console.log('');
  return crawl(source);
}

(async () => {
  let entryPoints = null;
  let found = null;
  let usedCrawl = false;

  if (CRAWL && isWebAddress) {
    // Explicitly asked for: skip the sitemap entirely.
    console.log('');
    found = await crawl(source);
    usedCrawl = true;
  } else {
    try {
      if (isWebAddress && !/\.xml(\.gz)?$/i.test(source) && !/sitemap/i.test(source)) {
        console.log(`Looking for a sitemap on ${source}…`);
        entryPoints = await discover(source);
      } else {
        entryPoints = [source];
      }
    } catch (err) {
      found = await crawlFallback(`✗ ${err.message}`);
      usedCrawl = found !== null;
      if (!found) {
        console.error(`✗ ${err.message}`);
        process.exit(1);
      }
    }
  }

  if (found === null) {
    console.log('\nReading sitemaps:');
    let readErrors, fetchedCount;
    try {
      const result = await collect(entryPoints);
      found = result.urls;
      readErrors = result.errors;
      fetchedCount = result.fetched;
    } catch (err) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }

    // Nothing readable at all is a different problem from a readable file with
    // no URLs in it, and saying "is that really a sitemap?" for a 404 sends the
    // user looking in the wrong place.
    if (!fetchedCount) {
      const detail = readErrors.map(m => `    ${m}`).join('\n');
      found = await crawlFallback(`✗ Could not read any sitemap:\n${detail}`);
      usedCrawl = found !== null;
      if (!found) {
        console.error(`\n✗ Could not read any sitemap:\n${detail}`);
        process.exit(1);
      }
    } else if (!found.length) {
      found = await crawlFallback('✗ No <loc> entries found in the sitemap(s) read.');
      usedCrawl = found !== null;
      if (!found) {
        console.error('\n✗ No <loc> entries found in the sitemap(s) read. Is that really a sitemap?');
        process.exit(1);
      }
    }
  }

  if (!found.length) {
    console.error('\n✗ No pages found.');
    process.exit(1);
  }

  const startCount = found.length;
  let urls = [...new Set(found.map(normalise).filter(Boolean))];
  const afterDedupe = urls.length;

  if (include) urls = urls.filter(u => include.test(u));
  if (exclude) urls = urls.filter(u => !exclude.test(u));
  const afterFilters = urls.length;

  urls.sort();

  let sampleReport = null;
  if (SAMPLE) {
    const result = sampleByTemplate(urls, SAMPLE);
    urls = result.kept;          // ordered homepage-first, then biggest templates
    sampleReport = result.report;
  }

  const beforeLimit = urls.length;
  if (LIMIT && urls.length > LIMIT) urls = urls.slice(0, LIMIT);

  // Readable order in the file; selection order has already done its job above.
  urls.sort();

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${usedCrawl ? 'Found by crawling:  ' : 'Found in sitemap(s): '} ${String(startCount).padStart(4)}`);
  console.log(`After de-duplication:  ${afterDedupe}`);
  if (include || exclude) console.log(`After include/exclude: ${afterFilters}`);
  if (SAMPLE) console.log(`After --sample=${SAMPLE}:${' '.repeat(Math.max(1, 9 - String(SAMPLE).length))}${beforeLimit}`);
  if (LIMIT) console.log(`After --limit=${LIMIT}:${' '.repeat(Math.max(1, 10 - String(LIMIT).length))}${urls.length}`);
  console.log(`${'─'.repeat(60)}`);

  if (sampleReport) {
    console.log('\nTemplates sampled (one row per page template):');
    for (const r of sampleReport.sort((a, b) => b.total - a.total)) {
      const note = r.total > r.kept ? `  ← ${r.total - r.kept} page(s) NOT audited` : '';
      console.log(`  ${r.kept}/${r.total}  ${r.template}${note}`);
    }
    console.log('\n⚠ Sampling narrows the audit scope: pages left out are not audited, and');
    console.log('  their content differences (image counts, headings, contrast) will not be');
    console.log('  measured. Use it to scope a first pass, not to declare a site covered.');
  }

  if (!urls.length) {
    console.error('\n✗ Nothing left after filtering — loosen --include/--exclude.');
    process.exit(1);
  }

  // A staging sitemap that lists production URLs is the single most dangerous
  // thing this script can hand over: the list looks right, and the audit silently
  // measures the wrong site. Never let that pass without saying so.
  const hosts = [...new Set(urls.map(u => new URL(u).host))];
  // A crawl only ever returns same-origin URLs, so a mismatch is impossible
  // there; only a sitemap can list a different host.
  let sourceHost = null;
  if (!usedCrawl && isWebAddress) {
    try {
      sourceHost = new URL(source).host;
    } catch (e) { /* not an address we can compare against */ }
  }

  if (sourceHost && !hosts.includes(sourceHost)) {
    console.log(`\n${'!'.repeat(64)}`);
    console.log(`These pages are on a different address than the one you gave.`);
    console.log(`${'!'.repeat(64)}`);
    console.log(`  You asked about:     ${sourceHost}`);
    console.log(`  The sitemap lists:   ${hosts.join(', ')}`);
    console.log(`\n  This is normal for a staging site: its sitemap lists the LIVE addresses.`);
    console.log(`  Which site do you want to check?\n`);

    if (interactive) {
      const choice = await askChoice('', [
        { label: sourceHost, hint: `the address you gave (usually the staging or test site)` },
        { label: hosts[0], hint: `what the sitemap lists (usually the live site)` }
      ], 0);

      if (choice === 0) {
        // Re-normalise onto the host the user actually wants to check.
        REWRITE = { host: sourceHost, protocol: new URL(source).protocol };
        urls = [...new Set(urls.map(normalise).filter(Boolean))].sort();
        console.log(`\n✓ Using ${sourceHost}.`);
      } else {
        console.log(`\n✓ Using ${hosts[0]}.`);
      }
    } else {
      // Non-interactive: cannot ask, so must not guess.
      console.log(`  Not running in a terminal, so this cannot be asked. Re-run with the`);
      console.log(`  address you want, e.g.:`);
      console.log(`    node find-pages.js ${source} --host=${sourceHost} --write`);
      console.log(`  Continuing with the addresses the sitemap lists (${hosts[0]}).`);
    }
  } else if (REWRITE) {
    console.log(`\n✓ Every URL rewritten onto ${REWRITE.host}.`);
  }

  const preview = urls.slice(0, 15);
  console.log(`\nPages (${urls.length}):`);
  for (const u of preview) console.log(`  ${u}`);
  if (urls.length > preview.length) console.log(`  … and ${urls.length - preview.length} more`);

  // ── Write ─────────────────────────────────────────────────────────────────
  const target = './urls.json';

  let write = WRITE;
  if (!write) {
    if (interactive) {
      write = await askYesNo(`\nSave these ${urls.length} page(s) as the list to audit?`, true);
      if (!write) {
        console.log('Nothing saved — urls.json is unchanged.');
        close();
        return;
      }
    } else {
      console.log(`\nPreview only — urls.json was not touched.`);
      console.log(`Re-run with --write to save these ${urls.length} page(s).`);
      return;
    }
  }

  let final = urls;
  if (APPEND && fs.existsSync(target)) {
    try {
      const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (Array.isArray(existing)) {
        const merged = [...new Set([...existing, ...urls])];
        console.log(`\nAppending: ${existing.length} existing + ${urls.length} from sitemap `
          + `= ${merged.length} unique.`);
        final = merged;
      }
    } catch (err) {
      console.warn(`⚠ Could not read existing urls.json (${err.message}) — writing the sitemap list alone.`);
    }
  }

  // Never overwrite a hand-curated list without leaving a way back.
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, 'utf8');
    if (current.trim() && current.trim() !== '[]') {
      fs.writeFileSync(`${target}.bak`, current);
      console.log(`Previous urls.json backed up to urls.json.bak`);
    }
  }

  fs.writeFileSync(target, JSON.stringify(final, null, 2) + '\n');
  console.log(`\n✓ Saved ${final.length} page(s) to urls.json`);
  console.log(`\nNext:  npm start`);
  close();
})();
