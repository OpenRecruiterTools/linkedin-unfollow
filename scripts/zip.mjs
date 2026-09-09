#!/usr/bin/env node
/**
 * Build the loadable extension zip.
 *
 * There is no build step — what ships is the source folder — so this is a copy
 * with the tests and tooling left out, plus a README.txt that somebody who
 * downloaded a zip from a GitHub release can actually follow.
 *
 * The release workflow runs this same script, so what a maintainer inspects
 * locally on any OS is what a release ships — and the checks at the bottom
 * (README.txt present, no tests, no node_modules) fail the release build too
 * rather than only a laptop.
 *
 *   node scripts/zip.mjs
 *   → dist/linkedin-unfollow-v<version>.zip
 */
import AdmZip from 'adm-zip';
import { readFileSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');

/** What a browser needs, and nothing else. */
const INCLUDED = ['manifest.json', 'src', 'icons', 'LICENSE'];

/** Never shipped: tests, dependencies, tooling, OS litter. */
const EXCLUDED_DIRS = new Set(['tests', 'node_modules', 'coverage', '.git', 'dist', '.github']);
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function walk(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      walk(full, found);
    } else {
      if (EXCLUDED_FILES.has(entry)) continue;
      found.push(full);
    }
  }
  return found;
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!version) throw new Error('manifest.json has no version');

const title = `LinkedIn Unfollow ${version}`;
const readme = `${title}
${'='.repeat(title.length)}

Unfollow everyone in your LinkedIn feed, at human pace, in your own browser.
Free, open source, no account, no server, no telemetry.

Install
-------
1. Unzip this file somewhere you will keep it. Chrome loads the extension from
   this folder every time it starts, so do not unzip it into Downloads and then
   empty Downloads.
2. Open chrome://extensions
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked" and pick the unzipped folder — the one holding
   manifest.json.
5. Pin the toolbar icon (jigsaw piece -> pin), sign in to linkedin.com, and
   click the icon.

The same steps with screenshots:
https://github.com/OpenRecruiterTools/linkedin-unfollow#install-it

How to use it
-------------
1. "Check count" tells you how many accounts you follow. It changes nothing.
2. "Preview" lists who would go. It changes nothing.
3. Set "Unfollow up to" to 1, run it, and check that person really is
   unfollowed. Then set it to whatever you want, or clear the box for everyone.

While it runs it sends the same unfollow request the LinkedIn page sends, one
person at a time, roughly one a second. "Stop" ends it after the person it is
on. If LinkedIn answers 429, 451, 401 or 403 the run stops on the spot and
nothing is retried.

Before you use it
-----------------
Read this part.

- Automating your LinkedIn account may breach LinkedIn's User Agreement.
  LinkedIn restricts and permanently bans accounts for it. That risk is yours,
  and no setting in here removes it.
- There is no undo. Unfollowing 800 people cannot be reversed in bulk.
- Use it on your own account, signed in as yourself, in your own browser.
- Nothing leaves your browser. There is no account, no server, no telemetry.
- Never run it against an account you cannot afford to lose.

MIT licensed. Issues and pull requests:
https://github.com/OpenRecruiterTools/linkedin-unfollow
`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const zip = new AdmZip();
const files = [];
for (const entry of INCLUDED) {
  const full = join(root, entry);
  if (statSync(full).isDirectory()) files.push(...walk(full));
  else files.push(full);
}
files.sort();
if (files.length === 0) throw new Error(`nothing to package under ${root}`);
for (const file of files) {
  const rel = relative(root, file).split(sep).join('/');
  zip.addFile(rel, readFileSync(file));
}
zip.addFile('README.txt', Buffer.from(readme, 'utf8'));

const outFile = join(outDir, `linkedin-unfollow-v${version}.zip`);
zip.writeZip(outFile);

// The landing page's Download button points at a fixed name, so a release
// carries the same bytes twice: once versioned, once as `linkedin-unfollow.zip`
// under /releases/latest/download/.
const latestFile = join(outDir, 'linkedin-unfollow.zip');
zip.writeZip(latestFile);

const bytes = statSync(outFile).size;
const entries = zip.getEntries().length;
console.log(`Wrote ${relative(root, outFile).split(sep).join('/')}`);
console.log(`  and ${relative(root, latestFile).split(sep).join('/')} (fixed name for the site)`);
console.log(`  ${entries} entries, ${(bytes / 1024).toFixed(0)} KB`);
for (const required of ['manifest.json', 'README.txt', 'src/background.js']) {
  if (!zip.getEntry(required)) throw new Error(`${required} is missing from the zip`);
}
const shipped = zip.getEntries().map((e) => e.entryName);
const leaked = shipped.filter((name) => name.startsWith('tests/') || name.includes('node_modules/'));
if (leaked.length) throw new Error(`these should not be in the zip: ${leaked.join(', ')}`);
console.log('  manifest.json and README.txt present; no tests or node_modules.');
