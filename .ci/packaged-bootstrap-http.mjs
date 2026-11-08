import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

assert.equal(process.platform, 'win32');
const exec = promisify(execFile);
const binary = resolve(process.env.APP_BINARY);
const resources = join(dirname(binary), 'resources');
const serverEntry = join(resources, 'app.asar.unpacked/node_modules/bb-app/server/dist/index.js');
const expected = Number(process.env.EXPECTED_HTTP);
const variant = process.env.VARIANT;
assert.ok([200, 500].includes(expected));
const output = resolve('ci-artifacts');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'cloudroom-packaged-http-'));
const probe = `
const {createRequire}=require('node:module');
const path=require('node:path');
const fromApp=createRequire(path.join(${JSON.stringify(resources)},'app.asar/node_modules/bb-app/package.json'));
const npm=fromApp.resolve('npm/package.json');
console.log(JSON.stringify({electron:process.versions.electron,node:process.version,npmPath:npm,npmVersion:fromApp(npm).version}));
`;
const runtime = JSON.parse((await exec(binary, ['-e', probe], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000,
})).stdout);
assert.ok(runtime.electron);
assert.match(runtime.npmPath, /app\.asar[\\/]node_modules[\\/]npm/);
const legacySpawn = JSON.parse((await exec(binary, ['-e', `
require('node:child_process').execFile('npm',['--version'],(error,stdout)=>console.log(JSON.stringify({code:error?.code,message:error?.message,stdout})));
`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 })).stdout);
assert.equal(legacySpawn.code, 'ENOENT');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function awaitHealth(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged backend exited ${child.exitCode} before health`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Packaged backend did not become healthy');
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill();
  let timer;
  const result = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10_000); })]);
  clearTimeout(timer);
  if (!result) throw new Error(`Packaged backend PID ${child.pid} did not stop`);
}

async function logsUnder(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return ''; }
  return (await Promise.all(entries.filter(e => e.isFile()).map(e => readFile(join(directory, e.name), 'utf8').catch(() => '')))).join('\n');
}

const attempts = [];
for (const emptyPath of expected === 200 ? [false, true] : [false]) {
  const dataDir = join(root, emptyPath ? 'empty-path-profile' : 'normal-path-profile');
  await mkdir(dataDir, { recursive: true });
  const port = await freePort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ROOM_|BB_)/u.test(key)) delete env[key];
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', BB_DATA_DIR: dataDir,
    BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1',
    BB_HOST_DAEMON_PORT: String(await freePort()), BB_TELEMETRY: '0',
    BB_MARKETPLACE_URL: 'http://127.0.0.1:9/catalog',
  });
  if (emptyPath) { const bin = join(dataDir, 'empty-bin'); await mkdir(bin); env.PATH = bin; delete env.Path; }
  const child = spawn(binary, [serverEntry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = []; const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.on('error', error => stderr.push(Buffer.from(String(error))));
  const url = `http://127.0.0.1:${port}`;
  try {
    await awaitHealth(url, child);
    const version = await (await fetch(`${url}/install/version`)).json();
    const response = await fetch(`${url}/install/bb-app.tgz`, { signal: AbortSignal.timeout(120_000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, bytes.toString('utf8').slice(0, 1000));
    const attempt = { emptyPath, httpStatus: response.status, version };
    if (expected === 500) {
      // Pino's worker transport flushes after the HTTP error response.
      const diagnosticDeadline = Date.now() + 10_000;
      let logs;
      do {
        logs = Buffer.concat([...stdout, ...stderr]).toString('utf8') + await logsUnder(join(dataDir, 'logs'));
        if (/spawn npm ENOENT/.test(logs)) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (Date.now() < diagnosticDeadline);
      assert.match(logs + bytes.toString('utf8'), /spawn npm ENOENT/);
      attempt.failure = 'spawn npm ENOENT';
    } else {
      assert.equal(bytes[0], 0x1f); assert.equal(bytes[1], 0x8b);
      const digest = createHash('sha256').update(bytes).digest('hex');
      assert.equal(response.headers.get('x-bb-artifact-sha256'), digest);
      const cached = await fetch(`${url}/install/bb-app.tgz`, { headers: { 'if-none-match': response.headers.get('etag') } });
      assert.equal(cached.status, 304); assert.equal((await cached.arrayBuffer()).byteLength, 0);
      await writeFile(join(output, 'bb-app.tgz'), bytes);
      await writeFile(join(output, 'windows-package.json'), JSON.stringify({
        passed: true, platform: process.platform, architecture: process.arch, node: runtime.node,
        electron: runtime.electron, npmVersion: runtime.npmVersion, packagedHttpRoute: true,
        artifactBytes: bytes.length, artifactSha256: digest, sourceCommit: process.env.SOURCE_REF,
      }, null, 2) + '\n');
      Object.assign(attempt, { artifactBytes: bytes.length, artifactSha256: digest, conditionalStatus: cached.status });
    }
    attempts.push(attempt);
  } finally {
    await stop(child);
    await writeFile(join(output, `backend-${emptyPath ? 'empty' : 'normal'}-stdio.log`), Buffer.concat([...stdout, ...stderr]));
    await writeFile(join(output, `backend-${emptyPath ? 'empty' : 'normal'}-server.log`), await logsUnder(join(dataDir, 'logs')));
  }
}
const receipt = { passed: true, variant, sourceCommit: process.env.SOURCE_REF, runtime, legacySpawn, attempts, localhostOnly: true, isolatedProfiles: true };
await writeFile(join(output, 'packaged-http.json'), JSON.stringify(receipt, null, 2) + '\n');
await writeFile(join(dirname(binary), 'PR122-BUILD-INFO.txt'), `Unsigned test build: ${variant} v145\nSource: ${process.env.SOURCE_REF}\nPR: https://github.com/davidondrej/cloudroom/pull/122\nDo not overwrite an installed app with this directory. Preserve the existing Cloudroom profile and machine installation before a live enrollment comparison.\n`);
console.log(JSON.stringify(receipt));
