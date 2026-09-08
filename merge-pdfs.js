const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { ENGINE_KEYS, labelFor, parseToolFilename } = require('./browsers');

async function appendPdf(merged, filePath) {
  const doc = await PDFDocument.load(fs.readFileSync(filePath));
  const pages = await merged.copyPages(doc, doc.getPageIndices());
  pages.forEach(p => merged.addPage(p));
}

(async () => {
  const rawDir = './audits/raw';
  const reportsDir = './audits/reports';
  fs.mkdirSync(reportsDir, { recursive: true });

  // base page name -> { engineKey: axePdfFile }
  const pages = new Map();
  for (const file of fs.readdirSync(rawDir).sort()) {
    const parsed = parseToolFilename(file, 'axe', 'pdf');
    if (!parsed) continue;
    const byEngine = pages.get(parsed.base) || {};
    const existing = byEngine[parsed.engineKey];
    if (existing) {
      // A suffixed file wins over a legacy unsuffixed one for the same engine.
      if (parsed.legacy) {
        console.log(`  (ignoring legacy ${file}, superseded by ${existing})`);
        continue;
      }
      console.log(`  (using ${file} instead of legacy ${existing})`);
    }
    byEngine[parsed.engineKey] = file;
    pages.set(parsed.base, byEngine);
  }

  if (!pages.size) {
    console.log('No axe PDFs found in audits/raw — run `node axe-to-pdf.js` first.');
    return;
  }

  for (const base of [...pages.keys()].sort()) {
    const byEngine = pages.get(base);
    const lhPath = path.join(rawDir, `${base}-lighthouse.pdf`);
    const wavePath = path.join(rawDir, `${base}-wave.pdf`);
    if (!fs.existsSync(lhPath)) {
      console.log(`- Skipped ${base}: no Lighthouse PDF (${base}-lighthouse.pdf)`);
      continue;
    }

    const merged = await PDFDocument.create();
    const engines = ENGINE_KEYS.filter(key => byEngine[key]);
    for (const key of engines) {
      await appendPdf(merged, path.join(rawDir, byEngine[key]));
    }
    await appendPdf(merged, lhPath);

    if (fs.existsSync(wavePath)) {
      await appendPdf(merged, wavePath);
    } else {
      console.log(`  (no WAVE report found for ${base}, merging axe + lighthouse only)`);
    }

    const outPath = path.join(reportsDir, `${base}-full-report.pdf`);
    fs.writeFileSync(outPath, await merged.save());
    console.log(`✓ Merged: ${base}-full-report.pdf (axe: ${engines.map(labelFor).join(', ')})`);
  }
})();
