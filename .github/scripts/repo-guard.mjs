import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Read committed blobs, including ignored-but-tracked files; never read local env files.
const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const [mode, ref = 'HEAD'] = process.argv.slice(2);
if (!['paths', 'private'].includes(mode)) throw new Error('Usage: repo-guard.mjs paths|private [ref]');
const lines = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
  .split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
const allowed = lines('allowed-paths.txt');
const patterns = lines('private-patterns.txt').map((source) => new RegExp(source, 'im'));
const entries = git('ls-tree', '-rz', '--full-tree', ref).toString('utf8').split('\0').filter(Boolean);
let failures = 0;
for (const entry of entries) {
  const separator = entry.indexOf('\t');
  const metadata = entry.slice(0, separator);
  const path = entry.slice(separator + 1);
  const [fileMode, type, oid] = metadata.split(' ');
  if (mode === 'paths') {
    if (type !== 'blob' || fileMode === '120000' || !allowed.some((rule) =>
      rule.endsWith('/') ? path.startsWith(rule) : path === rule)) {
      console.error(`Disallowed tracked path or file type: ${JSON.stringify(path)}`);
      failures++;
    }
  } else {
    // Report rule numbers and paths only, never matching content.
    const text = type === 'blob' ? git('cat-file', 'blob', oid).toString('utf8') : '';
    patterns.forEach((pattern, index) => {
      if (pattern.test(path) || pattern.test(text)) {
        console.error(`Private pattern ${index + 1}: ${JSON.stringify(path)}`);
        failures++;
      }
    });
  }
}
console.log(`${mode}: ${entries.length} tracked entries checked; ${failures} violation(s)`);
process.exitCode = failures ? 1 : 0;
