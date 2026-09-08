// Runs every automated scan in one command, for people who would rather not run
// three scripts in the right order:
//
//   npm start                      # axe (3 engines) + Lighthouse + extra checks
//   npm start -- --fast            # skip the animation waits in the extra checks
//   npm start -- --browsers=chromium   # narrow the axe pass to one engine
//   npm start -- --skip=lighthouse     # skip a step (axe | lighthouse | extra)
//
// Each step is independent: if one fails, the rest still run and the summary at
// the end says exactly which ones produced evidence and which did not. A failed
// step is never reported as a pass — the command exits non-zero.
const { spawnSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);
const has = name => args.some(a => a === `--${name}` || a.startsWith(`--${name}=`));
const valueOf = name => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const skip = (valueOf('skip') || '').split(',').map(s => s.trim()).filter(Boolean);
const browsers = valueOf('browsers');
const fast = has('fast');

// ── Check the one thing that has to be filled in by hand ─────────────────────
let urls;
try {
  urls = JSON.parse(fs.readFileSync('./urls.json', 'utf8'));
} catch (err) {
  console.error('✗ Could not read urls.json — ' + err.message);
  process.exit(1);
}
if (!Array.isArray(urls) || !urls.length) {
  console.error('✗ urls.json is empty, so there is nothing to scan.\n');
  console.error('  Open urls.json and list the pages you want audited, one URL per line.');
  console.error('  urls.example.json shows the shape. Then run `npm start` again.');
  process.exit(1);
}

const bad = urls.filter(u => typeof u !== 'string' || !/^https?:\/\//i.test(u));
if (bad.length) {
  console.error(`✗ urls.json has ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that ${bad.length === 1 ? 'is not a' : 'are not'} full URL${bad.length === 1 ? '' : 's'}:`);
  bad.slice(0, 5).forEach(u => console.error(`    ${JSON.stringify(u)}`));
  console.error('  Every entry needs the protocol, e.g. "https://www.example.com/about".');
  process.exit(1);
}

// Playwright is the dependency every step needs; a missing one means setup never ran.
if (!fs.existsSync('./node_modules/playwright')) {
  console.error('✗ Dependencies are not installed yet.\n');
  console.error('  Run this first:  npm run setup');
  process.exit(1);
}

// ── The steps ────────────────────────────────────────────────────────────────
const steps = [
  {
    key: 'axe',
    label: 'axe-core (Chromium, Firefox, WebKit)',
    command: process.execPath,
    args: ['axe-scan.js', ...(browsers ? [`--browsers=${browsers}`] : [])],
    output: 'audits/raw/<page>-axe-<engine>.json'
  },
  {
    key: 'lighthouse',
    label: 'Lighthouse accessibility score (Chromium only)',
    command: 'bash',
    args: ['lighthouse-scan.sh'],
    output: 'audits/raw/<page>-lighthouse.report.{html,json}',
    note: 'Launches a full Chrome per page, so this is the slow one.'
  },
  {
    key: 'extra',
    label: 'Extra checks — reflow, zoom, focus, target size, consistency',
    command: process.execPath,
    args: ['extra-checks.js', ...(fast ? ['--fast'] : [])],
    output: 'audits/raw/<page>-extra.json'
  }
];

const unknownSkips = skip.filter(s => !steps.some(step => step.key === s));
if (unknownSkips.length) {
  console.error(`✗ Unknown --skip value(s): ${unknownSkips.join(', ')}`);
  console.error(`  Valid values: ${steps.map(s => s.key).join(', ')}`);
  process.exit(1);
}

const planned = steps.filter(s => !skip.includes(s.key));
if (!planned.length) {
  console.error('✗ Every step was skipped — nothing to do.');
  process.exit(1);
}

console.log('Accessibility Audit Toolkit — automated scans');
console.log(`Pages:  ${urls.length}`);
console.log(`Steps:  ${planned.map(s => s.key).join(' → ')}${skip.length ? `  (skipped: ${skip.join(', ')})` : ''}`);
if (fast) console.log('Mode:   --fast (extra checks skip the ~10s/page animation waits)');
console.log(`\nThis takes roughly ${Math.max(1, Math.round(urls.length * (planned.length >= 3 ? 1.2 : 0.6)))}–${Math.max(2, Math.round(urls.length * (planned.length >= 3 ? 2.2 : 1.2)))} minutes for ${urls.length} page(s). Leave it running.`);

const results = [];

for (const [i, step] of planned.entries()) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`STEP ${i + 1} of ${planned.length} — ${step.label}`);
  if (step.note) console.log(step.note);
  console.log(`${'═'.repeat(64)}\n`);

  const res = spawnSync(step.command, step.args, { stdio: 'inherit' });

  if (res.error && res.error.code === 'ENOENT' && step.command === 'bash') {
    results.push({ ...step, ok: false, why: 'bash is not available on this machine' });
    console.error('\n✗ `bash` was not found. On Windows, run this step from Git Bash or WSL:');
    console.error('    bash lighthouse-scan.sh');
    continue;
  }
  if (res.error) {
    results.push({ ...step, ok: false, why: res.error.message });
    console.error(`\n✗ ${step.label} could not start — ${res.error.message}`);
    continue;
  }
  results.push({ ...step, ok: res.status === 0, why: `exit code ${res.status}` });
}

// ── Summary ──────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);

console.log(`\n${'═'.repeat(64)}`);
console.log('SUMMARY');
console.log(`${'═'.repeat(64)}\n`);
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`);
  console.log(`      ${r.ok ? `wrote ${r.output}` : `did not complete (${r.why})`}`);
}
for (const key of skip) console.log(`  – ${key} (skipped)`);

if (failed.length) {
  console.log(`\n⚠ ${failed.length} step(s) did not complete, so the evidence is incomplete.`);
  console.log('  Read the output above for the reason, fix it, and re-run `npm start`.');
  console.log('  A step can be re-run on its own — see the scripts in package.json.');
} else {
  console.log('\n✓ All automated scans finished. Raw evidence is in audits/raw/.');
}

console.log('\nNext steps — these two are what make the audit complete:');
console.log('  1. npm run audit:manual                 answer the keyboard / screen-reader /');
console.log('                                          judgement checks (resumable, saves as you go)');
console.log('  2. npm run report:findings -- --label "Baseline"');
console.log('                                          builds audits/reports/findings-report.md');
console.log('\nAutomated tools cover roughly 30% of WCAG 2.2 A/AA. Step 1 covers the rest —');
console.log('see COVERAGE.md for which tool verifies which criterion.\n');

// An incomplete scan set must not look like a clean pass to a script or a CI job.
if (failed.length) process.exitCode = 1;
