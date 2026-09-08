// One-time setup, for people who would rather not assemble it by hand:
//
//   npm run setup
//
// Installs the npm dependencies and the three scan browsers, then tells you what
// to do next. Uses Node built-ins only, so it runs on a fresh copy of the folder
// before `npm install` has ever been run.
const { spawnSync } = require('child_process');
const fs = require('fs');

const NODE_MIN = 18;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, command, args) {
  console.log(`\n── ${label} ──`);
  console.log(`   ${command} ${args.join(' ')}\n`);
  const res = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.error) {
    console.error(`\n✗ Could not run \`${command}\` — ${res.error.message}`);
    return false;
  }
  if (res.status !== 0) {
    console.error(`\n✗ ${label} failed (exit code ${res.status}).`);
    return false;
  }
  console.log(`\n✓ ${label} done.`);
  return true;
}

console.log('Accessibility Audit Toolkit — setup');
console.log('This downloads three browsers (~1GB) and takes a few minutes on a fresh machine.');

const major = Number(process.versions.node.split('.')[0]);
console.log(`\nNode.js ${process.versions.node} detected.`);
if (major < NODE_MIN) {
  console.error(`✗ Node.js ${NODE_MIN} or newer is required. Install it from https://nodejs.org and run this again.`);
  process.exit(1);
}

const steps = [
  ['Installing dependencies', npm, ['install']],
  ['Installing scan browsers (Chromium, Firefox, WebKit)', npm, ['run', 'install:browsers']]
];

for (const [label, command, args] of steps) {
  if (!run(label, command, args)) {
    console.error('\nSetup stopped. Fix the error above and run `npm run setup` again.');
    process.exit(1);
  }
}

// urls.json ships empty on purpose — say so here rather than letting the first
// scan be the thing that discovers it.
let urlCount = 0;
try {
  const urls = JSON.parse(fs.readFileSync('./urls.json', 'utf8'));
  urlCount = Array.isArray(urls) ? urls.length : 0;
} catch (e) { /* reported below */ }

console.log('\n────────────────────────────────────────');
console.log('✓ Setup complete.\n');

if (!urlCount) {
  console.log('Next: tell it which pages to audit. Easiest way, straight from the sitemap:\n');
  console.log('      npm run urls:sitemap -- https://www.your-site.com            (preview)');
  console.log('      npm run urls:sitemap -- https://www.your-site.com --write    (save it)\n');
  console.log('      Or edit urls.json by hand (urls.example.json shows the shape).\n');
  console.log('Then run the scans:\n');
  console.log('      npm start\n');
} else {
  console.log(`urls.json already lists ${urlCount} page(s). To run the automated scans:\n`);
  console.log('      npm start\n');
}
