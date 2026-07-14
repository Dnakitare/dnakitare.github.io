#!/usr/bin/env node
// Computes the site's SHA-256 record chain and injects it into index.html.
//
// The hashes are computed by the page's own computeLedger() running in a
// headless Chromium (build mode, #ledger-build), so the build and the
// in-browser verification share one canonicalization by construction.
//
//   node tools/ledger.mjs           recompute and inject, then re-verify
//   node tools/ledger.mjs --verify  verify only, exit 1 on mismatch (CI)
//
// CHROME_BIN overrides the browser binary (defaults to Brave on macOS,
// `chrome` on PATH elsewhere).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, 'index.html');
const verifyOnly = process.argv.includes('--verify');
const chrome = process.env.CHROME_BIN
  || (process.platform === 'darwin'
    ? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    : 'chrome');

function computeChain() {
  const dom = execFileSync(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=10000', '--dump-dom',
    `file://${file}#ledger-build`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = dom.match(/<script type="application\/json" id="ledger-json">(.*?)<\/script>/s);
  if (!m) throw new Error('ledger JSON missing from headless output; did verifyLedger() run?');
  return JSON.parse(m[1]);
}

function displayedChain(html) {
  const re = /<span class="prev"><span class="hk">prev:<\/span> <span class="hv">([0-9a-f]{12})<\/span><\/span>\s*<span class="this"><span class="hk">this:<\/span> <span class="hv">([0-9a-f]{12})<\/span><\/span>/g;
  const out = [];
  for (const m of html.matchAll(re)) out.push({ prev: m[1], this: m[2] });
  return out;
}

const chain = computeChain();
const html = readFileSync(file, 'utf8');
const shown = displayedChain(html);
if (shown.length !== chain.length) {
  throw new Error(`found ${shown.length} hash strips for ${chain.length} records`);
}

const inSync = chain.every((c, i) => shown[i].prev === c.prev && shown[i].this === c.this)
  && html.includes(`<b id="chain-head">${chain[chain.length - 1].this}</b>`)
  && html.includes(`<span id="chain-count">${chain.length}</span>`);

if (verifyOnly) {
  if (!inSync) {
    console.error('ledger MISMATCH: displayed hashes are stale. Run: node tools/ledger.mjs');
    process.exit(1);
  }
  console.log(`ledger verified: ${chain.length} records, head ${chain[chain.length - 1].this}`);
  process.exit(0);
}

let i = 0;
let next = html.replace(
  /(<span class="prev"><span class="hk">prev:<\/span> <span class="hv">)[0-9a-f]{12}(<\/span><\/span>\s*<span class="this"><span class="hk">this:<\/span> <span class="hv">)[0-9a-f]{12}(<\/span><\/span>)/g,
  (whole, a, b, c) => {
    const link = chain[i++];
    return a + link.prev + b + link.this + c;
  },
);
if (i !== chain.length) throw new Error(`injected ${i} of ${chain.length} records`);
next = next.replace(/(<b id="chain-head">)[0-9a-f]{12}(<\/b>)/, `$1${chain[chain.length - 1].this}$2`);
next = next.replace(/(<span id="chain-count">)\d+(<\/span>)/, `$1${chain.length}$2`);
writeFileSync(file, next);

// The strips are excluded from hashed content, so a second pass must agree.
const recheck = computeChain();
const stable = recheck.every((c, k) => c.this === chain[k].this);
if (!stable) throw new Error('chain not stable after injection: hashed content includes the strips?');
console.log(`ledger injected: ${chain.length} records, head ${chain[chain.length - 1].this}`);
