// Prints a prompt that asks Claude to draft the human-judgement checks:
//
//   npm run assist:prompt
//
// The manual pass is 54 criteria and the bottleneck of the whole audit. Some of
// it is genuinely text and vision work — is this alt text useful, does this link
// make sense in context, are these headings descriptive — which an agent with
// browser access can do well. Some of it is not, and pretending otherwise is how
// an audit ends up claiming coverage it does not have.
//
// So this produces a DRAFT, not answers. Claude assesses what it can, with
// evidence and a confidence, and you still record the result in manual-audit.js.
// Nothing here writes to audits/manual/ — the human stays the one who decides,
// which is the same reason generate-report.js refuses to call a criterion "pass"
// on automation alone.
//
// criteria.json carries the split, as coverage.agent:
//   good     reading content, DOM or pixels decides it
//   partial  can be triaged, measured or narrowed, but a person decides
//   no       needs a screen reader, a real device, human senses, or an action
//            Claude must not take — these are never included
const fs = require('fs');
const path = require('path');
const { criteria } = require('./criteria.json');

const RAW_DIR = './audits/raw';
const REPORTS_DIR = './audits/reports';
const OUT_FILE = path.join(REPORTS_DIR, 'assist-prompt.txt');

const args = process.argv.slice(2);
const has = n => args.some(a => a === `--${n}` || a.startsWith(`--${n}=`));
const valueOf = n => {
  const hit = args.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

if (has('help')) {
  console.log(`Usage: node assist-prompt.js [--only=good] [--criteria=2.4.4,1.1.1]

  --only=good       only the criteria an agent can decide from content (default: good+partial)
  --criteria=<list> just these, comma-separated
`);
  process.exit(0);
}

let urls;
try {
  urls = JSON.parse(fs.readFileSync('./urls.json', 'utf8'));
} catch (err) {
  console.error('✗ Could not read urls.json — ' + err.message);
  process.exit(1);
}
if (!Array.isArray(urls) || !urls.length) {
  console.error('✗ urls.json is empty — there are no pages to assess.');
  console.error('  Build the list first:  npm run urls:find -- https://www.example.com');
  process.exit(1);
}

// ── Which criteria to include ────────────────────────────────────────────────
const only = valueOf('only');
const pick = (valueOf('criteria') || '').split(',').map(s => s.trim()).filter(Boolean);
const wanted = only === 'good' ? ['good'] : ['good', 'partial'];

let selected = criteria.filter(c => c.coverage.manual && wanted.includes(c.coverage.agent));
if (pick.length) {
  const missing = pick.filter(sc => !criteria.some(c => c.sc === sc));
  if (missing.length) {
    console.error(`✗ Not a WCAG 2.2 A/AA criterion in this set: ${missing.join(', ')}`);
    process.exit(1);
  }
  selected = criteria.filter(c => pick.includes(c.sc));
  const refused = selected.filter(c => c.coverage.agent === 'no');
  for (const c of refused) {
    console.error(`⚠ ${c.sc} ${c.name} needs a screen reader, a real device or human senses.`);
    console.error(`  Including it anyway, but do not accept an answer to it from a model.`);
  }
}

if (!selected.length) {
  console.error('✗ Nothing selected.');
  process.exit(1);
}

// ── What the scans already found, so the draft starts from evidence ──────────
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function evidenceSummary() {
  const lines = [];
  if (!fs.existsSync(RAW_DIR)) return lines;
  const files = fs.readdirSync(RAW_DIR);

  const waveCounts = {};
  for (const f of files.filter(x => x.endsWith('-wave.json'))) {
    for (const c of (readJson(path.join(RAW_DIR, f)) || {}).categories || []) {
      const key = `${c.category} / ${c.title}`;
      waveCounts[key] = (waveCounts[key] || 0) + c.count;
    }
  }
  const alerts = Object.entries(waveCounts).filter(([k]) => /^Alerts/.test(k));
  if (alerts.length) {
    lines.push('WAVE alerts across the site (these are "look at this", not failures):');
    for (const [k, v] of alerts.sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      lines.push(`  ${v}× ${k}`);
    }
  }

  // The summary carries only counts per page plus the site-level checks; the
  // per-check detail lives in each page's own -extra.json.
  const flagged = new Map();
  const note = chk => {
    if (chk.status !== 'fail' && chk.status !== 'review') return;
    if (!flagged.has(chk.id)) flagged.set(chk.id, { sc: (chk.sc || []).join('/'), n: 0 });
    flagged.get(chk.id).n++;
  };
  for (const f of files.filter(x => x.endsWith('-extra.json'))) {
    for (const chk of (readJson(path.join(RAW_DIR, f)) || {}).checks || []) note(chk);
  }
  for (const chk of (readJson(path.join(REPORTS_DIR, 'extra-summary.json')) || {}).siteChecks || []) note(chk);

  if (flagged.size) {
    lines.push('', 'extra-checks flagged (check id, criterion, pages affected):');
    for (const [id, v] of [...flagged].sort((a, b) => b[1].n - a[1].n)) {
      lines.push(`  ${id} (${v.sc}) — ${v.n}`);
    }
  }

  const findings = readJson(path.join(REPORTS_DIR, 'findings.json'));
  if (findings) {
    const failing = findings.criteria.filter(c => c.status === 'fail').map(c => c.sc);
    if (failing.length) lines.push('', `Already failing from the automated passes: ${failing.join(', ')}`);
  }
  return lines;
}

// ── The prompt ───────────────────────────────────────────────────────────────
const evidence = evidenceSummary();

const criteriaBlock = selected.map(c => {
  const conf = c.coverage.agent === 'partial'
    ? '    NOTE: you can narrow this but probably not settle it — say what a person still has to check.\n'
    : '';
  return `${c.sc}  ${c.name}  (Level ${c.level})\n`
    + `    Requirement: ${c.meaning}\n`
    + `    How it is tested: ${(c.manualSteps || []).join(' ')}\n`
    + conf;
}).join('\n');

const prompt = `I am running a WCAG 2.2 Level A/AA accessibility audit and need help with the
parts that need judgement rather than a tool. You have browser access.

Pages in scope:
${urls.map(u => `  ${u}`).join('\n')}

${evidence.length ? `What the automated scans already found:\n${evidence.map(l => l && !l.startsWith(' ') ? l : l).join('\n')}\n` : ''}
For each criterion below: visit the pages, gather the evidence, and give me a DRAFT
assessment. Use this shape, one block per criterion:

  <SC> <name>
  Proposed: pass | fail | n/a | needs-a-person
  Confidence: high | medium | low
  Evidence: what you actually looked at — page, selector, the text or value you saw
  If fail: which pages, which component, what is wrong, and the fix
  Still needs a person: what you could not settle, and why

Rules I need you to hold to:

1. Do not answer from the DOM alone where the DOM is not the question. You can read
   markup and computed styles; you cannot hear a screen reader. If a criterion turns on
   what gets announced, say so and mark it needs-a-person.

2. Do not submit forms that send real messages, do not attempt to log in, and do not
   try to solve CAPTCHAs. If a criterion needs that, tell me and stop there.

3. "I could not tell" is a useful answer. A guessed pass is worse than no answer,
   because it goes into an audit that someone will rely on. Low confidence is fine;
   false confidence is not.

4. For criteria the scans already flagged, start from those findings rather than
   re-deriving them — confirm or dispute what the tools said, and say which.

5. Quote the evidence, do not summarise it away. "Three links read 'Read more'" with the
   page and selector is useful; "link text could be better" is not.

Criteria to assess:

${criteriaBlock}
When you are done, list anything you marked needs-a-person, so I know what is left.

I will record the answers myself — this is a draft to work from, not the audit.`;

// ── Output ───────────────────────────────────────────────────────────────────
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, prompt + '\n');

const bar = '─'.repeat(72);
const counts = selected.reduce((a, c) => (a[c.coverage.agent] = (a[c.coverage.agent] || 0) + 1, a), {});
const excluded = criteria.filter(c => c.coverage.manual && c.coverage.agent === 'no');

console.log(`\n${bar}`);
console.log('Draft the judgement checks with Claude. Copy everything between the lines');
console.log('into a Claude session that has browser access.');
console.log(bar);
console.log(`\n${prompt}\n`);
console.log(bar);
console.log(`Covering ${selected.length} criteria — ${counts.good || 0} it can decide from content, `
  + `${counts.partial || 0} it can only narrow.`);
if (!pick.length && excluded.length) {
  console.log(`\nDeliberately NOT included (${excluded.length}) — these need a screen reader, a real`);
  console.log(`device, human senses, or an action Claude must not take:`);
  console.log(`  ${excluded.map(c => c.sc).join(', ')}`);
  console.log(`Answer those yourself in npm run audit:manual. A model's opinion on whether`);
  console.log(`captions are accurate or content flashes is not evidence.`);
}
console.log(`\nSaved to ${OUT_FILE}`);
console.log(`\nThen: npm run audit:manual — you record the answers, using the draft as input.`);
console.log(bar);
