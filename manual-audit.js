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
const { spawnSync } = require('child_process');
const { criteria } = require('./criteria.json');

const OUT_DIR = './audits/manual';
const DRAFT_FILE = './audits/reports/assist-draft.json';
const OUT_FILE = path.join(OUT_DIR, 'manual-results.json');

const args = process.argv.slice(2);
const LIST_ONLY = args.includes('--list');
const ASK_ALL = args.includes('--all');
// Set when run-scans.js already asked; it must not ask the same thing again.
const DRAFT_FIRST = args.includes('--draft-first');
const NO_DRAFT = args.includes('--no-draft');
// Walks only the criteria carrying an imported draft nobody has checked.
const CONFIRM = args.includes('--confirm');
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

// Claude's draft, if assist-prompt.js was used and the session wrote the file.
// Shown beside the question it belongs to — reading it here beats keeping a
// second window open, and it stays a proposal: nothing is pre-filled.
let draft = {};
if (fs.existsSync(DRAFT_FILE)) {
  try {
    const d = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
    for (const e of d.criteria || []) if (e && e.sc) draft[e.sc] = e;
  } catch (err) {
    console.error(`⚠ Could not read ${DRAFT_FILE} — ${err.message}`);
    console.error(`  Carrying on without the draft.`);
  }
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
let rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
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
// Handing stdin to a child closes this interface; the questions after it need a
// fresh one, or every prompt would resolve to '' against a dead stream.
function restartReadline() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  stdinClosed = false;
  bufferedLines.length = 0;
  waitingAsks.length = 0;
  rl.on('line', l => {
    const w = waitingAsks.shift();
    if (w) w(l.trim()); else bufferedLines.push(l.trim());
  });
  rl.on('close', () => {
    stdinClosed = true;
    while (waitingAsks.length) waitingAsks.shift()('');
  });
}

function ask(q) {
  process.stdout.write(q);
  if (bufferedLines.length) { const a = bufferedLines.shift(); process.stdout.write(a + '\n'); return Promise.resolve(a); }
  if (stdinClosed) { process.stdout.write('\n'); return Promise.resolve(''); }
  return new Promise(res => waitingAsks.push(res));
}

const isUnconfirmedDraft = sc => {
  const e = store.entries[sc];
  return Boolean(e && e.source === 'draft' && !e.confirmed);
};

let queue = manualCriteria.filter(c => {
  if (onlyArg) return onlyArg.includes(c.sc);
  if (CONFIRM) return isUnconfirmedDraft(c.sc);
  if (ASK_ALL) return true;
  // An imported draft counts as answered for the ordinary pass — that is the
  // point of importing it — so only --confirm brings it back round.
  return !store.entries[c.sc];
});

(async () => {
  const p = progress();
  if (CONFIRM && !queue.length) {
    console.log(`\nNothing to confirm — no imported draft is waiting.`);
    console.log(`Drafts arrive via:  npm run assist:prompt  then  npm run draft:import`);
    if (!stdinClosed) rl.close();
    return;
  }

  console.log(`\n${'═'.repeat(72)}`);
  if (CONFIRM) {
    console.log(`Confirming Claude's draft — ${queue.length} criteri${queue.length === 1 ? 'on' : 'a'} to check`);
    console.log(`${'═'.repeat(72)}`);
    console.log(`Each one shows what Claude proposed and why. Agree and it becomes a real`);
    console.log(`answer under your name; disagree and you answer it yourself. Until then`);
    console.log(`the report shows them as 📝 DRAFTED and counts them as unverified.`);
  } else {
  console.log(`WCAG 2.2 AA manual audit — ${queue.length} question(s) to go (${p.answered}/${p.total} answered)`);
  console.log(`${'═'.repeat(72)}`);
  console.log(`This is the part automated tools cannot do. Expect roughly`);
  console.log(`${Math.max(1, Math.round(queue.length * 0.5))}–${Math.max(2, Math.round(queue.length * 1.5))} minutes if you know the site, longer where you have to go and test.`);
  console.log(`\nYou will need: a keyboard, browser zoom, and a screen reader for some`);
  console.log(`questions (NVDA on Windows/Chrome, or VoiceOver on Mac/Safari).`);
  }
  if (Object.keys(draft).length) {
    console.log(`\nClaude's draft is loaded (${Object.keys(draft).length} criteria from ${DRAFT_FILE}).`);
    console.log(`Its proposal shows under each question it covers. Check it — agreeing`);
    console.log(`without looking is the same guessed pass you would have made anyway.`);
  }
  console.log(`\nEvery answer is saved immediately. Press q whenever you want to stop —`);
  console.log(`next time it picks up exactly where you left off.`);
  console.log(`\nAnswers:`);
  console.log(`  p  pass — you checked it and it is fine`);
  console.log(`  f  fail — there is a problem (it then asks you where and how bad)`);
  console.log(`  n  not applicable — the site has nothing this applies to`);
  console.log(`  ?  I cannot judge this — flags it for someone with a11y expertise`);
  console.log(`  s  skip for now — ask me again next time`);
  console.log(`  q  save and quit\n`);

  // Offered rather than mentioned: this is the moment the decision is actually
  // made, and a tip printed above the fold is a tip nobody acts on. Only on a
  // first pass — on a resume or a top-up the draft is already done or not wanted.
  const fresh = p.answered === 0 && queue.length > 20;
  const offerDraft = DRAFT_FIRST
    || (!NO_DRAFT && fresh && process.stdin.isTTY && process.stdout.isTTY);
  if (offerDraft) {
    // Only when this is the first time the option is being put; run-scans.js has
    // already explained it when it passes --draft-first.
    if (!DRAFT_FIRST) {
      console.log(`Before you start: Claude can draft the ones it can genuinely assess —`);
      console.log(`link purpose in context, whether alt text says anything useful, heading`);
      console.log(`quality — working from what your scans already found. You still answer`);
      console.log(`every question here; it just means arriving with evidence instead of a`);
      console.log(`blank page. It needs a Claude session with browser access.`);
    }

    // Already decided upstream, so do not ask twice.
    let want = DRAFT_FIRST ? 'y' : '';
    while (!DRAFT_FIRST) {
      want = (await ask(`\nPrint that prompt now instead of starting? [Y/n]: `)).toLowerCase();
      if (['', 'y', 'yes', 'n', 'no'].includes(want)) break;
      console.log('  Please answer y or n.');
    }
    if (want === '' || want === 'y' || want === 'yes') {
      // The prompt goes to stdout of a child that owns the terminal, so the
      // readline has to let go and be rebuilt for the questions that follow.
      if (!stdinClosed) rl.close();
      const res = spawnSync(process.execPath, ['assist-prompt.js'], { stdio: 'inherit' });
      if (res.error) {
        console.error(`✗ Could not run assist-prompt.js — ${res.error.message}`);
        process.exit(1);
      }
      // It prints its own reason when it cannot build a prompt (an empty
      // urls.json, most likely). Sending someone off to fetch a draft that was
      // never produced would be worse than the original failure.
      if (res.status !== 0) {
        console.log(`\nNo draft was produced, so there is nothing to take to Claude.`);
        console.log(`Fix the above and run  npm run assist:prompt  — or start the`);
        console.log(`questions without a draft:  npm run audit:manual`);
        process.exitCode = 1;
        return;
      }

      // Rather than stopping here and making the next run walk all 54 again,
      // carry straight on with the ones the draft will never cover. The other
      // criteria stay unanswered, so the next run picks up exactly those — the
      // resume logic already does this, it just needed to not be thrown away.
      const humanOnly = queue.filter(c => c.coverage.agent === 'no');
      const drafted = queue.length - humanOnly.length;
      queue = humanOnly;

      console.log(`\n${'═'.repeat(72)}`);
      console.log(`Take that prompt to Claude for ${drafted} of the ${drafted + humanOnly.length} criteria.`);
      console.log(`${'═'.repeat(72)}`);
      console.log(`Meanwhile, here are the ${humanOnly.length} it can never answer — a screen reader, a`);
      console.log(`real device, human senses, or something it must not do. They need you`);
      console.log(`either way, so there is no reason to wait for the draft to start them.`);
      console.log(`\nPress q at any point to stop. When the draft is ready, run`);
      console.log(`npm run audit:manual again and it will ask the remaining ${drafted}.`);

      restartReadline();
    }
  }

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

    const d = draft[c.sc];
    if (d) {
      const conf = d.confidence ? ` (${d.confidence} confidence)` : '';
      console.log(`   ── Claude's draft: ${String(d.proposed || '?').toUpperCase()}${conf}`);
      if (d.evidence) console.log(`      evidence: ${d.evidence}`);
      if (d.proposed === 'fail') {
        if (d.pages) console.log(`      pages: ${d.pages}`);
        if (d.component) console.log(`      component: ${d.component}`);
        if (d.issue) console.log(`      issue: ${d.issue}`);
      }
      if (d.stillNeedsAPerson) console.log(`      still needs you: ${d.stillNeedsAPerson}`);
      console.log(`      — a proposal, not an answer. Check it before agreeing.`);
    }

    let answer;
    while (true) {
      const hint = CONFIRM && prev
        ? `  (Enter = agree with ${prev.result.toUpperCase()})`
        : prev ? `  (Enter = keep ${prev.result})` : '';
      answer = (await ask(`   [p]ass  [f]ail  [n]/a  [?]can't judge  [s]kip  [q]uit${hint}: `)).toLowerCase();
      if (answer === '' && prev) { answer = null; break; }
      if (['p', 'f', 'n', '?', 's', 'q'].includes(answer)) break;
      if (stdinClosed) { answer = 'q'; break; }
      console.log('   Please answer p, f, n, ?, s or q.');
    }
    // Enter in --confirm is not "leave it alone": it is a person agreeing, which
    // is the whole difference between a draft and an answer.
    if (answer === null && CONFIRM && prev) {
      store.entries[c.sc] = {
        ...prev, confirmed: true, testedBy: store.testedBy,
        date: new Date().toISOString().slice(0, 10),
        draftedBy: 'Claude', draftConfidence: prev.confidence
      };
      delete store.entries[c.sc].source;
      save();
      console.log(`   ✓ confirmed`);
      continue;
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
    // Answering over a draft replaces it; it is yours now either way.
    if (prev && prev.source === 'draft') {
      entry.draftedBy = 'Claude';
      entry.draftProposed = prev.result;
      entry.draftConfidence = prev.confidence;
      entry.confirmed = true;
    }
    if (answer === 'f') {
      entry.pages = await ask('   Pages affected (e.g. "all", "/about, /contact"): ');
      entry.component = await ask('   Component / where (e.g. "mobile menu", "contact form"): ');
      entry.issue = await ask('   What is wrong (one line, this goes in the report): ');
      const sev = (await ask('   Severity [h]igh / [m]edium / [l]ow: ')).toLowerCase();
      entry.severity = sev.startsWith('h') ? 'high' : sev.startsWith('l') ? 'low' : 'medium';
      // Self-explanatory rather than pointing at a convention: the phrase this
      // replaced ("per naming convention") referred to one defined in the brief
      // of the project this toolkit came from, which no longer exists here.
      entry.evidence = await ask('   Evidence file, if any (e.g. "contact-2.4.7.png", Enter to skip): ');
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
