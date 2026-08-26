const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

(async () => {
  const rawDir = './audits/raw';
  const reportsDir = './audits/reports';
  fs.mkdirSync(reportsDir, { recursive: true });
  const axeFiles = fs.readdirSync(rawDir).filter(f => f.endsWith('-axe.pdf'));

  for (const axeFile of axeFiles) {
    const base = axeFile.replace('-axe.pdf', '');
    const lhFile = `${base}-lighthouse.pdf`;
    const waveFile = `${base}-wave.pdf`;
    const lhPath = path.join(rawDir, lhFile);
    const wavePath = path.join(rawDir, waveFile);
    if (!fs.existsSync(lhPath)) continue;

    const merged = await PDFDocument.create();
    const axeDoc = await PDFDocument.load(fs.readFileSync(path.join(rawDir, axeFile)));
    const lhDoc = await PDFDocument.load(fs.readFileSync(lhPath));

    const axePages = await merged.copyPages(axeDoc, axeDoc.getPageIndices());
    axePages.forEach(p => merged.addPage(p));
    const lhPages = await merged.copyPages(lhDoc, lhDoc.getPageIndices());
    lhPages.forEach(p => merged.addPage(p));

    if (fs.existsSync(wavePath)) {
      const waveDoc = await PDFDocument.load(fs.readFileSync(wavePath));
      const wavePages = await merged.copyPages(waveDoc, waveDoc.getPageIndices());
      wavePages.forEach(p => merged.addPage(p));
    } else {
      console.log(`  (no WAVE report found for ${base}, merging axe + lighthouse only)`);
    }

    const outPath = path.join(reportsDir, `${base}-full-report.pdf`);
    fs.writeFileSync(outPath, await merged.save());
    console.log(`✓ Merged: ${base}-full-report.pdf`);
  }
})();
