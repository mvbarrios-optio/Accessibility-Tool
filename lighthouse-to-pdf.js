const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const rawDir = './audits/raw';
  const files = fs.readdirSync(rawDir).filter(f => f.endsWith('-lighthouse.report.html'));

  const browser = await chromium.launch();
  for (const file of files) {
    const page = await browser.newPage();
    const filePath = path.resolve(rawDir, file);
    await page.goto(`file://${filePath}`, { waitUntil: 'networkidle' });
    const pdfName = file.replace('.report.html', '.pdf');
    await page.pdf({ path: `./audits/raw/${pdfName}`, format: 'A4', printBackground: true });
    await page.close();
    console.log(`✓ PDF created: ${pdfName}`);
  }
  await browser.close();
})();
