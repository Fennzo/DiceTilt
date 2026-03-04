#!/usr/bin/env node
/**
 * scripts/build-frontend.js
 *
 * Production build: strips demo mode (Hardhat mnemonic) from index.html so test
 * keys are never present in production bundles. Run with BUILD_ENV=production.
 *
 * Usage:
 *   BUILD_ENV=production node scripts/build-frontend.js
 *   # Outputs to frontend/dist/ — use dist/ for production deploy
 *
 * For local dev, serve frontend/ as-is; demo mode remains gated by isLocalhost().
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const frontendDir = join(root, 'frontend');
const distDir = join(frontendDir, 'dist');
const isProduction = process.env['BUILD_ENV'] === 'production';

if (!isProduction) {
  console.log('build-frontend: BUILD_ENV !== production — skipping demo strip');
  process.exit(0);
}

if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

let html = readFileSync(join(frontendDir, 'index.html'), 'utf8');

// Replace DEMO_MODE so it is always false in production
html = html.replace(
  /const DEMO_MODE = isLocalhost\(\) && new URLSearchParams\(location\.search\)\.get\('demo'\) === '1';/,
  "const DEMO_MODE = false; // stripped in production — demo mnemonic never used",
);

// Remove the demo wallet branch (mnemonic) — keep only the createRandom/stored path
const demoBlockPattern = /if \(DEMO_MODE\) \{\s*wallet = ethers\.HDNodeWallet\.fromMnemonic\(\s*ethers\.Mnemonic\.fromPhrase\('test test test test test test test test test test test junk'\),\s*"m\/44'\/60'\/0'\/0\/1"\s*\);\s*\} else \{\s*/s;
if (!demoBlockPattern.test(html)) {
  console.error('build-frontend: could not find demo block to strip — pattern may have changed');
  process.exit(1);
}
html = html.replace(demoBlockPattern, '{ ');

writeFileSync(join(distDir, 'index.html'), html);
copyFileSync(join(frontendDir, 'dashboard.html'), join(distDir, 'dashboard.html'));
console.log('build-frontend: stripped demo mnemonic; output in frontend/dist/');
