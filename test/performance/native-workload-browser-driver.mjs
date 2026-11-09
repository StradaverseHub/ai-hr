/** Fixed nonroot driver role. Only this role can open the systemd observer credential. */
import assert from 'node:assert/strict';
import {closeSync, constants, fstatSync, openSync, readSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {CONTROL_URL, INGRESS_BODY, INGRESS_URL, expectFrame, readFrames, roleEnvironment,
  writeFrame} from './native-workload-browser-server.mjs';

function readFixedFile(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, {bigint: true});
    assert(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit));
    assert((before.mode & 0o077n) === 0n && (before.uid === 0n || before.uid === BigInt(process.geteuid())));
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      assert(read > 0);
      offset += read;
    }
    assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, null), 0);
    const after = fstatSync(fd, {bigint: true});
    for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'nlink', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

async function driverRole() {
  const {runId, env} = roleEnvironment('driver');
  const tag = process.argv[2];
  assert(process.argv.length === 3 && /^aihrbc_[0-9a-f]{16}$/.test(tag));
  const credentials = `/run/credentials/aihrbc-driver-${runId}.service`;
  assert.equal(process.env.CREDENTIALS_DIRECTORY, credentials);
  assert.equal(readFixedFile(`${env.HOME}/canary`, 32), 'driver-canary\n');
  const url = readFixedFile(`${credentials}/observer`, 256);
  assert(/^postgres:\/\/ai_hr_workload_observer:[0-9a-f]{64}@127\.0\.0\.1:5433\/ai_hr_test_w1$/.test(url));
  const {default: postgres} = await import(new URL('../node_modules/postgres/src/index.js', import.meta.url).href);
  const {chromium} = await import(new URL('../node_modules/playwright/index.mjs', import.meta.url).href);
  const root = readFrames(process.stdin);
  let pool, observer, browser, context, page, failure;
  try {
    pool = postgres(url, {max: 1, connect_timeout: 4, fetch_types: false,
      connection: {application_name: tag, statement_timeout: 2500}});
    const observerIdentity = (sql, reserved) => sql`select pg_backend_pid() as pid, session_user as login, current_user as role,
      current_database() as database, current_setting('transaction_read_only') as read_only,
      r.rolconnlimit as cap, pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') as stats,
      host(inet_server_addr()) as address, inet_server_port() as port,
      extract(epoch from a.backend_start)::text as backend_start
      ${reserved ? sql`, (select count(*)::text from pg_stat_statements) as statement_count` : sql``}
      from pg_roles r cross join pg_stat_activity a where r.rolname=current_user and a.pid=pg_backend_pid()`;
    // postgres.js 3.4.9 needs a normal cold query to enter its open queue with type discovery disabled.
    const [warm] = await observerIdentity(pool, false);
    assert(warm && Number.isSafeInteger(warm.pid) && warm.pid > 1 && /^\d+(?:\.\d+)?$/.test(warm.backend_start));
    assert.deepEqual(warm, {pid: warm.pid, login: 'ai_hr_workload_observer', role: 'ai_hr_workload_observer',
      database: 'ai_hr_test_w1', read_only: 'on', cap: 2, stats: true, address: '127.0.0.1', port: 5433,
      backend_start: warm.backend_start});
    observer = await pool.reserve();
    const [reserved] = await observerIdentity(observer, true);
    assert(reserved && typeof reserved.statement_count === 'string' && /^\d+$/.test(reserved.statement_count));
    const {statement_count, ...identity} = reserved;
    assert.deepEqual(identity, warm);
    writeFrame({op: 'observer-ready', pid: identity.pid, tag});
    await expectFrame(root, 'connect');
    browser = await chromium.connect(CONTROL_URL, {timeout: 8000});
    writeFrame({op: 'websocket-ready'});
    await expectFrame(root, 'request');
    context = await browser.newContext();
    page = await context.newPage();
    const response = await page.goto(INGRESS_URL, {waitUntil: 'load', timeout: 8000});
    assert(response && response.url() === INGRESS_URL && page.url() === INGRESS_URL
      && response.status() === 200 && response.request().redirectedFrom() === null);
    assert.equal(response.headers()['content-length'], String(Buffer.byteLength(INGRESS_BODY)));
    assert.equal(await response.text(), INGRESS_BODY);
    assert.equal(await page.locator('body').innerText({timeout: 1000}), INGRESS_BODY.trim());
    writeFrame({op: 'ingress-complete', status: 200});
    await expectFrame(root, 'stop');
  } catch (error) {
    failure = error;
  } finally {
    for (const close of [page && (() => page.close()), context && (() => context.close()),
      browser && (() => browser.close()), observer && (() => observer.release()),
      pool && (() => pool.end())]) {
      if (close) {
        try { await close(); } catch (error) { failure ??= error; }
      }
    }
  }
  if (failure) throw failure;
  writeFrame({op: 'driver-closed'});
  assert((await root.next()).done);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await driverRole(); } catch { process.exitCode = 19; }
}
