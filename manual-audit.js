// manual-audit.js — guided checklist for the WCAG criteria that automated
// tools cannot verify (or can only partially verify). Walks you through each
// criterion with concrete test steps, records Pass / Fail / N-A per criterion,
// and saves everything to audits/manual/manual-results.json — which
// generate-report.js merges with the axe / extra-checks / snippet results.
//
// Usage:
//   node manual-audit.js                 # asks only the criteria not yet answered
//   node manual-audit.js --all           # re-asks everything (existing answers shown as defaults)
//   node manual-audit.js --criteria 1.4.3,2.1.1,3.3.1   # just these
//   node manual-audit.js --list          # progress overview, no questions
//
// Answers are saved after every question — quit any time with q and resume later.
//
// Answering "?" marks a criterion as needing someone with accessibility
// expertise. That is a real answer, not a skip: the report lists it as an open
// coverage gap with your note, so "nobody here could judge this" stays visible
// instead of being guessed at as a pass.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { criteria } = require('./criteria.json');

const OUT_DIR = './audits/manual';
const OUT_FILE = path.join(OUT_DIR, 'manual-results.json');

const args = process.argv.slice(2);
const LIST_ONLY = args.includes('--list');
const ASK_ALL = args.includes('--all');
const onlyArg = (() => {
  const i = args.findIndex(a => a === '--criteria' || a.startsWith('--criteria='));
  if (i === -1) return null;
  const v = args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
  return v ? v.split(',').map(s => s.trim()) : null;
})();

const manualCriteria = criteria.filter(c => c.coverage.manual);

// ── Load / init results ──────────────────────────────────────────────────────
let store = { tool: 'manual-audit', testedBy: '', updatedAt: null, entries: {} };
if (fs.existsSync(OUT_FILE)) {
  try { store = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); }
  catch (e) { console.error(`Could not parse ${OUT_FILE}: ${e.message}`); process.exit(1); }
}

function save() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 2));
}

function progress() {
  const answered = manualCriteria.filter(c => store.entries[c.sc]);
  const fails = answered.filter(c => store.entries[c.sc].result === 'fail');
  return { total: manualCriteria.length, answered: answered.length, fails: fails.length };
}

// ── --list ───────────────────────────────────────────────────────────────────
if (LIST_ONLY) {
  const p = progress();
  console.log(`Manual audit progress: ${p.answered}/${p.total} criteria answered (${p.fails} fail)\n`);
  for (const c of manualCriteria) {
    const e = store.entries[c.sc];
    const mark = !e ? '·' : e.result === 'pass' ? '✓' : e.result === 'fail' ? '✗' : '—';
    console.log(`  ${mark} ${c.sc.padEnd(7)} ${c.name.padEnd(45)} ${e ? e.result.toUpperCase() : 'pending'}`);
  }
  console.log(`\nResults file: ${OUT_FILE}`);
  process.exit(0);
}

// ── Interactive session ──────────────────────────────────────────────────────
// Own line buffer instead of rl.question(): keeps piped/scripted input from
// losing lines between questions, and resolves '' cleanly when stdin ends.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let stdinClosed = false;
const bufferedLines = [];
const waitingAsks = [];
rl.on('line', l => {
  const w = waitingAsks.shift();
  if (w) w(l.trim()); else bufferedLines.push(l.trim());
});
rl.on('close', () => {
  stdinClosed = true;
  while (waitingAsks.length) waitingAsks.shift()('');
});
function ask(q) {
  process.stdout.write(q);
  if (bufferedLines.length) { const a = bufferedLines.shift(); process.stdout.write(a + '\n'); return Promise.resolve(a); }
  if (stdinClosed) { process.stdout.write('\n'); return Promise.resolve(''); }
  return new Promise(res => waitingAsks.push(res));
}

const queue = manualCriteria.filter(c => {
  if (onlyArg) return onlyArg.includes(c.sc);
  if (ASK_ALL) return true;
  return !store.entries[c.sc];
});

(async () => {
  const p = progress();
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`WCAG 2.2 AA manual audit — ${queue.length} question(s) to go (${p.answered}/${p.total} answered)`);
  console.log(`${'═'.repeat(72)}`);
  console.log(`This is the part automated tools cannot do. Expect roughly`);
  console.log(`${Math.max(1, Math.round(queue.length * 0.5))}–${Math.max(2, Math.round(queue.length * 1.5))} minutes if you know the site, longer where you have to go and test.`);
  console.log(`\nYou will need: a keyboard, browser zoom, and a screen reader for some`);
  console.log(`questions (NVDA on Windows/Chrome, or VoiceOver on Mac/Safari).`);
  console.log(`\nEvery answer is saved immediately. Press q whenever you want to stop —`);
  console.log(`next time it picks up exactly where you left off.`);
  console.log(`\nAnswers:`);
  console.log(`  p  pass — you checked it and it is fine`);
  console.log(`  f  fail — there is a problem (it then asks you where and how bad)`);
  console.log(`  n  not applicable — the site has nothing this applies to`);
  console.log(`  ?  I cannot judge this — flags it for someone with a11y expertise`);
  console.log(`  s  skip for now — ask me again next time`);
  console.log(`  q  save and quit\n`);

  if (!store.testedBy) {
    store.testedBy = await ask('Your name (recorded as "Tested By"): ') || 'unknown';
    save();
  }

  for (const [index, c] of queue.entries()) {
    const prev = store.entries[c.sc];
    const auto = [];
    if (c.coverage.axe) auto.push(`axe (${c.coverage.axe})`);
    if (c.coverage.wave) auto.push('WAVE');
    if (c.coverage.extra && c.coverage.extra.length) auto.push(`extra-checks: ${c.coverage.extra.join(', ')}`);
    if (c.coverage.snippet && c.coverage.snippet.length) auto.push(`snippet: ${c.coverage.snippet.join(', ')}`);

    console.log('\n' + '─'.repeat(72));
    console.log(`[${index + 1}/${queue.length}]  ${c.sc}  ${c.name}  (Level ${c.level})`);
    console.log(`   ${c.meaning}`);
    if (auto.length) console.log(`   Automated coverage: ${auto.join(' · ')} — review those results too.`);
    else console.log(`   Automated coverage: none — no tool can check this one, only a person.`);
    console.log('   How to test:');
    for (const step of c.manualSteps) console.log(`     • ${step}`);
    if (prev) console.log(`   (previously: ${prev.result.toUpperCase()}${prev.issue ? ' — ' + prev.issue : ''})`);

    let answer;
    while (true) {
      answer = (await ask(`   [p]ass  [f]ail  [n]/a  [?]can't judge  [s]kip  [q]uit${prev ? `  (Enter = keep ${prev.result})` : ''}: `)).toLowerCase();
      if (answer === '' && prev) { answer = null; break; }
      if (['p', 'f', 'n', '?', 's', 'q'].includes(answer)) break;
      if (stdinClosed) { answer = 'q'; break; }
      console.log('   Please answer p, f, n, ?, s or q.');
    }
    if (answer === null) continue;            // keep previous
    if (answer === 'q') break;
    if (answer === 's') continue;

    const RESULTS = { p: 'pass', f: 'fail', n: 'na', '?': 'unsure' };
    const entry = {
      result: RESULTS[answer],
      testedBy: store.testedBy,
      date: new Date().toISOString().slice(0, 10)
    };
    if (answer === 'f') {
      entry.pages = await ask('   Pages affected (e.g. "all", "/about, /contact"): ');
      entry.component = await ask('   Component / where (e.g. "mobile menu", "contact form"): ');
      entry.issue = await ask('   What is wrong (one line, this goes in the report): ');
      const sev = (await ask('   Severity [h]igh / [m]edium / [l]ow: ')).toLowerCase();
      entry.severity = sev.startsWith('h') ? 'high' : sev.startsWith('l') ? 'low' : 'medium';
      entry.evidence = await ask('   Evidence file, if any (screenshot per naming convention, Enter to skip): ');
    } else if (answer === '?') {
      console.log(`   Recorded as needing an expert — it stays an open gap in the report.`);
      const note = await ask('   What stopped you deciding? (optional, helps whoever picks it up): ');
      if (note) entry.note = note;
    } else {
      const note = await ask('   Note (optional, Enter to skip): ');
      if (note) entry.note = note;
    }
    store.entries[c.sc] = entry;
    save();
  }

  if (!stdinClosed) rl.close();
  const done = progress();
  const unsure = manualCriteria.filter(c => (store.entries[c.sc] || {}).result === 'unsure');
  console.log('\n' + '═'.repeat(72));
  console.log(`Saved to ${OUT_FILE}`);
  console.log(`Progress: ${done.answered}/${done.total} answered · ${done.fails} failing`);
  if (unsure.length) {
    console.log(`\n${unsure.length} criteri${unsure.length === 1 ? 'on' : 'a'} marked as needing an expert:`);
    for (const c of unsure) console.log(`  ? ${c.sc}  ${c.name}`);
    console.log(`These stay open gaps in the report until someone qualified answers them.`);
  }
  if (done.answered < done.total) {
    console.log(`\n${done.total - done.answered} still unanswered. Run this again to carry on:`);
    console.log(`  npm run audit:manual`);
  }
  console.log(`\nNext — build the report:`);
  console.log(`  npm run report:findings -- --label "Baseline"`);
})();
