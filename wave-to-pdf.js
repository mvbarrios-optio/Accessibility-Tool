const { launchPdfRenderer } = require('./browsers');
const fs = require('fs');
const path = require('path');

function buildHtml(url, results) {
  const rows = results.categories.map(c => `
    <tr>
      <td>${c.category}</td>
      <td>${c.title}</td>
      <td>${c.summary}</td>
      <td>${c.count}</td>
    </tr>`).join('');

  return `
  <html><head><style>
    body { font-family: -apple-system, Arial, sans-serif; padding: 30px; }
    h1 { font-size: 20px; } h2 { font-size: 14px; color: #555; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { border: 1px solid #ddd; padding: 8px; font-size: 12px; text-align: left; }
    th { background: #f4f4f4; }
    .aim-good { color: #2e7d32; font-weight: bold; }
    .aim-bad { color: #b00020; font-weight: bold; }
  </style></head><body>
    <h1>WAVE Accessibility Report</h1>
    <h2>${results.url}</h2>
    <p>AIM Score: <span class="${results.aimScore >= 7 ? 'aim-good' : 'aim-bad'}">${results.aimScore} / 10</span></p>
    <p>Total items detected: ${results.totalItems}</p>
    <table>
      <tr><th>Category</th><th>Issue Type</th><th>Description</th><th>Count</th></tr>
      ${rows}
    </table>
  </body></html>`;
}

(async () => {
  const rawDir = './audits/raw';
  const files = fs.readdirSync(rawDir).filter(f => f.endsWith('-wave.json'));

  const browser = await launchPdfRenderer();
  for (const file of files) {
    const results = JSON.parse(fs.readFileSync(path.join(rawDir, file)));
    const html = buildHtml(results.url, results);
    const tmpHtmlPath = path.join(rawDir, file.replace('.json', '.html'));
    fs.writeFileSync(tmpHtmlPath, html);

    const page = await browser.newPage();
    await page.goto(`file://${path.resolve(tmpHtmlPath)}`);
    const pdfName = file.replace('.json', '.pdf');
    await page.pdf({ path: `./audits/raw/${pdfName}`, format: 'A4', printBackground: true });
    await page.close();
    console.log(`✓ PDF created: ${pdfName}`);
  }
  await browser.close();
})();
