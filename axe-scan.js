const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('fs');
const urls = require('./urls.json');

(async () => {
  fs.mkdirSync('./audits/raw', { recursive: true });
  fs.mkdirSync('./audits/reports', { recursive: true });

  const browser = await chromium.launch();
  const summary = [];

  for (const url of urls) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    const results = await new AxeBuilder({ page }).analyze();

    const name = url.replace(/https?:\/\//, '').replace(/\/$/, '').replace(/\//g, '_') || 'home';
    fs.writeFileSync(`./audits/raw/${name}-axe.json`, JSON.stringify(results, null, 2));

    summary.push({
      url,
      violations: results.violations.length,
      critical: results.violations.filter(v => v.impact === 'critical').length,
      serious: results.violations.filter(v => v.impact === 'serious').length
    });

    await context.close();
    console.log(`✓ Scanned: ${url} (${results.violations.length} violations)`);
  }

  fs.writeFileSync('./audits/reports/axe-summary.json', JSON.stringify(summary, null, 2));
  await browser.close();
})();
