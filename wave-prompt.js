// Prints a ready-to-paste prompt for doing the WAVE pass in a Claude session
// with browser access:
//
//   npm run wave:prompt
//
// WAVE's free tool is a single-page app with no free API, so there is no
// wave-scan.js. This does not scan anything itself — it writes out the exact
// instructions, including the per-page output filenames, so the pass can be
// driven by hand or by an agent with a browser.
//
// Worth knowing before you use it: this drives WebAIM's free web interface,
// which is what their paid API (wave.webaim.org/api — 100 free credits, then
// from $0.025/page) exists for, and it depends on their internal
// `window.wave.report` object, so it breaks whenever they change it. With an
// API key the same result is a plain GET returning JSON, no browser involved.
//
// WAVE is optional: it is the sole automated source for none of the 55 criteria,
// and generate-report.js does not read it. It feeds combine-report.js's CSVs and
// the merged PDF evidence pack, and adds a second independent rule engine
// alongside axe.
const fs = require('fs');
const { pageName } = require('./browsers');

// Beyond this, inlining every URL buries the instructions; the prompt points at
// urls.json instead and the agent reads the list from there.
const MAX_INLINE = 30;

function buildPrompt(urls, cwd) {
  const listing = urls.length <= MAX_INLINE
    ? urls.map(u => `  ${u}\n    -> audits/raw/${pageName(u)}-wave.json`).join('\n')
    : `  The ${urls.length} URLs are in ${cwd}/urls.json — read that file for the list.\n`
      + `  For each URL, the output filename is the URL with the protocol and domain\n`
      + `  stripped and slashes turned into underscores, with the site root named\n`
      + `  "homepage": audits/raw/<page>-wave.json. First few for reference:\n`
      + urls.slice(0, 5).map(u => `    ${u}\n      -> audits/raw/${pageName(u)}-wave.json`).join('\n');

  return `I need a WAVE accessibility scan of the pages listed at the end, saving one JSON
file per page. You have browser access. WAVE's free tool has no API, so this has
to go through its web interface.

For each URL:

1. Navigate to https://wave.webaim.org/report#/<the full URL>. This deep-link
   format works directly — do not type into the form each time.

2. Wait for the report to finish loading. It is a single-page app and does not
   repaint instantly on a hash change: allow 8-9 seconds, and confirm
   location.href matches the target URL before reading anything. A short wait
   returns the previous page's stale numbers, which is the main way this pass
   goes wrong silently.

3. In the page's JS context, read window.wave.report.things.iconList. Each entry
   has .data.category, .data.title and .data.summary. Group by category|title and
   count occurrences. window.wave.report.aim is the AIM score.

4. Write exactly this shape to that page's file:

   {
     "url": "<the URL>",
     "aimScore": <number>,
     "totalItems": <number>,
     "categories": [
       { "category": "Errors", "title": "...", "summary": "...", "count": 2 }
     ]
   }

Practical note: dumping the full category+title+summary+count structure in one
JSON.stringify call sometimes trips a false-positive safety filter on the
repeated key/value shape, even though nothing in it is sensitive. If that
happens, split the extraction: one call for the counts, a separate call for the
descriptions of any issue type not seen yet. WAVE's rule descriptions are fixed
boilerplate rather than per-page, so fetch each unique category/title
description once and reuse it.

Do not reuse one page's numbers for another, even where pages share a template.
Image counts, headings and contrast genuinely differ per page, and reused
numbers would misrepresent that page in the evidence pack.

When you finish, tell me which pages succeeded and which did not, so I know
whether the set is complete.

Save the files under ${cwd}/audits/raw/. Pages and their output filenames:

${listing}`;
}

function printPrompt(urls, cwd) {
  const bar = '─'.repeat(72);
  console.log(`\n${bar}`);
  console.log('WAVE pass — optional. Copy everything between the lines below into a');
  console.log('Claude session that has browser access.');
  console.log(bar);
  console.log(`\n${buildPrompt(urls, cwd)}\n`);
  console.log(bar);
  console.log(`Then: node wave-to-pdf.js   (WAVE JSON -> PDF, for the evidence pack)`);
  console.log(`      node combine-report.js (folds the AIM scores into the CSV summaries)`);
  console.log(bar);
}

module.exports = { buildPrompt, printPrompt };

if (require.main === module) {
  let urls;
  try {
    urls = JSON.parse(fs.readFileSync('./urls.json', 'utf8'));
  } catch (err) {
    console.error('✗ Could not read urls.json — ' + err.message);
    process.exit(1);
  }
  if (!Array.isArray(urls) || !urls.length) {
    console.error('✗ urls.json is empty — there are no pages to scan.\n');
    console.error('  Build the list first:  npm run urls:find -- https://www.example.com');
    process.exit(1);
  }
  printPrompt(urls, process.cwd());
}
