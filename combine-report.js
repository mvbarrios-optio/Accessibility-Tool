const fs = require('fs');

const axeSummary = JSON.parse(fs.readFileSync('./audits/reports/axe-summary.json'));
const rawDir = './audits/raw';

const rows = axeSummary.map(entry => {
  const name = entry.url.replace(/https?:\/\//, '').replace(/\/$/, '').replace(/\//g, '_') || 'home';
  const lhPath = `${rawDir}/${name}-lighthouse.report.json`;
  let lhScore = 'N/A';
  if (fs.existsSync(lhPath)) {
    const lh = JSON.parse(fs.readFileSync(lhPath));
    lhScore = Math.round(lh.categories.accessibility.score * 100);
  }
  return {
    url: entry.url,
    axeViolations: entry.violations,
    axeCritical: entry.critical,
    axeSerious: entry.serious,
    lighthouseScore: lhScore,
    waveErrors: '',
    waveContrastErrors: '',
    waveAlerts: ''
  };
});

fs.writeFileSync('./audits/reports/combined-summary.json', JSON.stringify(rows, null, 2));

const csv = ['URL,Axe Violations,Axe Critical,Axe Serious,Lighthouse Score,WAVE Errors,WAVE Contrast Errors,WAVE Alerts']
  .concat(rows.map(r => `${r.url},${r.axeViolations},${r.axeCritical},${r.axeSerious},${r.lighthouseScore},${r.waveErrors},${r.waveContrastErrors},${r.waveAlerts}`))
  .join('\n');
fs.writeFileSync('./audits/reports/combined-summary.csv', csv);

console.log('✓ Combined report written to audits/reports/');
