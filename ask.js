// Shared terminal prompts, so the scripts can ask a plain question instead of
// making someone assemble a command line with flags.
//
//   const { interactive, ask, askYesNo, askChoice, close } = require('./ask');
//
// Own line buffer instead of rl.question(): keeps piped/scripted input from
// losing lines between questions, and resolves '' cleanly when stdin ends.
// Every prompt is safe in a non-interactive context — it returns the fallback
// rather than hanging a CI job waiting for input that will never arrive.
const readline = require('readline');

// A real terminal on both ends: anything else (piped input, CI, a spawned
// process without a tty) must never be asked a question it cannot answer.
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

let rl = null;
let stdinClosed = false;
let releasing = false;
const bufferedLines = [];
const waitingAsks = [];

function ensureReadline() {
  if (rl) return rl;
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY
  });
  rl.on('line', l => {
    const w = waitingAsks.shift();
    if (w) w(l.trim()); else bufferedLines.push(l.trim());
  });
  rl.on('close', () => {
    // A deliberate hand-off is not the user ending input: keep asking possible.
    if (releasing) return;
    stdinClosed = true;
    while (waitingAsks.length) waitingAsks.shift()('');
  });
  return rl;
}

function ask(question) {
  ensureReadline();
  process.stdout.write(question);
  if (bufferedLines.length) {
    const a = bufferedLines.shift();
    process.stdout.write(a + '\n');
    return Promise.resolve(a);
  }
  if (stdinClosed) {
    process.stdout.write('\n');
    return Promise.resolve('');
  }
  return new Promise(res => waitingAsks.push(res));
}

// Empty answer takes defaultYes, so Enter is always the safe path.
async function askYesNo(question, defaultYes = true) {
  if (!interactive) return defaultYes;
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  for (;;) {
    const a = (await ask(question + suffix)).toLowerCase();
    if (!a) return defaultYes;
    if (['y', 'yes'].includes(a)) return true;
    if (['n', 'no'].includes(a)) return false;
    console.log('  Please answer y or n.');
  }
}

// options: [{ label, hint }] — returns the chosen index, re-asking on nonsense
// instead of silently picking something the user did not mean.
async function askChoice(question, options, defaultIndex = 0) {
  if (!interactive) return defaultIndex;
  console.log(question);
  options.forEach((o, i) => {
    console.log(`  ${i + 1}) ${o.label}${o.hint ? `\n     ${o.hint}` : ''}`);
  });
  for (;;) {
    const a = (await ask(`Choose 1-${options.length} [${defaultIndex + 1}]: `)).trim();
    if (!a) return defaultIndex;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    console.log(`  Please enter a number between 1 and ${options.length}.`);
  }
}

function close() {
  if (rl && !stdinClosed) rl.close();
}

// Give stdin to a child process that asks its own questions, then take it back.
// Without this, a second round of prompts after spawning a child would see a
// closed readline, resolve every question to '' and silently take the defaults.
function release() {
  releasing = true;
  if (rl) { rl.close(); rl = null; }
  releasing = false;
  stdinClosed = false;
  bufferedLines.length = 0;
  waitingAsks.length = 0;
  process.stdin.pause();
}

module.exports = { interactive, ask, askYesNo, askChoice, close, release };
