// Shared browser-engine handling for every Playwright-driven script in this toolkit.
//
// Engine selection (first match wins):
//   --browsers=firefox,webkit   (also --browser=, --browsers firefox webkit, --all)
//   BROWSERS=firefox,webkit     (env var)
//   default: all three engines
const playwright = require('playwright');

const ENGINES = [
  { key: 'chromium', label: 'Chromium',        aliases: ['chrome', 'edge', 'msedge', 'blink'] },
  { key: 'firefox',  label: 'Firefox',         aliases: ['ff', 'gecko', 'mozilla'] },
  { key: 'webkit',   label: 'WebKit (Safari)', aliases: ['safari', 'wk'] }
];

const ENGINE_KEYS = ENGINES.map(e => e.key);

function engineByName(name) {
  const n = String(name).trim().toLowerCase();
  return ENGINES.find(e => e.key === n || e.aliases.includes(n)) || null;
}

function labelFor(key) {
  const engine = engineByName(key);
  return engine ? engine.label : key;
}

function parseList(value) {
  return String(value).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

function requestedNames(argv) {
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const inline = arg.match(/^--browsers?=(.*)$/);
    if (inline) { names.push(...parseList(inline[1])); continue; }
    if (arg === '--browser' || arg === '--browsers') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) names.push(...parseList(argv[++i]));
      continue;
    }
    if (arg === '--all') names.push('all');
  }
  if (!names.length && process.env.BROWSERS) names.push(...parseList(process.env.BROWSERS));
  return names;
}

// Returns engine objects in canonical order (chromium, firefox, webkit).
function resolveEngines(argv = process.argv.slice(2)) {
  const names = requestedNames(argv);
  if (!names.length || names.some(n => n.toLowerCase() === 'all' || n === '*')) return ENGINES.slice();

  const picked = [];
  const unknown = [];
  for (const name of names) {
    const engine = engineByName(name);
    if (!engine) unknown.push(name);
    else if (!picked.includes(engine)) picked.push(engine);
  }
  if (unknown.length) {
    throw new Error(
      `Unknown browser(s): ${unknown.join(', ')}\n` +
      `  Valid values: ${ENGINE_KEYS.join(', ')}, all (aliases: chrome, safari, ff, ...)`
    );
  }
  return ENGINES.filter(e => picked.includes(e));
}

async function launchEngine(engine, options = {}) {
  try {
    return await playwright[engine.key].launch(options);
  } catch (err) {
    const first = String(err.message).split('\n')[0];
    const wrapped = new Error(
      `could not launch ${engine.label}: ${first}\n` +
      `  Install the browser once with:  npx playwright install ${engine.key}`
    );
    wrapped.engineKey = engine.key;
    wrapped.cause = err;
    throw wrapped;
  }
}

// page.pdf() is Chromium-only in Playwright, so every HTML -> PDF step renders
// in Chromium regardless of which engines were used for the scan itself.
async function launchPdfRenderer(options = {}) {
  try {
    return await playwright.chromium.launch(options);
  } catch (err) {
    const first = String(err.message).split('\n')[0];
    throw new Error(
      `could not launch Chromium for PDF rendering: ${first}\n` +
      `  Playwright can only generate PDFs from Chromium (page.pdf() is unsupported in\n` +
      `  Firefox and WebKit), so Chromium is required even for Firefox/WebKit scans.\n` +
      `  Install it once with:  npx playwright install chromium`
    );
  }
}

// URL -> file-name stem, e.g. https://example.com/about -> example.com_about
function pageName(url) {
  return url.replace(/https?:\/\//, '').replace(/\/$/, '').replace(/\//g, '_') || 'home';
}

// Splits "<base>-<tool>-<engine>.<ext>" (and legacy "<base>-<tool>.<ext>",
// which predates multi-browser support and is treated as Chromium).
function parseToolFilename(file, tool, ext) {
  const re = new RegExp(`^(.*)-${tool}(?:-(${ENGINE_KEYS.join('|')}))?\\.${ext}$`);
  const match = file.match(re);
  if (!match) return null;
  return { base: match[1], engineKey: match[2] || 'chromium', legacy: !match[2] };
}

module.exports = {
  ENGINES,
  ENGINE_KEYS,
  engineByName,
  labelFor,
  resolveEngines,
  launchEngine,
  launchPdfRenderer,
  pageName,
  parseToolFilename
};
