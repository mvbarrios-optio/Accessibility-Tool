const fs = require('fs');
const path = require('path');
const { launchPdfRenderer, labelFor, parseToolFilename } = require('./browsers');

function buildHtml(url, engineKey, results) {
  const rows = results.violations.map(v => `
    <tr>
      <td class="impact-${v.impact || 'none'}">${v.impact || 'n/a'}</td>
      <td>${v.id}</td>
      <td>${v.help}</td>
      <td>${v.nodes.length}</td>
    </tr>`).join('');

  const env = results.testEnvironment || {};
  const engineLine = [labelFor(engineKey), env.userAgent].filter(Boolean).join(' — ');

  return `
  <html><head><style>
    body { font-family: -apple-system, Arial, sans-serif; padding: 30px; }
    h1 { font-size: 20px; } h2 { font-size: 14px; color: #555; }
    .engine { font-size: 11px; color: #666; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { border: 1px solid #ddd; padding: 8px; font-size: 12px; text-align: left; }
    th { background: #f4f4f4; }
    .impact-critical { color: #b00020; font-weight: bold; }
    .impact-serious { color: #c05600; font-weight: bold; }
  </style></head><body>
    <h1>Axe Accessibility Report</h1>
    <h2>${url}</h2>
    <p class="engine">Browser engine: ${engineLine}</p>
    <p>Total violations: ${results.violations.length}</p>
    <table>
      <tr><th>Impact</th><th>Rule ID</th><th>Description</th><th>Elements affected</th></tr>
      ${rows}
    </table>
  </body></html>`;
}

(async () => {
  const rawDir = './audits/raw';
  const files = fs.readdirSync(rawDir)
    .map(f => ({ file: f, parsed: parseToolFilename(f, 'axe', 'json') }))
    .filter(entry => entry.parsed)
    .sort((a, b) => a.file.localeCompare(b.file));

  if (!files.length) {
    console.log('No axe JSON found in audits/raw — run `node axe-scan.js` first.');
    return;
  }

  const browser = await launchPdfRenderer();
  for (const { file, parsed } of files) {
    const results = JSON.parse(fs.readFileSync(path.join(rawDir, file)));
    const html = buildHtml(results.url, parsed.engineKey, results);
    const tmpHtmlPath = path.join(rawDir, file.replace(/\.json$/, '.html'));
    fs.writeFileSync(tmpHtmlPath, html);

    const page = await browser.newPage();
    await page.goto(`file://${path.resolve(tmpHtmlPath)}`);
    // Keeps the input naming: <page>-axe-<engine>.json -> <page>-axe-<engine>.pdf
    const pdfName = file.replace(/\.json$/, '.pdf');
    await page.pdf({ path: path.join(rawDir, pdfName), format: 'A4', printBackground: true });
    await page.close();
    console.log(`✓ PDF created: ${pdfName}`);
  }
  await browser.close();
})();
