/**
 * Evidence-only capture of today's AI-facing screens (AI centre review, phase 1). Production renderer on a NEW
 * fictional runner database. Never a staging deployment, never release evidence, never merged.
 * It records what each actor sees per route (final URL, heading, screenshot) and makes no assertion about content.
 */
import assert from 'node:assert/strict';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join, relative, resolve, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const base = 'http://127.0.0.1:3174';
const target = 'ai_hr_ai_surfaces';
const postgres = fileURLToPath(new URL('./postgres.sh', import.meta.url));
const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();

const pages = dir => execFileSync('find', [dir, '-name', 'page.tsx'], {encoding: 'utf8'}).trim().split('\n')
  .filter(Boolean).filter(path => !path.includes('[')).map(path => '/' + path.replace(/^app\//, '').replace(/\/?page\.tsx$/, ''))
  .map(route => route === '/' ? route : route.replace(/\/$/, '')).sort();
const ADMIN_EXTRA = ['/analytics', '/delegations', '/approvals', '/payroll/control-tower', '/payroll/process',
  '/payroll/formula-builder', '/personnel', '/performance', '/knowledge-base', '/'];
const SHORT = ['/', '/assistant', '/control-tower', '/control-tower/agents', '/control-tower/how-it-works', '/analytics', '/delegations', '/approvals'];

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.env.GITHUB_REPOSITORY, 'StradaverseHub/ai-hr');
  const sha = git('rev-parse', 'HEAD'); assert.equal(sha, process.env.AIHR_CI_HEAD);
  assert(!existsSync('.next/BUILD_ID')); assert(!process.env.AUTH_PROVIDER && !process.env.SEED_MAY_DESTROY_OTHER_TENANTS);
  const out = resolve(process.argv[2]);
  const within = relative(resolve(process.env.RUNNER_TEMP), out);
  assert(within && !within.startsWith('../') && !isAbsolute(within));
  mkdirSync(out, {mode: 0o700});
  const report = {kind: 'AI_SURFACES_CAPTURE_EVIDENCE_ONLY', releaseEligible: false, sha, visits: [], chat: [], phases: [], errors: []};
  const gate = randomBytes(24).toString('hex'), secret = randomBytes(32).toString('hex');
  const scrub = text => String(text).replaceAll(gate, '[gate]').replaceAll(secret, '[key]');
  const dbEnv = {...process.env, NODE_ENV: 'development', ALLOW_DEMO_SESSION: 'true', SHARE_PASSWORD: gate,
    AI_CONFIG_SECRET: secret, TEST_DB_NAMESPACE: 'aisurfaces',
    DATABASE_URL: `postgres://ai_hr_app@127.0.0.1:5433/${target}`,
    MIGRATION_DATABASE_URL: `postgres://postgres@127.0.0.1:5433/${target}`,
    TEST_DATABASE_URL: `postgres://ai_hr_app@127.0.0.1:5433/${target}`,
    TEST_MIGRATION_DATABASE_URL: `postgres://postgres@127.0.0.1:5433/${target}`};
  const pgEnv = {...process.env, AIHR_CI_UNIT: 'db-1'};
  const container = `aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-db-1`;
  let app, browser, databaseStarted = false;
  const run = (label, bin, args, env = dbEnv, timeout = 180_000) => {
    const child = spawnSync(bin, args, {env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024});
    writeFileSync(join(out, label + '.log'), scrub((child.stdout ?? '') + (child.stderr ?? '')), {flag: 'wx', mode: 0o600});
    report.phases.push({label, exit: child.status});
    assert(!child.error && child.status === 0, label + ' failed');
    return child.stdout;
  };
  try {
    const buildEnv = {...dbEnv, NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=6144'};
    for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'])
      buildEnv[key] = 'postgres://nobody:nothing@127.0.0.1:1/no_database';
    run('production-build', 'pnpm', ['build'], buildEnv, 900_000);
    databaseStarted = true;
    run('postgres-setup', 'bash', [postgres, 'reset'], pgEnv);
    run('create-db', 'docker', ['exec', container, 'psql', '-U', 'postgres', '-p', '5433', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-c', `CREATE DATABASE ${target}`, '-c', `GRANT CONNECT ON DATABASE ${target} TO ai_hr_app`], pgEnv);
    run('migrate', 'pnpm', ['db:migrate'], dbEnv, 300_000);
    run('seed', process.execPath, ['--import', 'tsx', 'db/seed.ts']);
    const fixture = JSON.parse(run('fixture', process.execPath, ['--import', 'tsx', 'scripts/dev-fixture-orchestrator-harness.ts', 'prepare']));
    const fd = openSync(join(out, 'server.log'), 'wx', 0o600);
    app = spawn(process.execPath, [join(process.cwd(), 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3174'],
      {env: {...dbEnv, NODE_ENV: 'production'}, stdio: ['ignore', fd, fd]});
    closeSync(fd);
    const auth = 'Basic ' + Buffer.from('ci:' + gate).toString('base64');
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt++) {
      try { const r = await fetch(base + '/login', {headers: {authorization: auth}, signal: AbortSignal.timeout(2000)}); ready = r.status === 200; } catch { /* starting */ }
      if (!ready) await sleep(1000);
    }
    assert(ready, 'server not ready');
    const require = createRequire(join(process.cwd(), 'package.json'));
    const {chromium} = require('playwright'); browser = await chromium.launch({headless: true});
    const messages = JSON.parse(readFileSync('messages/en.json', 'utf8'));
    const login = async (actor, colorScheme = 'light') => {
      const context = await browser.newContext({httpCredentials: {username: 'ci', password: gate}, locale: 'en-US', colorScheme});
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      page.on('pageerror', e => report.errors.push({actor: actor.key, url: page.url(), kind: 'page', text: scrub(e.message).slice(0, 300)}));
      await page.goto(base + '/login');
      await page.locator(`form[action="/login/as"]:has(input[name="userId"][value="${actor.userId}"]) button[type="submit"]:visible`).click();
      await page.waitForURL(url => url.pathname !== '/login' && url.pathname !== '/login/as');
      return {context, page};
    };
    const skipTour = async page => {
      const skip = page.getByRole('button', {name: messages.onboarding?.skip ?? 'Skip', exact: true});
      if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
    };
    const admin = [...new Set([...pages('app/assistant'), ...pages('app/control-tower'), ...ADMIN_EXTRA])];
    const plan = [['group-admin', admin, 'light'], ['A-hr', SHORT, 'light'], ['A-employee', SHORT, 'light'], ['group-admin', SHORT, 'dark']];
    for (const [key, routes, scheme] of plan) {
      const actor = fixture.actors.find(row => row.key === key);
      const {context, page} = await login(actor, scheme);
      await page.setViewportSize({width: 1440, height: 1000});
      try {
        for (const route of routes) {
          try {
            const response = await page.goto(base + route, {waitUntil: 'networkidle', timeout: 30_000});
            await skipTour(page); await sleep(400);
            const h1 = await page.locator('h1:visible').first().innerText({timeout: 2000}).catch(() => null);
            const image = `${key}-${scheme}-${route === '/' ? 'home' : route.split('/').filter(Boolean).join('-')}.png`;
            await page.screenshot({path: join(out, image), fullPage: true, animations: 'disabled'});
            report.visits.push({actor: key, scheme, route, status: response?.status() ?? null, finalPath: new URL(page.url()).pathname + new URL(page.url()).search, h1, image});
          } catch (error) { report.visits.push({actor: key, scheme, route, error: scrub(error.message).slice(0, 300)}); }
        }
        if (scheme === 'light') {
          // The chat as each actor finds it, then one in-grammar and one out-of-grammar question.
          for (const [label, text] of [['in-grammar', 'How much annual leave do I have left?'], ['out-of-grammar', 'Which of my team is most likely to resign?'], ['setup', 'What do I still need to set up before running payroll?']]) {
            try {
              await page.goto(base + '/assistant', {waitUntil: 'networkidle'}); await skipTour(page);
              const box = page.locator('textarea:visible, input[type="text"]:visible').last();
              await box.fill(text); await box.press('Enter'); await sleep(6000);
              const image = `${key}-chat-${label}.png`;
              await page.screenshot({path: join(out, image), fullPage: true, animations: 'disabled'});
              report.chat.push({actor: key, label, text, image});
            } catch (error) { report.chat.push({actor: key, label, error: scrub(error.message).slice(0, 300)}); }
          }
        }
      } finally { await context.close(); }
    }
    report.exitCode = 0;
  } catch (error) { report.error = scrub(error instanceof Error ? error.message : 'capture failed').slice(0, 3000); report.exitCode = 1; }
  finally {
    if (browser) await browser.close().catch(() => {});
    if (app && app.exitCode === null) { app.kill('SIGTERM'); for (let i = 0; i < 50 && app.exitCode === null; i++) await sleep(100); if (app.exitCode === null) app.kill('SIGKILL'); }
    if (existsSync(join(out, 'server.log'))) writeFileSync(join(out, 'server.log'), scrub(readFileSync(join(out, 'server.log'), 'utf8')), {mode: 0o600});
    if (databaseStarted) spawnSync('bash', [postgres, 'stop'], {env: pgEnv, stdio: 'inherit'});
    writeFileSync(join(out, 'capture.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify({kind: report.kind, sha, visits: report.visits.length, exitCode: report.exitCode, error: report.error}));
  }
  process.exitCode = report.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
