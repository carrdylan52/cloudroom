import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

assert.equal(process.platform, 'linux');
const exec = promisify(execFile);
const output = resolve('ci-artifacts');
const artifact = join(output, 'bb-app.tgz');
const windows = JSON.parse(await readFile(join(output, 'windows-package.json'), 'utf8'));
assert.equal(createHash('sha256').update(await readFile(artifact)).digest('hex'), windows.artifactSha256);
const temporary = await mkdtemp(join(tmpdir(), 'cloudroom-cross-os-ci-'));
const dataDir = join(temporary, 'machine');
const prefix = join(dataDir, 'npm');
const hostId = 'host_cross_platform_test';
let enrollmentRequests = 0;
const server = createServer(async (request, response) => {
  if (request.url !== '/internal/hosts/enroll' || request.method !== 'POST') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (body.hostId !== hostId || request.headers.authorization !== 'Bearer ci_enrollment_fixture') {
    response.writeHead(400).end();
    return;
  }
  enrollmentRequests++;
  response.writeHead(201, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ hostId, hostKey: 'ci_host_key_fixture' }));
});
try {
  await mkdir(dataDir, { recursive: true });
  const installation = await exec('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', artifact], {
    timeout: 300_000, maxBuffer: 10 * 1024 * 1024,
  });
  console.log(installation.stdout);
  const packageRoot = join(prefix, 'lib/node_modules/bb-app');
  const require = createRequire(join(packageRoot, 'package.json'));
  require('node-pty');
  require('@parcel/watcher');
  const nestedCli = join(packageRoot, 'host-daemon/dist/room-cli');
  const extractedMode = (await stat(nestedCli)).mode & 0o777;
  await chmod(nestedCli, 0o644);
  const cli = join(prefix, 'bin/room-cli');
  const env = { ...process.env, ROOM_DATA_DIR: dataDir };
  delete env.ROOM_CLI;
  const help = await exec(cli, ['--help'], { env, timeout: 15_000 });
  assert.match(help.stdout, /Usage:/);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = JSON.stringify({ hostId, serverUrl, credential: 'ci_enrollment_fixture', expiresAt: Date.now() + 60_000 });
  await new Promise((resolve, reject) => {
    const child = execFile(cli, ['machine', 'enroll', '--bootstrap-file', '/dev/stdin'], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`CLI enrollment failed: ${stderr}`, { cause: error }));
      else { console.log(stdout); resolve(); }
    });
    child.stdin.end(bootstrap);
  });
  const auth = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
  assert.deepEqual(auth, { hostId, hostKey: 'ci_host_key_fixture' });
  assert.equal(enrollmentRequests, 1);
  assert.equal((await stat(nestedCli)).mode & 0o777, 0o644);
  const receipt = {
    passed: true, platform: process.platform, architecture: process.arch, node: process.version,
    windowsSourceCommit: windows.sourceCommit, artifactSha256: windows.artifactSha256,
    extractedNestedCliMode: extractedMode.toString(8), forcedNestedCliMode: '644',
    nativeModulesLoaded: true, helpPassed: true, enrollmentRequests,
    authPersisted: true, localhostFixtureOnly: true, liveCloudroomDaemonConnectionTested: false,
  };
  await writeFile(join(output, 'linux-enrollment.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
