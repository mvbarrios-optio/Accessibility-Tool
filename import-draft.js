// Records Claude's draft as answers, marked as unconfirmed:
//
//   npm run draft:import
//
// Reads audits/reports/assist-draft.json (written by a Claude session given the
// prompt from assist-prompt.js) and writes each proposal into the manual results
// as an answer that carries who proposed it and that nobody has checked it.
//
// This is the trade the toolkit makes here, stated plainly: it saves you typing
// 42 answers, and in exchange the report shows those criteria as 📝 DRAFTED
// rather than passed. They count as a coverage gap, not as verification, because
// a proposal nobody read is not verification — it is just a faster way to be
// wrong. `npm run audit:manual --confirm` walks them so you can turn them into
// real answers whenever you have time.
//
// An answer a person already gave is never overwritten. Use --force only when
// you mean to replace your own work with a draft, which is rarely what you want.
const fs = require('fs');
const path = require('path');
const { criteria } = require('./criteria.json');

const DRAFT_FILE = './audits/reports/assist-draft.json';
const OUT_DIR = './audits/manual';
const OUT_FILE = path.join(OUT_DIR, 'manual-results.json');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');

if (args.includes('--help')) {
  console.log(`Usage: node import-draft.js [--dry-run] [--force]

Reads ${DRAFT_FILE} and records each proposal as an unconfirmed answer.

  --dry-run   show what would be imported, write nothing
  --force     overwrite answers a person already gave (rarely what you want)
`);
  process.exit(0);
}

if (!fs.existsSync(DRAFT_FILE)) {
  console.error(`✗ ${DRAFT_FILE} not found.\n`);
  console.error('  It is written by a Claude session given the prompt from:');
  console.error('    npm run assist:prompt\n');
  console.error('  If that session could not write files (claude.ai in a browser cannot),');
  console.error('  save the JSON it gave you to that path by hand, then run this again.');
  process.exit(1);
}

let draft;
try {
  draft = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
} catch (err) {
  console.error(`✗ ${DRAFT_FILE} is not valid JSON — ${err.message}`);
  console.error('  If you pasted it by hand, check nothing was truncated.');
  process.exit(1);
}

const entries = Array.isArray(draft.criteria) ? draft.criteria : null;
if (!entries) {
  console.error(`✗ ${DRAFT_FILE} has no "criteria" array.`);
  process.exit(1);
}

// ── Load what is already answered ────────────────────────────────────────────
let store = { tool: 'manual-audit', testedBy: '', updatedAt: null, entries: {} };
if (fs.existsSync(OUT_FILE)) {
  try {
    store = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  } catch (err) {
    console.error(`✗ Could not read ${OUT_FILE} — ${err.message}`);
    process.exit(1);
  }
}
store.entries = store.entries || {};

const known = new Set(criteria.map(c => c.sc));
const agentOf = Object.fromEntries(criteria.map(c => [c.sc, c.coverage.agent]));

const RESULT = { pass: 'pass', fail: 'fail', na: 'na', 'needs-a-person': 'unsure' };

const imported = [];
const keptHuman = [];
const rejected = [];
const unknownSc = [];

for (const e of entries) {
  const sc = e && e.sc;
  if (!sc || !known.has(sc)) { unknownSc.push(sc || '(no sc)'); continue; }

  // Never accept a model's answer on a criterion it was never allowed to assess.
  // assist-prompt.js does not include these, so one appearing here means the
  // draft went beyond what it was asked — which is exactly when to be strict.
  if (agentOf[sc] === 'no') {
    rejected.push(sc);
    continue;
  }

  const result = RESULT[e.proposed];
  if (!result) { rejected.push(`${sc} (proposed "${e.proposed}")`); continue; }

  const existing = store.entries[sc];
  const humanAnswered = existing && existing.source !== 'draft';
  if (humanAnswered && !FORCE) { keptHuman.push(sc); continue; }

  const entry = {
    result,
    testedBy: 'Claude (draft)',
    date: new Date().toISOString().slice(0, 10),
    source: 'draft',
    confirmed: false,
    confidence: e.confidence || 'unknown'
  };
  if (e.evidence) entry.note = e.evidence;
  if (result === 'fail') {
    entry.pages = e.pages || '?';
    entry.component = e.component || '';
    entry.issue = e.issue || e.evidence || 'drafted failure, no detail given';
    // Not the model's call to make: severity drives fix ordering, so it stays
    // medium until a person says otherwise.
    entry.severity = 'medium';
  }
  if (result === 'unsure' && e.stillNeedsAPerson) entry.note = e.stillNeedsAPerson;

  store.entries[sc] = entry;
  imported.push({ sc, result, confidence: entry.confidence });
}

// ── Report ───────────────────────────────────────────────────────────────────
const bar = '─'.repeat(72);
console.log(`\n${bar}`);
console.log(`Draft import${DRY ? ' (dry run — nothing written)' : ''}`);
console.log(bar);
console.log(`  imported:          ${imported.length}`);
if (keptHuman.length) console.log(`  kept your answers: ${keptHuman.length}  (${keptHuman.join(', ')})`);
if (rejected.length) console.log(`  refused:           ${rejected.length}  (${rejected.join(', ')})`);
if (unknownSc.length) console.log(`  unknown criteria:  ${unknownSc.length}  (${unknownSc.join(', ')})`);

if (imported.length) {
  const low = imported.filter(i => i.confidence === 'low');
  const fails = imported.filter(i => i.result === 'fail');
  console.log('');
  if (fails.length) console.log(`  ${fails.length} drafted as FAIL: ${fails.map(f => f.sc).join(', ')}`);
  if (low.length) console.log(`  ${low.length} at low confidence — read these first: ${low.map(f => f.sc).join(', ')}`);
}

if (!DRY && imported.length) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_FILE, JSON.stringify(store, null, 2));
  console.log(`\n✓ Written to ${OUT_FILE}`);
}

console.log(`\n${bar}`);
console.log(`These are recorded as answers but NOT as verified. In the findings report`);
console.log(`they show as 📝 DRAFTED and count as a coverage gap, not as passes —`);
console.log(`nobody has read them yet, and the report will not pretend otherwise.`);
console.log(`\nTo turn them into real answers, whenever you have time:`);
console.log(`  npm run audit:manual -- --confirm     walks only the drafted ones`);
console.log(`\nStill to answer yourself: the criteria no agent is given.`);
console.log(`  npm run audit:manual`);
console.log(bar);
