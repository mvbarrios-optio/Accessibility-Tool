// Builds urls.json from a sitemap, so the page list doesn't have to be typed by hand.
//
//   node sitemap-to-urls.js https://www.example.com                 # finds the sitemap itself
//   node sitemap-to-urls.js https://www.example.com/sitemap.xml     # or point straight at one
//   node sitemap-to-urls.js ./sitemap.xml                           # or a local file
//
// Previews by default and writes nothing. Add --write once the list looks right:
//
//   node sitemap-to-urls.js https://www.example.com --write
//
// Options:
//   --write               write urls.json (existing file is backed up to urls.json.bak)
//   --append              merge with the current urls.json instead of replacing it
//   --include=<regex>     keep only URLs matching this pattern
//   --exclude=<regex>     drop URLs matching this pattern
//   --limit=<n>           keep at most n URLs (after include/exclude/sample)
//   --sample[=n]          keep n URLs per page template (default 1) — see below
//   --keep-query          keep query strings (they are stripped by default)
//   --max-sitemaps=<n>    cap on nested sitemap fetches (default 50)
//
// Handles sitemap index files (nested sitemaps), gzipped sitemaps, robots.txt
// discovery, and the usual XML entity escaping. No new dependencies: Node's own
// fetch, zlib and fs do all of it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

const KNOWN = ['write', 'append', 'include', 'exclude', 'limit', 'sample', 'keep-query', 'max-sitemaps', 'help'];
const unknown = flags.filter(f => !KNOWN.includes(f.replace(/^--/, '').split('=')[0]));

const USAGE = `Usage: node sitemap-to-urls.js <site-url | sitemap-url | local-file> [options]

  --write             write urls.json (previews only without it)
  --append            merge with the current urls.json instead of replacing it
  --include=<regex>   keep only URLs matching this pattern
  --exclude=<regex>   drop URLs matching this pattern
  --limit=<n>         keep at most n URLs
  --sample[=n]        keep n URLs per page template (default 1)
  --keep-query        keep query strings (stripped by default)
  --max-sitemaps=<n>  cap on nested sitemap fetches (default 50)

Examples:
  node sitemap-to-urls.js https://www.example.com
  node sitemap-to-urls.js https://www.example.com --exclude='/tag/|/author/' --write
  node sitemap-to-urls.js https://www.example.com --sample --limit=25 --write`;

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
const LIMIT = valueOf('limit') ? Number(valueOf('limit')) : null;
const SAMPLE = has('sample') ? Number(valueOf('sample', 1)) : null;

for (const [label, value] of [['--limit', LIMIT], ['--sample', SAMPLE], ['--max-sitemaps', MAX_SITEMAPS]]) {
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

// ── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  let entryPoints;
  try {
    if (/^https?:\/\//i.test(source) && !/\.xml(\.gz)?$/i.test(source) && !/sitemap/i.test(source)) {
      console.log(`Looking for a sitemap on ${source}…`);
      entryPoints = await discover(source);
    } else {
      entryPoints = [source];
    }
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  console.log('\nReading sitemaps:');
  let found, readErrors, fetchedCount;
  try {
    const result = await collect(entryPoints);
    found = result.urls;
    readErrors = result.errors;
    fetchedCount = result.fetched;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  // Nothing readable at all is a different problem from a readable file with no
  // URLs in it, and saying "is that really a sitemap?" for a 404 sends the user
  // looking in the wrong place.
  if (!fetchedCount) {
    console.error(`\n✗ Could not read any sitemap:`);
    for (const message of readErrors) console.error(`    ${message}`);
    process.exit(1);
  }

  if (!found.length) {
    console.error('\n✗ No <loc> entries found in the sitemap(s) read. Is that really a sitemap?');
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
  console.log(`Found in sitemap(s):   ${startCount}`);
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

  const preview = urls.slice(0, 15);
  console.log(`\nPages (${urls.length}):`);
  for (const u of preview) console.log(`  ${u}`);
  if (urls.length > preview.length) console.log(`  … and ${urls.length - preview.length} more`);

  // ── Write ─────────────────────────────────────────────────────────────────
  const target = './urls.json';

  if (!WRITE) {
    console.log(`\nPreview only — urls.json was not touched.`);
    console.log(`Re-run with --write to save these ${urls.length} page(s).`);
    return;
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
  console.log(`\n✓ Wrote ${final.length} page(s) to urls.json`);
  console.log(`\nNext:  npm start`);
})();
