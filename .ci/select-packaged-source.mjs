import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = 'fab648b67f2547023a0cf0bf688fe2763cb6911f';
const patched = 'e692dd4e25e8526e4052cdb2c0a9e23c230dd78c';
const source = process.env.SOURCE_REF;
assert.ok(source === base || source === patched);
const files = execFileSync('git', ['diff', '--name-only', base, patched, '--', 'gui'], { encoding: 'utf8' }).trim().split(/\r?\n/u);
assert.equal(files.length, 8);
const hashes = {};
for (const file of files) {
  const bytes = execFileSync('git', ['show', `${source}:${file}`]);
  writeFileSync(file, bytes);
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
}
writeFileSync('gui/apps/desktop/.cloudroom-version', 'v145\n');
mkdirSync('ci-artifacts', { recursive: true });
writeFileSync(join('ci-artifacts', 'source.json'), JSON.stringify({
  base, patched, source, variant: process.env.VARIANT, guiFiles: hashes,
  note: 'Only the eight PR files differ between variants. Both builds use published GUI v145 source and dependency lockfile.',
}, null, 2) + '\n');
console.log(`Selected ${process.env.VARIANT}: ${source}`);
