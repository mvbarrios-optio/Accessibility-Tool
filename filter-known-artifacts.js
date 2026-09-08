// Sets aside nodes in the axe JSON that are known measurement artifacts for this
// project, NOT real failures. Run AFTER axe-scan and BEFORE generate-report.
//
//   node filter-known-artifacts.js          # or: npm run scan:filter
//
// Nothing is deleted: matched nodes move to `knownArtifacts` inside the same JSON
// (so they stay auditable) and an untouched copy is kept in audits/raw-unfiltered/.
// To undo: copy audits/raw-unfiltered/* back over audits/raw/ and regenerate.
//
// What counts as an artifact is defined per project in known-artifacts.json, which
// ships empty. Only add an entry once you have verified the node by hand and can
// state the evidence — the `reason` field ends up in the audit trail, and an
// unjustified entry is how a real failure disappears from a report.
//
// Note: axe-scan.js already re-measures and flags contrast readings the browser's
// own computed style disagrees with (`measurementWarnings` in the page JSON), so
// reach for this file only for artifacts that survive that check.
const fs = require('fs');
const path = require('path');

const RAW = './audits/raw';
const BACKUP = './audits/raw-unfiltered';
const CONFIG = './known-artifacts.json';

if (!fs.existsSync(CONFIG)) {
  console.error(`✗ ${CONFIG} not found — nothing to filter.`);
  process.exitCode = 1;
  return;
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const entries = (config.artifacts || []).filter(a => a && a.rule && (a.targets || []).length);

if (!entries.length) {
  console.log(`No artifacts configured in ${CONFIG} — nothing to do.`);
  console.log('This is the expected state for a new project: only add an entry for a node');
  console.log('you have verified by hand, with the evidence written into its "reason".');
  return;
}

// An entry matches a node when the rule matches, one of its target patterns is a
// substring of the node's selector, and — if the entry names a foreground colour —
// axe reported that exact colour. The colour condition keeps an entry narrow: the
// same selector failing contrast for a different reason still gets reported.
function matches(entry, node) {
  const target = String(node.target);
  if (!entry.targets.some(t => target.includes(t))) return false;
  if (!entry.fgColor) return true;
  const fg = (((node.any || [])[0] || {}).data || {}).fgColor;
  return fg === entry.fgColor;
}

fs.mkdirSync(BACKUP, { recursive: true });

let movedTotal = 0;
let filesTouched = 0;

for (const file of fs.readdirSync(RAW).filter(f => /-axe.*\.json$/.test(f))) {
  const full = path.join(RAW, file);
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  const violations = data.violations || [];
  const setAside = [];

  for (const violation of [...violations]) {
    const applicable = entries.filter(e => e.rule === violation.id);
    if (!applicable.length) continue;

    violation.nodes = violation.nodes.filter(node => {
      const entry = applicable.find(e => matches(e, node));
      if (!entry) return true;
      setAside.push({ ...node, artifactReason: entry.reason || '(no reason recorded)' });
      movedTotal++;
      return false;
    });

    // A violation whose every node was an artifact is no longer a violation.
    if (!violation.nodes.length) violations.splice(violations.indexOf(violation), 1);
  }

  if (setAside.length) {
    if (!fs.existsSync(path.join(BACKUP, file))) fs.copyFileSync(full, path.join(BACKUP, file));
    data.knownArtifacts = { source: CONFIG, nodes: setAside };
    fs.writeFileSync(full, JSON.stringify(data, null, 2));
    filesTouched++;
  }
}

console.log(`Nodes set aside: ${movedTotal} | files touched: ${filesTouched}`);
if (movedTotal) {
  console.log(`Untouched originals kept in ${BACKUP}/`);
} else {
  console.log('Nothing matched: either already filtered, or axe stopped reporting these nodes.');
  console.log(`If a rule stopped firing, retire its entry from ${CONFIG}.`);
}
