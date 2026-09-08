const fs = require('fs');
const path = require('path');
const { ENGINE_KEYS, pageName } = require('./browsers');

const rawDir = './audits/raw';
const reportsDir = './audits/reports';

const axeSummary = JSON.parse(fs.readFileSync(path.join(reportsDir, 'axe-summary.json')));

function lighthouseScore(url) {
  const lhPath = path.join(rawDir, `${pageName(url)}-lighthouse.report.json`);
  if (!fs.existsSync(lhPath)) return 'N/A';
  const lh = JSON.parse(fs.readFileSync(lhPath));
  return Math.round(lh.categories.accessibility.score * 100);
}

// WAVE runs once per page (it drives its own browser), so — like Lighthouse —
// these figures repeat across a page's per-engine rows.
const EMPTY_WAVE = { aim: 'N/A', errors: '', contrast: '', alerts: '' };
function waveFor(url) {
  const wavePath = path.join(rawDir, `${pageName(url)}-wave.json`);
  if (!fs.existsSync(wavePath)) return EMPTY_WAVE;
  const wave = JSON.parse(fs.readFileSync(wavePath));
  const total = name => (wave.categories || [])
    .filter(c => c.category === name)
    .reduce((sum, c) => sum + c.count, 0);
  return {
    aim: wave.aimScore,
    errors: total('Errors'),
    contrast: total('Contrast Errors'),
    alerts: total('Alerts')
  };
}

const rows = axeSummary.map(entry => {
  const wave = waveFor(entry.url);
  return {
  url: entry.url,
  // Rows written before multi-browser support had no browser field.
  browser: entry.browser || 'chromium',
  browserVersion: entry.browserVersion || '',
  axeViolations: entry.error ? 'ERROR' : entry.violations,
  axeCritical: entry.error ? 'ERROR' : entry.critical,
  axeSerious: entry.error ? 'ERROR' : entry.serious,
  lighthouseScore: lighthouseScore(entry.url),
  waveAim: wave.aim,
  waveErrors: wave.errors,
  waveContrastErrors: wave.contrast,
  waveAlerts: wave.alerts
};
});

// Stable ordering: page order from urls.json, then canonical engine order.
const urlOrder = [...new Set(axeSummary.map(e => e.url))];
rows.sort((a, b) =>
  urlOrder.indexOf(a.url) - urlOrder.indexOf(b.url) ||
  ENGINE_KEYS.indexOf(a.browser) - ENGINE_KEYS.indexOf(b.browser)
);

fs.writeFileSync(path.join(reportsDir, 'combined-summary.json'), JSON.stringify(rows, null, 2));

const header = 'URL,Browser,Browser Version,Axe Violations,Axe Critical,Axe Serious,' +
  'Lighthouse Score,WAVE AIM,WAVE Errors,WAVE Contrast Errors,WAVE Alerts';
const csv = [header]
  .concat(rows.map(r => [
    r.url, r.browser, r.browserVersion, r.axeViolations, r.axeCritical, r.axeSerious,
    r.lighthouseScore, r.waveAim, r.waveErrors, r.waveContrastErrors, r.waveAlerts
  ].join(',')))
  .join('\n');
fs.writeFileSync(path.join(reportsDir, 'combined-summary.csv'), csv + '\n');

// Cross-browser view: one row per page, axe violation count per engine, so
// engine-specific findings stand out instead of being buried in the long format.
const enginesPresent = ENGINE_KEYS.filter(key => rows.some(r => r.browser === key));
const matrix = urlOrder.map(url => {
  const wave = waveFor(url);
  const row = { url, lighthouseScore: lighthouseScore(url), waveAim: wave.aim, waveErrors: wave.errors };
  for (const key of enginesPresent) {
    const match = rows.find(r => r.url === url && r.browser === key);
    row[key] = match ? match.axeViolations : 'N/A';
  }
  return row;
});
const matrixCsv = [['URL', ...enginesPresent.map(k => `Axe Violations (${k})`),
  'Lighthouse Score', 'WAVE AIM', 'WAVE Errors'].join(',')]
  .concat(matrix.map(r => [r.url, ...enginesPresent.map(k => r[k]),
    r.lighthouseScore, r.waveAim, r.waveErrors].join(',')))
  .join('\n');
fs.writeFileSync(path.join(reportsDir, 'browser-comparison.csv'), matrixCsv + '\n');

console.log(`✓ Combined report written to ${reportsDir}/ (engines: ${enginesPresent.join(', ') || 'none'})`);
