/** Start the frozen candidate and verify it against a job-owned fictional database. */
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const runner = process.env;
const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();
const source = git('rev-parse', 'HEAD');
assert.equal(source, runner.AIHR_CI_HEAD);
assert.equal(git('status', '--porcelain'), '');
assert.equal(runner.GITHUB_ACTIONS, 'true');
assert.equal(runner.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(runner.GITHUB_WORKFLOW_REF, 'StradaverseHub/ai-hr/.github/workflows/disposable-preview.yml@refs/heads/codex/disposable-preview-20261120');
assert.equal(runner.GITHUB_SHA, runner.AIHR_CI_CONTROL_HEAD);
assert.match(runner.GITHUB_RUN_ID, /^\d+$/);
assert.match(runner.GITHUB_RUN_ATTEMPT, /^\d+$/);
assert.equal(runner.AIHR_CI_UNIT, 'db-1');

const evidence = join(runner.RUNNER_TEMP, 'preview-evidence');
mkdirSync(evidence, {recursive: true, mode: 0o700});
assert.ok(['production', 'development'].includes(runner.AIHR_PREVIEW_MODE));
const production = runner.AIHR_PREVIEW_MODE === 'production';
if (production) {
  const memory = JSON.parse(readFileSync(join(evidence, 'memory/build-memory.json'), 'utf8'));
  assert.equal(memory.source, source);
  assert.equal(memory.exitCode, 0);
  assert.equal(memory.availableMemoryVerdict, 'within');
  assert.ok(['within', 'warn'].includes(memory.verdict));
}
const report = {
  kind: 'DISPOSABLE_SYNTHETIC_PREVIEW',
  source,
  controller: runner.AIHR_CI_CONTROL_HEAD,
  mode: runner.AIHR_PREVIEW_MODE,
  buildId: production ? readFileSync('.next/BUILD_ID', 'utf8').trim() : null,
  sourceCommittedAt: git('show', '-s', '--format=%cI'),
  releaseAuthorized: false,
  phases: {},
};
const postgres = fileURLToPath(new URL('./postgres.sh', import.meta.url));
const container = `aihr-ci-${runner.GITHUB_RUN_ID}-${runner.GITHUB_RUN_ATTEMPT}-db-1`;
const base = 'http://127.0.0.1:3175';
const password = randomBytes(24).toString('hex');
const authKey = randomBytes(32).toString('hex');
const aiKey = randomBytes(32).toString('hex');
const env = {
  ...runner,
  NODE_ENV: 'development',
  ALLOW_DEMO_SESSION: 'true',
  SHARE_PASSWORD: password,
  AI_CONFIG_SECRET: aiKey,
  AUTH_SESSION_KEY: authKey,
  AUTH_PUBLIC_ORIGIN: 'https://preview.example.test',
  DATABASE_URL: 'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',
  MIGRATION_DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/ai_hr_dev',
  TEST_DATABASE_URL: 'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',
  TEST_MIGRATION_DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/ai_hr_test',
};
assert(!env.AUTH_PROVIDER && !env.SEED_MAY_DESTROY_OTHER_TENANTS);
const require = createRequire(join(process.cwd(), 'package.json'));
const command = (bin, args) => execFileSync(bin, args, {env, stdio: 'inherit', timeout: 300_000});
const phase = async (label, action) => {
  const startedAt = new Date().toISOString();
  try {
    return await action();
  } finally {
    report.phases[label] = {startedAt, finishedAt: new Date().toISOString()};
  }
};

let server;
let browser;
try {
  await phase('prepareBrowser', () => command('pnpm', ['exec', 'playwright', 'install', '--with-deps', 'chromium']));
  await phase('createAndSeedDatabase', () => {
    command('bash', [postgres, 'reset']);
    // These are the existing migration prerequisites, provisioned inside the container just created above.
    command('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-p', '5433', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-c', 'CREATE ROLE ai_hr_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
      '-c', 'CREATE ROLE ai_hr_draft_discard_port NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
      '-c', 'GRANT ai_hr_app TO ai_hr_draft_discard_port WITH INHERIT TRUE, SET FALSE, ADMIN FALSE',
      '-c', 'GRANT ai_hr_draft_discard_port TO ai_hr_owner WITH INHERIT FALSE, SET TRUE, ADMIN FALSE']);
    command('pnpm', ['db:migrate']);
    command(process.execPath, ['--import', 'tsx', 'db/seed.ts']);
    command(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/provision-resignation-runtime.ts']);
  });
  const healthHeaders = {authorization: 'Basic ' + Buffer.from('preview:' + password).toString('base64')};
  await phase('startServer', async () => {
    server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), production ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', '3175'],
      {env: {...env, NODE_ENV: runner.AIHR_PREVIEW_MODE}, stdio: 'inherit'});
    let startError;
    server.on('error', error => { startError = error; });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (startError) throw startError;
      assert(server.exitCode === null && server.signalCode === null, 'Preview process exited');
      try {
        const response = await fetch(base + '/login', {headers: healthHeaders, signal: AbortSignal.timeout(15000)});
        if (response.ok) {
          await response.arrayBuffer();
          report.serverReadyAt = new Date().toISOString();
          return;
        }
      } catch {}
      await sleep(500);
    }
    throw new Error('Preview login page failed readiness');
  });
  // The production demo challenges network users. The development server is runner-loopback only.
  if (production) assert.equal((await fetch(base + '/analytics', {redirect: 'manual'})).status, 401);
  await phase('verifyAnalytics', async () => {
    browser = await require('playwright').chromium.launch();
    const page = await browser.newPage({
      viewport: {width: 393, height: 852},
      httpCredentials: {username: 'preview', password, origin: base},
    });
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(120000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/login');
    const admin = '22222222-2222-2222-2222-222222222222';
    await page.locator(`form[action="/login/as"]:has(input[value="${admin}"]) button`).click();
    await page.waitForURL(url => !url.pathname.startsWith('/login'));
    const session = (await page.context().cookies(base)).find(cookie => cookie.name === 'dev_user');
    assert.equal(session?.value, admin, 'Fixture admin selection did not commit a session');
    const response = await page.goto(base + '/analytics');
    assert.equal(response.status(), 200);
    assert.equal(new URL(page.url()).pathname, '/analytics');
    const card = page.locator('#chart-hc-dept').locator('xpath=../..');
    const heading = card.getByRole('heading');
    await heading.waitFor();
    const geometry = await heading.evaluate(element => {
      const header = element.parentElement;
      const rect = header.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        headingBottom: element.getBoundingClientRect().bottom,
        flexWrap: getComputedStyle(header).flexWrap,
        buttons: Array.from(header.querySelectorAll('button'), button => {
          const {left, right, top} = button.getBoundingClientRect();
          return {text: button.textContent.trim(), left, right, top};
        }),
      };
    });
    assert.equal(geometry.flexWrap, 'wrap');
    assert.deepEqual(geometry.buttons.map(button => button.text), ['↓ PNG', '↓ JPEG', '↓ PDF']);
    for (const button of geometry.buttons) {
      assert(button.left >= geometry.left && button.right <= geometry.right, 'Chart export control is clipped');
    }
    const pngDownload = page.waitForEvent('download', {timeout: 10000});
    await card.getByRole('button', {name: '↓ PNG', exact: true}).click();
    const png = await pngDownload;
    assert.match(png.suggestedFilename(), /^headcount-dept_.*\.png$/);
    assert.equal(await png.failure(), null);
    assert.deepEqual(errors, []);
    report.chart = {...geometry, exportedFilename: png.suggestedFilename()};
    report.workingPreviewAt = new Date().toISOString();
    await card.screenshot({path: join(evidence, 'analytics-card.png')});
  });
  assert.equal(git('status', '--porcelain'), '');
  report.passed = true;
  appendFileSync(runner.GITHUB_STEP_SUMMARY, `Working fictional Analytics preview at ${report.workingPreviewAt} for \`${source}\`.\n`);
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (server) server.kill('SIGTERM');
    writeFileSync(join(evidence, 'preview.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
