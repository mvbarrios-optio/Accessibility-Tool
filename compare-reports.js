// Compares two audit passes and says what was actually fixed:
//
//   npm run report:compare -- <baseline.json> <retest.json>
//   node compare-reports.js audits/reports/findings-baseline.json audits/reports/findings.json
//
// Both arguments are findings.json files written by generate-report.js. The
// first is the earlier pass. Writes audits/reports/comparison-report.md and
// prints a summary.
//
// This is the evidence a retest is for: "here are the problems" is the baseline's
// job, "here is proof they are gone" is this one's. It reports four things —
// findings fixed, findings that are new (regressions), findings still present,
// and criteria whose overall status moved.
//
// The one thing it refuses to do is call something fixed when it cannot tell.
// A finding that disappears because its page was not scanned in the second pass
// is not a fix, so pages are compared first and anything resting on a dropped
// page is reported separately rather than counted as progress.
const fs = require('fs');
const path = require('path');

const REPORTS_DIR = './audits/reports';
const OUT_FILE = path.join(REPORTS_DIR, 'comparison-report.md');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));

const USAGE = `Usage: node compare-reports.js <baseline-findings.json> <retest-findings.json>

Both files are findings.json, written by generate-report.js. The first is the
earlier pass.

Keep each pass's findings.json before regenerating, e.g.:
  cp audits/reports/findings.json audits/reports/findings-baseline.json`;

if (args.length !== 2) {
  console.error(args.length ? '✗ Two files are needed: the baseline and the retest.\n' : '');
  console.error(USAGE);
  process.exit(1);
}

function load(file, which) {
  if (!fs.existsSync(file)) {
    console.error(`✗ ${which} file not found: ${file}\n`);
    console.error('  It is written by generate-report.js as audits/reports/findings.json.');
    console.error('  Copy it to another name before the next pass overwrites it.');
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`✗ Could not read ${file} — ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(data.criteria)) {
    console.error(`✗ ${file} is not a findings.json (no "criteria" array).`);
    process.exit(1);
  }
  return data;
}

const before = load(args[0], 'Baseline');
const after = load(args[1], 'Retest');

// ── Sanity checks, before anything is claimed ────────────────────────────────
const warnings = [];

if (before.site && after.site && before.site !== after.site) {
  warnings.push(`These are different sites — ${before.site} vs ${after.site}. `
    + `Comparing them says nothing about either.`);
}
if (before.label && before.label === after.label) {
  warnings.push(`Both passes carry the same label ("${before.label}"), so the report `
    + `cannot tell them apart. Use --label to name each pass.`);
}
if (before.generatedAt && after.generatedAt && after.generatedAt < before.generatedAt) {
  warnings.push(`The "retest" was generated before the "baseline" `
    + `(${after.generatedAt} < ${before.generatedAt}). The arguments may be the wrong way round.`);
}

// Scope changes are the dangerous one: a finding on a page that was not scanned
// again has not been fixed, it has been stopped being looked at.
const beforePages = new Set(before.pages || []);
const afterPages = new Set(after.pages || []);
const pagesKnown = beforePages.size > 0 && afterPages.size > 0;
const droppedPages = [...beforePages].filter(p => !afterPages.has(p));
const addedPages = [...afterPages].filter(p => !beforePages.has(p));

if (!pagesKnown) {
  warnings.push(`One of the files predates page tracking, so a finding that vanished `
    + `because its page was not scanned cannot be told from one that was fixed. `
    + `Re-run generate-report.js on both passes if you still have their raw data.`);
}

// ── Finding identity ─────────────────────────────────────────────────────────
// A finding is the same finding across passes when it is the same rule, on the
// same page, under the same criterion. The element count deliberately is NOT
// part of the key: going from 3 bad elements to 1 is the same finding, partly
// fixed, and that is worth reporting as progress rather than as a new problem.
function issueId(note) {
  const text = String(note || '');
  const ruleId = text.match(/^\[([^\]]+)\]/);
  if (ruleId) return ruleId[1];
  // Non-axe sources: strip the volatile tail that carries counts and engines.
  return text.replace(/\s+—\s+\d+\s+element\(s\).*$/, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function indexFindings(report) {
  const map = new Map();
  for (const c of report.criteria) {
    for (const f of c.findings || []) {
      const key = `${c.sc}||${f.page}||${issueId(f.note)}`;
      // Same rule reported by two sources on one page is one problem.
      const existing = map.get(key);
      const elements = (f.elements || []).length;
      if (existing) {
        existing.elements = Math.max(existing.elements, elements);
        continue;
      }
      map.set(key, {
        sc: c.sc, name: c.name, level: c.level, page: f.page,
        note: f.note, severity: f.severity, source: f.source, elements
      });
    }
  }
  return map;
}

const beforeFindings = indexFindings(before);
const afterFindings = indexFindings(after);

const fixed = [];
const stillPresent = [];
const unverifiable = [];   // gone, but its page was not scanned again

for (const [key, f] of beforeFindings) {
  if (afterFindings.has(key)) {
    const now = afterFindings.get(key);
    stillPresent.push({ ...f, elementsAfter: now.elements, severityAfter: now.severity });
  } else if (pagesKnown && !afterPages.has(f.page)) {
    unverifiable.push(f);
  } else {
    fixed.push(f);
  }
}

const regressions = [];
for (const [key, f] of afterFindings) {
  if (beforeFindings.has(key)) continue;
  // A finding on a page that is new to this pass is not a regression; it was
  // simply never measured before.
  regressions.push({ ...f, onNewPage: pagesKnown && !beforePages.has(f.page) });
}

const newFindings = regressions.filter(r => !r.onNewPage);
const onNewPages = regressions.filter(r => r.onNewPage);

// ── Criterion-level status movement ──────────────────────────────────────────
const statusOf = (report) => new Map(report.criteria.map(c => [c.sc, c]));
const beforeStatus = statusOf(before);
const afterStatus = statusOf(after);

const RANK = { fail: 0, review: 1, 'needs-expert': 2, 'not-tested': 3, 'auto-clean': 4, na: 5, pass: 6 };
const LABEL = {
  fail: '❌ FAIL', review: '⚠️ REVIEW', pass: '✅ PASS', 'auto-clean': '🔎 AUTO-CLEAN',
  'needs-expert': '🙋 NEEDS EXPERT', 'not-tested': '⬜ NOT TESTED', na: '➖ N/A'
};

const moved = [];
for (const [sc, b] of beforeStatus) {
  const a = afterStatus.get(sc);
  if (!a || a.status === b.status) continue;
  moved.push({
    sc, name: b.name, level: b.level, from: b.status, to: a.status,
    better: (RANK[a.status] ?? 9) > (RANK[b.status] ?? 9)
  });
}

// ── Report ───────────────────────────────────────────────────────────────────
const bySeverity = (a, b) => {
  const order = { high: 0, medium: 1, low: 2 };
  return (order[a.severity] ?? 3) - (order[b.severity] ?? 3) || a.sc.localeCompare(b.sc);
};

const line = f => `- **${f.sc} ${f.name}** · \`${f.page}\`\n  - ${f.note}`;

let md = `# Retest comparison — ${after.site || 'site'}\n\n`;
md += `**Baseline:** ${before.label || '(unlabelled)'} · ${(before.generatedAt || '').slice(0, 10)}\n`;
md += `**Retest:** ${after.label || '(unlabelled)'} · ${(after.generatedAt || '').slice(0, 10)}\n\n`;

if (warnings.length) {
  md += `> **Read this first**\n`;
  for (const w of warnings) md += `> - ${w}\n`;
  md += `\n`;
}

md += `| | Baseline | Retest |\n|---|---|---|\n`;
md += `| Failing criteria | ${before.totals?.fail ?? '?'} | ${after.totals?.fail ?? '?'} |\n`;
md += `| Verified passing | ${before.totals?.pass ?? '?'} | ${after.totals?.pass ?? '?'} |\n`;
md += `| Individual findings | ${beforeFindings.size} | ${afterFindings.size} |\n`;
md += `| Pages scanned | ${beforePages.size || '?'} | ${afterPages.size || '?'} |\n\n`;

md += `## Result\n\n`;
md += `- ✅ **${fixed.length} fixed**\n`;
md += `- ❌ **${newFindings.length} new** (regressions on pages both passes covered)\n`;
md += `- ➖ **${stillPresent.length} still present**\n`;
if (unverifiable.length) md += `- ⚠️ **${unverifiable.length} cannot be verified** — their page was not scanned again\n`;
if (onNewPages.length) md += `- ℹ️ **${onNewPages.length} on pages new to this pass** — not regressions, just newly measured\n`;
md += `\n`;

if (droppedPages.length || addedPages.length) {
  md += `## Scope changed between passes\n\n`;
  if (droppedPages.length) {
    md += `**${droppedPages.length} page(s) in the baseline were not scanned again.** Findings on them `
      + `are reported as unverified, not as fixed:\n\n`;
    for (const p of droppedPages) md += `- \`${p}\`\n`;
    md += `\n`;
  }
  if (addedPages.length) {
    md += `**${addedPages.length} page(s) are new in this pass:**\n\n`;
    for (const p of addedPages) md += `- \`${p}\`\n`;
    md += `\n`;
  }
  md += `A baseline and a retest covering different pages are not directly comparable. `
    + `Scan the same list both times where you can.\n\n`;
}

if (fixed.length) {
  md += `## ✅ Fixed (${fixed.length})\n\n`;
  for (const f of fixed.sort(bySeverity)) md += `${line(f)}\n`;
  md += `\n`;
}

if (newFindings.length) {
  md += `## ❌ New — regressions (${newFindings.length})\n\n`;
  md += `These were not in the baseline and are on pages both passes covered.\n\n`;
  for (const f of newFindings.sort(bySeverity)) md += `${line(f)}\n`;
  md += `\n`;
}

if (stillPresent.length) {
  const improved = stillPresent.filter(f => f.elementsAfter < f.elements);
  const worse = stillPresent.filter(f => f.elementsAfter > f.elements);
  md += `## ➖ Still present (${stillPresent.length})\n\n`;
  if (improved.length) md += `${improved.length} affect fewer elements than before, `
    + `${worse.length} affect more.\n\n`;
  for (const f of stillPresent.sort(bySeverity)) {
    const delta = f.elementsAfter === f.elements ? ''
      : ` — elements ${f.elements} → ${f.elementsAfter}${f.elementsAfter < f.elements ? ' (improved)' : ' (worse)'}`;
    md += `${line(f)}${delta}\n`;
  }
  md += `\n`;
}

if (unverifiable.length) {
  md += `## ⚠️ Cannot be verified (${unverifiable.length})\n\n`;
  md += `Present in the baseline and absent now — but their page was not scanned in this `
    + `pass, so there is no evidence either way. Scan these pages before calling them fixed.\n\n`;
  for (const f of unverifiable.sort(bySeverity)) md += `${line(f)}\n`;
  md += `\n`;
}

if (onNewPages.length) {
  md += `## ℹ️ On pages new to this pass (${onNewPages.length})\n\n`;
  for (const f of onNewPages.sort(bySeverity)) md += `${line(f)}\n`;
  md += `\n`;
}

if (moved.length) {
  md += `## Criterion status changes (${moved.length})\n\n`;
  md += `| SC | Criterion | Level | Baseline | Retest | |\n|---|---|---|---|---|---|\n`;
  for (const m of moved.sort((a, b) => a.sc.localeCompare(b.sc))) {
    md += `| ${m.sc} | ${m.name} | ${m.level} | ${LABEL[m.from] || m.from} | ${LABEL[m.to] || m.to} | ${m.better ? '↑' : '↓'} |\n`;
  }
  md += `\n`;
}

const stillOpen = (after.totals?.autoClean ?? 0) + (after.totals?.notTested ?? 0)
  + (after.totals?.needsExpert ?? 0);
if (stillOpen) {
  md += `## Coverage\n\n`;
  md += `${stillOpen} criteria in the retest are still not definitively verified `
    + `(${after.totals.autoClean} auto-clean, ${after.totals.needsExpert} needing expertise, `
    + `${after.totals.notTested} untested). A retest inherits the baseline's coverage gaps — `
    + `closing them needs \`npm run audit:manual\`, not another scan.\n`;
}

fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, md);

// ── Console summary ──────────────────────────────────────────────────────────
console.log(`\n${before.label || 'baseline'}  →  ${after.label || 'retest'}`);
console.log(`${'─'.repeat(60)}`);
for (const w of warnings) console.log(`⚠ ${w}`);
if (warnings.length) console.log('');
console.log(`  ✅ fixed:           ${fixed.length}`);
console.log(`  ❌ new regressions: ${newFindings.length}`);
console.log(`  ➖ still present:   ${stillPresent.length}`);
if (unverifiable.length) console.log(`  ⚠️  unverifiable:    ${unverifiable.length}  (page not scanned again)`);
if (onNewPages.length) console.log(`  ℹ️  on new pages:    ${onNewPages.length}`);
console.log(`  criteria failing:  ${before.totals?.fail ?? '?'} → ${after.totals?.fail ?? '?'}`);
console.log(`${'─'.repeat(60)}`);
console.log(`Written: ${OUT_FILE}`);

// A regression should be visible to whatever runs this, not just readable.
if (newFindings.length) process.exitCode = 1;
