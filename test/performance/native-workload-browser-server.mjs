/** Fixed nonroot BrowserServer role. Importing this file starts nothing. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const MAX_FRAME = 512;
const ROLE_UID = {driver: 62120, browser: 62121};
const MANAGER_FIELDS = ['INVOCATION_ID', 'SYSTEMD_EXEC_PID', 'JOURNAL_STREAM', 'USER', 'LOGNAME', 'SHELL',
  'MEMORY_PRESSURE_WATCH', 'MEMORY_PRESSURE_WRITE'];
const BROWSER_CHECKS = ['own-canary', 'ingress', 'driver-canary-denied', 'driver-credential-denied',
  'driver-proc-denied', 'host-sockets-denied', 'socket-families-denied', 'rings-denied',
  'postgres-denied', 'control-denied'];
export const CONTROL_URL = 'ws://127.0.0.1:3444/aihr-browser-capability-v1';
export const INGRESS_URL = 'https://127.0.0.1:3443/__aihr_browser_capability_v1';
export const INGRESS_BODY = 'aihr-browser-capability-v1\n';

export function roleEnvironment(role) {
  const uid = ROLE_UID[role];
  assert(process.platform === 'linux' && process.arch === 'x64' && uid !== undefined);
  assert(process.getuid() === uid && process.geteuid() === uid && process.getgid() === uid && process.getegid() === uid);
  assert(process.getgroups().every(group => group === uid));
  const {HOME, TMPDIR} = process.env;
  const match = /^\/run\/aihr-browser-capability-([1-9][0-9]{0,19})\/(driver|browser)-home$/.exec(HOME ?? '');
  assert(match?.[2] === role && TMPDIR === `${HOME}/scratch`);
  const env = {HOME, TMPDIR, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8'};
  const allowed = new Set([...Object.keys(env), ...MANAGER_FIELDS, ...(role === 'driver' ? ['CREDENTIALS_DIRECTORY'] : [])]);
  assert(Object.keys(process.env).every(key => allowed.has(key)));
  assert(Object.entries(env).every(([key, value]) => process.env[key] === value));
  return {runId: match[1], env};
}

const CHROMIUM_PATH = fileURLToPath(new URL('../chromium/chrome-headless-shell-linux64/chrome-headless-shell', import.meta.url));

/** A frame is at most 512 wire bytes. Unused partial bytes cannot become EOF success. */
export async function* readFrames(stream) {
  let pending = Buffer.alloc(0);
  for await (const block of stream) {
    const bytes = Buffer.from(block);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline + 1;
      assert(pending.length + end - start <= MAX_FRAME);
      pending = Buffer.concat([pending, bytes.subarray(start, end)]);
      if (newline !== -1) {
        const text = pending.toString('utf8');
        const value = JSON.parse(text);
        assert.equal(`${JSON.stringify(value)}\n`, text);
        pending = Buffer.alloc(0);
        yield value;
      }
      start = end;
    }
  }
  assert.equal(pending.length, 0);
}

export async function expectFrame(reader, op, fields = []) {
  const {done, value} = await reader.next();
  assert(!done && value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['op', ...fields].sort());
  assert.equal(value.op, op);
  return value;
}

export function writeFrame(value) {
  const wire = Buffer.from(`${JSON.stringify(value)}\n`);
  assert(wire.length <= MAX_FRAME && writeSync(1, wire) === wire.length);
}

function waitChild(child) {
  return new Promise(resolve => {
    let error = false;
    child.once('error', () => { error = true; });
    child.once('close', (code, signal) => resolve({error, code, signal}));
  });
}

async function browserRole() {
  const {env} = roleEnvironment('browser');
  const spki = process.argv[2];
  assert(process.argv.length === 3 && /^[A-Za-z0-9+/]{43}=$/.test(spki));
  assert.equal(Buffer.from(spki, 'base64').toString('base64'), spki);
  const {chromium} = await import(new URL('../node_modules/playwright/index.mjs', import.meta.url).href);
  const root = readFrames(process.stdin);
  let server, probe, probeDone, failure;
  try {
    server = await chromium.launchServer({host: '127.0.0.1', port: 3444, wsPath: '/aihr-browser-capability-v1',
      executablePath: CHROMIUM_PATH,
      chromiumSandbox: true, headless: true, env, timeout: 12000,
      args: [`--ignore-certificate-errors-spki-list=${spki}`]});
    assert.equal(server.wsEndpoint(), CONTROL_URL);
    const chromiumPid = server.process().pid;
    assert(Number.isSafeInteger(chromiumPid) && chromiumPid > 1);
    writeFrame({op: 'listener-ready', pid: chromiumPid});
    const {pid} = await expectFrame(root, 'deny-prepare', ['pid']);
    assert(Number.isSafeInteger(pid) && pid > 1 && pid <= 4194304);
    probe = spawn('/usr/bin/python3', ['-I', '-B', fileURLToPath(new URL('./native-workload-browser-host.py', import.meta.url)),
      'probe-browser', String(pid)], {env, cwd: env.HOME, stdio: ['pipe', 'pipe', 'ignore']});
    probeDone = waitChild(probe);
    // Write errors stay local. EOF/exit and the expected frames decide completion.
    probe.stdin.on('error', () => {});
    const responses = readFrames(probe.stdout);
    const ready = await expectFrame(responses, 'probe-ready', ['pid']);
    assert.equal(ready.pid, probe.pid);
    writeFrame(ready);
    await expectFrame(root, 'deny-go');
    probe.stdin.end('{"op":"deny-go"}\n');
    const result = await expectFrame(responses, 'negatives-complete', ['checks']);
    assert.deepEqual(result.checks, BROWSER_CHECKS);
    assert((await responses.next()).done);
    assert.deepEqual(await probeDone, {error: false, code: 0, signal: null});
    writeFrame(result);
    await expectFrame(root, 'stop');
  } catch (error) {
    failure = error;
  } finally {
    if (probe && probe.exitCode === null && probe.signalCode === null) probe.stdin.destroy();
    if (probeDone) await probeDone;
    if (server) {
      try { await server.close(); } catch (error) { failure ??= error; }
    }
  }
  if (failure) throw failure;
  writeFrame({op: 'browser-closed'});
  assert((await root.next()).done);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await browserRole(); } catch { process.exitCode = 19; }
}
