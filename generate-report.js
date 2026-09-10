// generate-report.js — merges every result source in this toolkit into one
// findings report, organised by WCAG 2.2 success criterion:
//
//   audits/raw/<page>-axe-<engine>.json     (axe-scan.js)
//   audits/raw/<page>-extra.json            (extra-checks.js)
//   audits/reports/extra-summary.json       (extra-checks.js site-level checks)
//   audits/raw/<page>-snippet.json          (console-snippet.js, saved by hand)
//   audits/raw/<page>-lighthouse.report.json (lighthouse-scan.sh, score only)
//   audits/manual/manual-results.json       (manual-audit.js)
//
// Output:
//   audits/reports/findings-report.md   -> give this file to Claude for the fix guide
//   audits/reports/findings.json        -> full machine-readable detail
//
// Usage:
//   node generate-report.js
//   node generate-report.js --label "Baseline 2026-08" --site "www.example.com"
//
// The report ends with ready-to-use instructions (and a prompt) for turning it
// into a step-by-step fix guide with Claude.

const fs = require('fs');
const path = require('path');
const criteriaData = require('./criteria.json');

const RAW_DIR = './audits/raw';
const REPORTS_DIR = './audits/reports';
const MANUAL_FILE = './audits/manual/manual-results.json';
const MAX_DETAILS_PER_SC = 15;

const args = process.argv.slice(2);
const flag = name => {
  const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return null;
  return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1];
};
const LABEL = flag('label') || `Audit ${new Date().toISOString().slice(0, 10)}`;

const SC_LIST = criteriaData.criteria.map(c => c.sc);
const bySc = Object.fromEntries(criteriaData.criteria.map(c => [c.sc, c]));

// findings[sc] = [{source, page, engine?, rule?, impact?, severity, note, selector?, html?}]
const findings = {};
const reviews = {};
const testedBy = {}; // sc -> Set of sources that produced data covering it
const addTested = (sc, src) => { (testedBy[sc] = testedBy[sc] || new Set()).add(src); };
const add = (bucket, sc, item) => {
  if (!bySc[sc]) return;
  (bucket[sc] = bucket[sc] || []).push(item);
};

function listRaw(suffixRe) {
  if (!fs.existsSync(RAW_DIR)) return [];
  return fs.readdirSync(RAW_DIR).filter(f => suffixRe.test(f));
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.warn(`  ! skipping unreadable ${file}: ${e.message}`); return null; }
}

// ── 1. axe results ───────────────────────────────────────────────────────────
const tagToSc = tag => {
  const m = tag.match(/^wcag(\d)(\d)(\d+)$/);
  if (!m) return null;
  const sc = `${m[1]}.${m[2]}.${m[3]}`;
  return SC_LIST.includes(sc) ? sc : null;
};
const impactSeverity = i => i === 'critical' || i === 'serious' ? 'high' : i === 'moderate' ? 'medium' : 'low';

const axeFiles = listRaw(/-axe(-\w+)?\.json$/);
const axeAgg = {}; // ruleId|page -> {sc[], rule, help, impact, page, engines[], nodes[]}
let axePages = new Set();
for (const f of axeFiles) {
  const m = f.match(/^(.*)-axe(?:-(\w+))?\.json$/);
  const page = m[1], engine = m[2] || 'chromium';
  const data = readJson(path.join(RAW_DIR, f));
  if (!data || !Array.isArray(data.violations)) continue;
  axePages.add(page);
  for (const v of data.violations) {
    const scs = [...new Set((v.tags || []).map(tagToSc).filter(Boolean))];
    if (!scs.length) continue; // best-practice rule with no WCAG mapping
    const key = `${v.id}|${page}`;
    if (!axeAgg[key]) axeAgg[key] = {
      scs, rule: v.id, help: v.help, impact: v.impact, page,
      engines: [], nodes: (v.nodes || []).slice(0, 3).map(n => ({
        selector: (n.target || []).join(' '), html: (n.html || '').replace(/\s+/g, ' ').slice(0, 100)
      })), nodeCount: (v.nodes || []).length
    };
    if (!axeAgg[key].engines.includes(engine)) axeAgg[key].engines.push(engine);
    axeAgg[key].nodeCount = Math.max(axeAgg[key].nodeCount, (v.nodes || []).length);
  }
}
if (axePages.size) for (const c of criteriaData.criteria) if (c.coverage.axe) addTested(c.sc, 'axe');
for (const v of Object.values(axeAgg)) {
  for (const sc of v.scs) add(findings, sc, {
    source: 'axe', page: v.page, severity: impactSeverity(v.impact),
    note: `[${v.rule}] ${v.help} — ${v.nodeCount} element(s), engines: ${v.engines.join('/')}`,
    elements: v.nodes
  });
}

// ── 2. extra-checks + snippet results (same check shape) ────────────────────
// A snippet run on a page extra-checks already covered repeats the same checks;
// keep the first occurrence of each (check, page) instead of double-reporting.
const seenCheck = new Set();
function ingestChecks(page, checks, source) {
  for (const chk of checks || []) {
    const dupKey = `${chk.id}|${page}`;
    if (seenCheck.has(dupKey)) continue;
    seenCheck.add(dupKey);
    for (const sc of chk.sc || []) {
      if (!bySc[sc]) continue;
      addTested(sc, source);
      if (chk.status === 'fail' || chk.status === 'review') {
        const item = {
          source: `${source}:${chk.id}`, page,
          severity: chk.status === 'fail' ? 'medium' : 'low',
          note: chk.summary,
          elements: (chk.details || []).slice(0, 5).map(d => ({ selector: d.selector, html: d.html, detail: d.note })),
          totalDetails: chk.totalDetails || (chk.details || []).length
        };
        add(chk.status === 'fail' ? findings : reviews, sc, item);
      }
    }
  }
}
const extraFiles = listRaw(/-extra\.json$/);
for (const f of extraFiles) {
  const data = readJson(path.join(RAW_DIR, f));
  if (data) ingestChecks(data.page, data.checks, 'extra');
}
const extraSummary = readJson(path.join(REPORTS_DIR, 'extra-summary.json'));
if (extraSummary) ingestChecks('(site-wide)', extraSummary.siteChecks, 'extra');

const snippetFiles = listRaw(/-snippet\.json$/);
for (const f of snippetFiles) {
  const data = readJson(path.join(RAW_DIR, f));
  if (data) ingestChecks(data.page + (data.state && !/^NOTE:/.test(data.state) ? ` [${data.state}]` : ''), data.checks, 'snippet');
}

// ── 3. manual results ────────────────────────────────────────────────────────
const manual = fs.existsSync(MANUAL_FILE) ? readJson(MANUAL_FILE) : null;
const manualEntries = (manual && manual.entries) || {};
for (const [sc, e] of Object.entries(manualEntries)) {
  if (!bySc[sc]) continue;
  addTested(sc, 'manual');
  if (e.result === 'fail') add(findings, sc, {
    source: 'manual', page: e.pages || '?', severity: e.severity || 'medium',
    note: `${e.issue || 'manual fail'}${e.component ? ` (${e.component})` : ''}`,
    evidence: e.evidence || null, testedBy: e.testedBy, date: e.date
  });
}

// ── 4. Lighthouse scores (context only) ──────────────────────────────────────
const lhScores = [];
for (const f of listRaw(/-lighthouse\.report\.json$/)) {
  const data = readJson(path.join(RAW_DIR, f));
  const score = data && data.categories && data.categories.accessibility && data.categories.accessibility.score;
  if (score != null) lhScores.push({ page: f.replace(/-lighthouse\.report\.json$/, ''), score: Math.round(score * 100) });
}

// ── 5. Status per criterion ──────────────────────────────────────────────────
const rows = criteriaData.criteria.map(c => {
  const f = findings[c.sc] || [];
  const r = reviews[c.sc] || [];
  const m = manualEntries[c.sc];
  const sources = [...(testedBy[c.sc] || [])];
  let status;
  if (m && m.result === 'na') status = f.length ? 'fail' : 'na';
  else if (f.length) status = 'fail';
  // A person looked and could not judge it. Never a pass, and distinct from
  // 'auto-clean' (nobody looked yet) so the report can name who to hand it to.
  else if (m && m.result === 'unsure') status = 'needs-expert';
  else if (m && m.result === 'pass') status = r.length ? 'review' : 'pass';
  else if (r.length) status = 'review';
  else if (sources.length && !c.coverage.manual) status = 'pass';
  else if (sources.length) status = 'auto-clean'; // automated found nothing, manual pending
  else status = 'not-tested';
  return { sc: c.sc, name: c.name, level: c.level, status, sources, findings: f, reviews: r, manual: m || null };
});

const count = s => rows.filter(r => r.status === s).length;
const totals = {
  fail: count('fail'), review: count('review'), pass: count('pass'),
  autoClean: count('auto-clean'), notTested: count('not-tested'), na: count('na'),
  needsExpert: count('needs-expert')
};

// ── 6. Markdown report ───────────────────────────────────────────────────────
const siteGuess = (() => {
  try { return new URL(require('./urls.json')[0]).host; } catch (e) { return '(site)'; }
})();
const SITE = flag('site') || siteGuess;
const STATUS_LABEL = {
  fail: '❌ FAIL', review: '⚠️ REVIEW', pass: '✅ PASS',
  'auto-clean': '🔎 AUTO-CLEAN*', 'not-tested': '⬜ NOT TESTED', na: '➖ N/A',
  'needs-expert': '🙋 NEEDS EXPERT'
};

let md = `# Accessibility Findings Report — ${SITE}

**Standard:** WCAG 2.2 Level A + AA (55 criteria) · **Run:** ${LABEL} · **Generated:** ${new Date().toISOString().slice(0, 10)}

**Sources merged into this report:**

| Source | Data found |
|---|---|
| axe-core (axe-scan.js) | ${axeFiles.length ? `${axeFiles.length} file(s), ${axePages.size} page(s)` : '— none found'} |
| extra-checks.js | ${extraFiles.length ? `${extraFiles.length} page(s)` + (extraSummary ? ' + site-level checks' : '') : '— none found'} |
| console snippet | ${snippetFiles.length ? `${snippetFiles.length} page-state(s)` : '— none found'} |
| manual-audit.js | ${Object.keys(manualEntries).length ? `${Object.keys(manualEntries).length}/${criteriaData.criteria.filter(c => c.coverage.manual).length} criteria answered` : '— none found'} |
| Lighthouse | ${lhScores.length ? `${lhScores.length} page(s), avg score ${Math.round(lhScores.reduce((a, b) => a + b.score, 0) / lhScores.length)}/100` : '— none found'} |

## Result: ${totals.fail} failing criteria of ${criteriaData.criteria.length}

| Status | Count | Meaning |
|---|---|---|
| ❌ FAIL | ${totals.fail} | At least one confirmed issue — fix required |
| ⚠️ REVIEW | ${totals.review} | Automated flags that need human confirmation |
| ✅ PASS | ${totals.pass} | Verified passing |
| 🔎 AUTO-CLEAN* | ${totals.autoClean} | Automated checks found nothing, but the manual check is still pending — NOT yet a pass |
| 🙋 NEEDS EXPERT | ${totals.needsExpert} | A person reviewed it but could not judge it — needs accessibility expertise |
| ⬜ NOT TESTED | ${totals.notTested} | No data from any source — coverage gap |
| ➖ N/A | ${totals.na} | Marked not applicable in the manual audit |

${(totals.autoClean || totals.notTested || totals.needsExpert) ? `> **Coverage warning:** ${totals.autoClean + totals.notTested + totals.needsExpert} criteria are not fully verified yet. Run \`npm run audit:manual\` to close the gap — an audit is not complete until every row is FAIL, PASS or N/A.${totals.needsExpert ? ` ${totals.needsExpert} of them were looked at but could not be judged without accessibility expertise; those are listed separately below.` : ''}\n` : '> Full coverage: every criterion has a definitive result.\n'}
## Checklist — all 55 criteria

| SC | Criterion | Level | Status | Verified by |
|---|---|---|---|---|
`;
for (const r of rows) {
  md += `| ${r.sc} | ${r.name} | ${r.level} | ${STATUS_LABEL[r.status]} | ${r.sources.join(', ') || '—'} |\n`;
}

// Failures detail
const failRows = rows.filter(r => r.status === 'fail');
md += `\n## Failures in detail\n`;
if (!failRows.length) md += `\nNo confirmed failures. 🎉\n`;
for (const r of failRows) {
  const c = bySc[r.sc];
  md += `\n### ❌ ${r.sc} ${r.name} (Level ${r.level})\n\n`;
  md += `*Requirement:* ${c.meaning}\n\n`;
  const sevRank = { high: 0, medium: 1, low: 2 };
  const items = [...r.findings].sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  let shown = 0;
  for (const it of items) {
    if (shown >= MAX_DETAILS_PER_SC) break;
    md += `- **[${it.severity}]** \`${it.page}\` — ${it.note}${it.testedBy ? ` *(manual: ${it.testedBy}, ${it.date})*` : ''}${it.evidence ? ` — evidence: ${it.evidence}` : ''}\n`;
    for (const el of (it.elements || []).slice(0, 3)) {
      md += `  - \`${el.selector || '?'}\`${el.detail ? ` — ${el.detail}` : ''}${el.html ? ` — \`${el.html.replace(/`/g, "'")}\`` : ''}\n`;
    }
    shown++;
  }
  if (items.length > shown) md += `- …and ${items.length - shown} more (see findings.json)\n`;
}

// Review detail
const reviewRows = rows.filter(r => r.status === 'review' || (r.reviews.length && r.status !== 'fail'));
if (reviewRows.length) {
  md += `\n## Needs human confirmation (automated flags)\n`;
  for (const r of reviewRows) {
    md += `\n### ⚠️ ${r.sc} ${r.name}\n\n`;
    for (const it of r.reviews.slice(0, 8)) {
      md += `- \`${it.page}\` — ${it.note}\n`;
      for (const el of (it.elements || []).slice(0, 3)) {
        md += `  - \`${el.selector || '?'}\`${el.detail ? ` — ${el.detail}` : ''}\n`;
      }
    }
  }
}

// Coverage gaps
const gapRows = rows.filter(r => r.status === 'auto-clean' || r.status === 'not-tested');
if (gapRows.length) {
  md += `\n## Coverage gaps — still to verify\n\n`;
  for (const r of gapRows) {
    const c = bySc[r.sc];
    md += `- **${r.sc} ${r.name}** — ${r.status === 'not-tested' ? 'no data from any source' : `automated checks clean (${r.sources.join(', ')}), manual check pending`}. First step: ${c.manualSteps[0] || 'see criteria.json'}\n`;
  }
}

// Needs-expert handover list: named separately because these are not "nobody
// got to it yet" — someone tried, and recorded why they could not decide.
const expertRows = rows.filter(r => r.status === 'needs-expert');
if (expertRows.length) {
  md += `\n## Needs accessibility expertise (${expertRows.length})\n\n`;
  md += `Someone reviewed these and could not judge them. They are open gaps, not passes.\n\n`;
  for (const r of expertRows) {
    const c = bySc[r.sc];
    md += `- **${r.sc} ${r.name}** (Level ${r.level})`;
    if (r.manual && r.manual.note) md += ` — blocked on: ${r.manual.note}`;
    md += `\n  - What it requires: ${c.meaning}\n`;
    md += `  - How to test: ${c.manualSteps[0] || 'see criteria.json'}\n`;
  }
}

// Lighthouse annex
if (lhScores.length) {
  md += `\n## Annex: Lighthouse accessibility scores (Chromium)\n\n| Page | Score |\n|---|---|\n`;
  for (const s of lhScores.sort((a, b) => a.score - b.score)) md += `| ${s.page} | ${s.score}/100 |\n`;
}

// Fix-guide instructions (for Claude)
md += `
---

## Turning this report into a fix guide (with Claude)

This report is written so that Claude can turn it into a step-by-step fix guide.

1. Start a conversation with Claude and attach this file (\`findings-report.md\`).
   Attach \`findings.json\` too if you want the underlying detail.
2. Paste this prompt:

> You are a web accessibility and WCAG 2.2 expert. Attached is the findings report from
> our audit. Produce a **fix guide** any developer can follow without prior accessibility
> knowledge. For every failing criterion, give: (1) what is wrong and who it affects,
> (2) the exact fix with before/after code, using the CSS selectors from the report,
> (3) how to verify it is fixed, step by step, including keyboard and screen reader
> checks where they apply, and (4) priority and estimated effort. Order by impact,
> highest first. End with the criteria still awaiting verification and how to close them.
> Format: a Markdown document grouped into phases, with one row per fix ready to paste
> into an issue tracker.

3. With the fix guide in hand: log every correction in your change log (one row per
   change, with before/after screenshots), then re-run the full pass
   (\`axe-scan\` + \`extra-checks\` + \`manual-audit\`) for the retest.
`;

// ── 7. Write outputs ─────────────────────────────────────────────────────────
fs.mkdirSync(REPORTS_DIR, { recursive: true });
const mdFile = path.join(REPORTS_DIR, 'findings-report.md');
const jsonFile = path.join(REPORTS_DIR, 'findings.json');
fs.writeFileSync(mdFile, md);
fs.writeFileSync(jsonFile, JSON.stringify({
  site: SITE, label: LABEL, generatedAt: new Date().toISOString(),
  totals, criteria: rows
}, null, 2));

console.log(`findings-report.md — ${SITE} — ${LABEL}`);
console.log(`  ❌ fail: ${totals.fail}   ⚠️ review: ${totals.review}   ✅ pass: ${totals.pass}   🔎 auto-clean: ${totals.autoClean}   🙋 needs expert: ${totals.needsExpert}   ⬜ not tested: ${totals.notTested}   ➖ n/a: ${totals.na}`);
console.log(`\nWritten:\n  ${mdFile}\n  ${jsonFile}`);
if (totals.autoClean + totals.notTested + totals.needsExpert > 0) {
  console.log(`\n⚠ ${totals.autoClean + totals.notTested + totals.needsExpert} criteria still unverified — run: npm run audit:manual`);
  if (totals.needsExpert) {
    console.log(`  ${totals.needsExpert} of those need accessibility expertise — see "Needs accessibility expertise" in the report.`);
  }
}
console.log(`\nNext: give findings-report.md to Claude to generate the fix guide (instructions are at the end of the report).`);
