// Runs every automated scan in one command, and asks for whatever it needs
// rather than expecting flags to be assembled by hand:
//
//   npm start                          # asks for the site if no list exists yet
//   npm start -- --fast                # skip the animation waits in the extra checks
//   npm start -- --browsers=chromium   # narrow the axe pass to one engine
//   npm start -- --skip=lighthouse     # skip a step (axe | lighthouse | extra)
//
// Each step is independent: if one fails, the rest still run and the summary at
// the end says exactly which ones produced evidence and which did not. A failed
// step is never reported as a pass — the command exits non-zero.
const { spawnSync } = require('child_process');
const fs = require('fs');
const { interactive, ask, askYesNo, close, release } = require('./ask');

const args = process.argv.slice(2);
const has = name => args.some(a => a === `--${name}` || a.startsWith(`--${name}=`));
const valueOf = name => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const skip = (valueOf('skip') || '').split(',').map(s => s.trim()).filter(Boolean);
const browsers = valueOf('browsers');
const fast = has('fast');

// ── Step 0: make sure there is a list of pages ───────────────────────────────
// Someone running this for the first time should not have to know that a file
// called urls.json exists, let alone how to build one.
async function ensurePages() {
  let urls;
  try {
    urls = JSON.parse(fs.readFileSync('./urls.json', 'utf8'));
  } catch (err) {
    console.error('✗ Could not read urls.json — ' + err.message);
    console.error('  If it has been edited by hand, check it is valid JSON: a list of');
    console.error('  addresses in square brackets. urls.example.json shows the shape.');
    process.exit(1);
  }

  if (Array.isArray(urls) && urls.length) return urls;

  if (!interactive) {
    console.error('✗ urls.json is empty, so there is nothing to scan.\n');
    console.error('  Build the list from the site\'s sitemap:');
    console.error('    npm run urls:find -- https://www.example.com --write\n');
    console.error('  Or fill in urls.json by hand — urls.example.json shows the shape.');
    console.error('  Then run `npm start` again.');
    process.exit(1);
  }

  console.log('No pages to check yet — let\'s find them.\n');
  const answer = (await ask('Which site do you want to check? (e.g. www.example.com)\n> ')).trim();

  if (!answer) {
    console.log('\nNothing entered, so nothing to do.');
    console.log('Run `npm start` again when you know the address.');
    close();
    process.exit(1);
  }

  // Typing a bare domain is the norm; only a scheme-less answer gets one added.
  const site = /^https?:\/\//i.test(answer) ? answer : `https://${answer}`;
  try {
    new URL(site);
  } catch (e) {
    console.log(`\n✗ "${answer}" does not look like a web address.`);
    console.log('  It should look like www.example.com or https://www.example.com');
    close();
    process.exit(1);
  }

  // Hand stdin over cleanly: the child asks its own questions from here.
  console.log(`\nLooking for the page list on ${site}…\n`);
  release();

  const res = spawnSync(process.execPath, ['find-pages.js', site], { stdio: 'inherit' });
  if (res.error) {
    console.error(`\n✗ Could not run the page finder — ${res.error.message}`);
    process.exit(1);
  }

  let after = [];
  try {
    after = JSON.parse(fs.readFileSync('./urls.json', 'utf8'));
  } catch (e) { /* handled just below */ }

  if (!Array.isArray(after) || !after.length) {
    console.log('\nNo page list was saved, so there is nothing to scan yet.');
    console.log('Once urls.json has some addresses in it, run `npm start` again.');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`Page list ready — ${after.length} page(s). Starting the scans.`);
  console.log(`${'═'.repeat(64)}`);
  return after;
}

async function main() {
  const urls = await ensurePages();

  const bad = urls.filter(u => typeof u !== 'string' || !/^https?:\/\//i.test(u));
  if (bad.length) {
    console.error(`\n✗ urls.json has ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that ${bad.length === 1 ? 'is not a' : 'are not'} full address${bad.length === 1 ? '' : 'es'}:`);
    bad.slice(0, 5).forEach(u => console.error(`    ${JSON.stringify(u)}`));
    console.error('  Every entry needs the https:// part, e.g. "https://www.example.com/about".');
    process.exit(1);
  }

  // Playwright is the dependency every step needs; a missing one means setup never ran.
  if (!fs.existsSync('./node_modules/playwright')) {
    console.error('\n✗ The scanning tools are not installed yet.\n');
    console.error('  Run this first:  npm run setup');
    process.exit(1);
  }

  // ── The steps ──────────────────────────────────────────────────────────────
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

  console.log('\nAccessibility Audit Toolkit — automated scans');
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

  // ── Summary ────────────────────────────────────────────────────────────────
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

  console.log('\nAutomated tools cover roughly 30% of WCAG 2.2 A/AA — the questions below');
  console.log('cover the rest. See COVERAGE.md for which tool verifies which criterion.');

  // An incomplete scan set must not look like a clean pass to a script or a CI job.
  if (failed.length) process.exitCode = 1;

  // Offer the rest of the audit rather than leaving two more commands to find.
  if (!interactive) {
    console.log('\nNext steps — these two are what make the audit complete:');
    console.log('  1. npm run audit:manual                 the keyboard / screen-reader /');
    console.log('                                          judgement questions (saves as you go)');
    console.log('  2. npm run report:findings -- --label "Baseline"');
    console.log('                                          builds audits/reports/findings-report.md\n');
    return;
  }

  const doManual = await askYesNo(
    '\nThe manual questions are what make the audit complete. Start them now?', true);
  if (doManual) {
    release();
    const res = spawnSync(process.execPath, ['manual-audit.js'], { stdio: 'inherit' });
    if (res.error) console.error(`✗ Could not start the questions — ${res.error.message}`);
    // manual-audit.js prints its own progress and the report command on exit.
    return;
  }

  console.log('\nWhen you are ready, the rest of the audit is:');
  console.log('  npm run audit:manual                    the questions (resumable)');
  console.log('  npm run report:findings -- --label "Baseline"   the report\n');
  close();
}

main().catch(err => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
