import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { createBbAppArtifactService } from '../gui/apps/server/src/services/install/bb-app-artifact.ts';
import { resolvePluginNpmCli } from '../gui/packages/plugin-build/src/npm-cli.ts';

const exec = promisify(execFile);
assert.equal(process.platform, 'win32');
const temporary = await mkdtemp(join(tmpdir(), 'cloudroom-bootstrap-ci-'));
const output = resolve('..', 'ci-artifacts');
const originalPath = process.env.PATH;
try {
  let oldSpawnCode: unknown;
  try {
    await exec('npm', ['--version'], { timeout: 10_000 });
  } catch (error) {
    oldSpawnCode = (error as NodeJS.ErrnoException).code;
  }
  assert.ok(oldSpawnCode, 'Negative control: bare execFile(npm) should fail on native Windows');
  const npmVersion = (await exec(process.execPath, [resolvePluginNpmCli(), '--version'])).stdout.trim();
  const emptyPath = join(temporary, 'empty-path');
  await mkdir(emptyPath);
  process.env.PATH = emptyPath;
  const artifact = await createBbAppArtifactService({
    dataDir: join(temporary, 'cache with spaces & punctuation'),
    serverEntryUrl: new URL('../gui/packages/bb-app/host-package/server/dist/index.js', import.meta.url).href,
  }).getArtifact();
  await mkdir(output, { recursive: true });
  await copyFile(artifact.path, join(output, 'bb-app.tgz'));
  const receipt = {
    passed: true, platform: process.platform, architecture: process.arch,
    node: process.version, npmVersion, legacySpawnError: oldSpawnCode,
    packedWithEmptyPath: true, artifactBytes: artifact.size, artifactSha256: artifact.digest,
    sourceCommit: process.env.GITHUB_SHA,
  };
  await writeFile(join(output, 'windows-package.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await rm(temporary, { recursive: true, force: true });
}
