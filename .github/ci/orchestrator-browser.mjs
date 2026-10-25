/** Actual production renderer on a NEW fictional runner database. Never a staging deployment. */
import assert from 'node:assert/strict';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join, relative, resolve, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {hostHealth} from './host-health.mjs';
import {CI_EXECUTION} from './manifest.mjs';
import {capturePostgresEvidence, validatePostgresEvidence} from './postgres-evidence.mjs';

const base = 'http://127.0.0.1:3174';
const tenant = '11111111-1111-1111-1111-111111111111';
const target = 'ai_hr_orchestrator_browser';
const locales = ['en', 'ms', 'zh', 'vi', 'th', 'ta'];
const routes = ['/control-tower', '/control-tower/agents'];
const postgres = fileURLToPath(new URL('./postgres.sh', import.meta.url));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();
const digest = value => createHash('sha256').update(value).digest('hex');

/**
 * Acceptance/risk map reviewed against candidate c0e137d5638cdfdf9bf807379df998d66d41dc65:
 * - Group admin (populated + execution-history link) and Empty HR (empty + link hidden):
 *   ALL six locales, BOTH viewports, BOTH routes = 48 visits. Current receipt rendering,
 *   translated queue/empty copy, keyboard controls and page overflow remain protected.
 * - A/B HR (opposing company scopes) and A/B employees (administrative redirects):
 *   English, BOTH viewports, BOTH routes = 16 visits. Every distinct actor/security boundary remains.
 * - Five receipt states + safe refresh + private-payload and model-admission checks remain unchanged.
 *   Synthetic non-current receipt states are still exercised in English, as before.
 * Consolidation basis: both page guards run before translations; core/hr-orchestrator.ts and
 * record-readiness.ts scope by grants/IDs, without locale. work-queue.tsx uses one translated renderer;
 * its role-specific execution-history condition is rendered both true and false in ALL locales above.
 * Reassess this basis on source changes. This source-only 64-visit plan is NOT validated experience
 * evidence, does not waive the real correction/save/reopen outcome, and cannot authorize a release.
 */
export function localesForActor(key) {
  assert(['group-admin', 'A-hr', 'B-hr', 'Empty-hr', 'A-employee', 'B-employee'].includes(key));
  return key === 'group-admin' || key === 'Empty-hr' ? [...locales] : ['en'];
}

export async function bounded(operation, label, milliseconds = 15_000) {
  assert(Number.isSafeInteger(milliseconds) && milliseconds > 0);
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function observed(predicate, label, milliseconds = 15_000) {
  assert(Number.isSafeInteger(milliseconds) && milliseconds > 0);
  const deadline = Date.now() + milliseconds;
  do {
    if (await bounded(Promise.resolve().then(predicate), label, Math.max(1, deadline - Date.now()))) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(100, remaining));
  } while (Date.now() < deadline);
  throw new Error(`${label} was not observed within ${milliseconds}ms`);
}

export function validateFixture(value, reused) {
  assert.equal(value?.preparationOnly, true); assert.equal(value?.reused, reused);
  assert.equal(value?.scenario, 'prepare'); assert.equal(value?.version, 1); assert.equal(value?.tenantId, tenant);
  assert.equal(value?.privateSentinel, 'ORCH23_PRIVATE_SENTINEL');
  assert.deepEqual(Object.keys(value.companies).sort(), ['A', 'B', 'Empty']);
  assert(Object.values(value.companies).every(uuid)); assert.equal(new Set(Object.values(value.companies)).size, 3);
  assert.deepEqual(value.actors.map(actor => actor.key).sort(), ['A-employee', 'A-hr', 'B-employee', 'B-hr', 'Empty-hr', 'group-admin']);
  assert.equal(new Set(value.actors.map(actor => actor.userId)).size, 6);
  for (const actor of value.actors) {
    assert(uuid(actor.userId)); assert(actor.personId === null || uuid(actor.personId));
    assert.equal(actor.companyId, actor.key === 'group-admin' ? null : value.companies[actor.key.split('-')[0]]);
    if (actor.key.endsWith('-employee')) assert(uuid(actor.personId));
  }
  assert.deepEqual(value.views.map(view => view.actor).sort(), ['A-hr', 'B-hr', 'Empty-hr', 'group-admin']);
  for (const view of value.views) {
    assert(Number.isSafeInteger(view.open) && view.open >= 0);
    assert.equal(view.lastRun?.failed, false); assert.equal(view.lastRun?.harnessVersion, 'readiness-v2');
  }
  return value;
}

export function receiptExpectation(scenario) {
  const success = ['succeeded', 'succeeded', 'succeeded', 'succeeded'];
  switch (scenario) {
    case 'legacy': case 'malformed': return {outcome: 'unknown', steps: Array(4).fill('unknown'), incomplete: true};
    case 'unsupported': return {outcome: 'unknown', steps: success, incomplete: true, version: 'readiness-v999'};
    case 'failed': return {outcome: 'failed', steps: ['succeeded', 'succeeded', 'failed', 'succeeded'], incomplete: false, version: 'readiness-v2'};
    case 'current': return {outcome: 'succeeded', steps: success, incomplete: false, version: 'readiness-v2'};
    default: throw Error('Unsupported fixed fixture scenario');
  }
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.CI, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted'); assert.equal(process.platform, 'linux');
  assert.equal(process.env.GITHUB_REPOSITORY, 'StradaverseHub/ai-hr');
  assert.equal(process.env.AIHR_CI_PG_MEMORY_GIB, String(CI_EXECUTION.postgres.memoryBytes / 1024 ** 3));
  assert.equal(process.env.AIHR_CI_PG_JIT, CI_EXECUTION.postgres.jit);
  assert(/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''));
  const sha = git('rev-parse', 'HEAD'), controller = process.env.AIHR_CI_CONTROL_HEAD;
  assert.equal(sha, process.env.AIHR_CI_HEAD); assert(/^[a-f0-9]{40}$/.test(controller ?? ''));
  assert.equal(git('status', '--porcelain'), ''); assert(!existsSync('.next/BUILD_ID'), 'Refuse an existing build');
  assert(!process.env.AUTH_PROVIDER && !process.env.SEED_MAY_DESTROY_OTHER_TENANTS);
  assert(!Object.entries(process.env).some(([key, value]) => key.startsWith('WORKOS_') && value));
  const out = resolve(process.argv[2]);
  const within = relative(resolve(process.env.RUNNER_TEMP), out);
  assert(within && !within.startsWith('../') && !isAbsolute(within));
  mkdirSync(out, {mode: 0o700});
  const started = Date.now();
  const report = {kind: 'PRODUCTION_RENDERER_DEVELOPMENT_ONLY', releaseEligible: false, sha, controller,
    startedAt: new Date(started).toISOString(), plannedVisits: 64,
    run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    fixtureOrigin: 'NEW_SYNTHETIC_CI_FIXTURE_NOT_RECOVERED_RAM_DATA', phases: [], visits: [], scenarios: [],
    browserErrors: [], consoleErrors: [], serverErrors: [], exitCode: 1,
    remaining: ['Profile-correction closure/reopen through the real UI', 'Final integrated release-candidate gate and staging arrival']};
  const gate = randomBytes(24).toString('hex'), secret = randomBytes(32).toString('hex');
  const scrub = text => String(text).replaceAll(gate, '[ephemeral gate]').replaceAll(secret, '[ephemeral key]');
  const checkpoint = (phase, detail = {}) => {
    report.current = {phase, at: new Date().toISOString(), ...detail};
    try {
      const next = join(out, 'progress.next.json');
      writeFileSync(next, scrub(JSON.stringify({...report, terminal: false}, null, 2)) + '\n', {mode: 0o600});
      renameSync(next, join(out, 'progress.json'));
    } catch (error) {
      // Failure to preserve evidence refuses success but must not prevent owned-resource cleanup.
      report.progressError = scrub(error instanceof Error ? error.message : 'Progress evidence unavailable').slice(0, 1000);
      report.exitCode = 1;
    }
    console.log(JSON.stringify({progress: phase, completedVisits: report.visits.length, elapsedMs: Date.now() - started, ...detail}));
  };
  const dbEnv = {...process.env, NODE_ENV: 'development', ALLOW_DEMO_SESSION: 'true', SHARE_PASSWORD: gate,
    AI_CONFIG_SECRET: secret, TEST_DB_NAMESPACE: 'orchbrowser23',
    DATABASE_URL: `postgres://ai_hr_app@127.0.0.1:5433/${target}`,
    MIGRATION_DATABASE_URL: `postgres://postgres@127.0.0.1:5433/${target}`,
    TEST_DATABASE_URL: `postgres://ai_hr_app@127.0.0.1:5433/${target}`,
    TEST_MIGRATION_DATABASE_URL: `postgres://postgres@127.0.0.1:5433/${target}`};
  const pgEnv = {...process.env, AIHR_CI_UNIT: 'db-1'};
  const container = `aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-db-1`;
  let app, browser, activePage, databaseStarted = false;
  const run = (label, bin, args, env = dbEnv, timeout = 180_000) => {
    checkpoint('process-start', {label});
    const started = Date.now();
    const child = spawnSync(bin, args, {env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024});
    writeFileSync(join(out, label + '.log'), scrub((child.stdout ?? '') + (child.stderr ?? '')), {flag: 'wx', mode: 0o600});
    report.phases.push({label, exit: child.status, signal: child.signal, elapsedMs: Date.now() - started});
    checkpoint('process-finished', {label, exit: child.status});
    console.log(JSON.stringify({phase: label, exit: child.status, elapsedMs: Date.now() - started}));
    assert(!child.error && child.status === 0 && child.signal === null, label + ' did not exit naturally with success');
    return child.stdout;
  };
  const psql = query => run('query-' + report.phases.length, 'docker', ['exec', '-e', 'PGCONNECT_TIMEOUT=2',
    '-e', 'PGOPTIONS=-c statement_timeout=2000', container, 'psql', '-U', 'postgres', '-p', '5433', '-d', target,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], pgEnv, 5000).trim();
  const fixture = scenario => JSON.parse(run('fixture-' + scenario + '-' + report.phases.length,
    process.execPath, ['--import', 'tsx', 'scripts/dev-fixture-orchestrator-harness.ts', scenario]));
  const captureFailure = async () => {
    if (report.failureScreenshot || !activePage || activePage.isClosed()) return;
    try {
      report.failureDom = await bounded(activePage.evaluate(() => ({
        lang: document.documentElement.lang,
        focus: {tag: document.activeElement?.tagName, id: document.activeElement?.id,
          role: document.activeElement?.getAttribute('role')},
        orchestratorPanels: [...document.querySelectorAll('details#orchestrator')].map(panel => ({
          open: panel.open, hidden: panel.hidden,
          hasLayout: panel.getClientRects().length > 0, visibility: getComputedStyle(panel).visibility,
        })),
      })), 'Failure DOM diagnostics', 5000);
    } catch { report.failureDomUnavailable = true; }
    try {
      await activePage.screenshot({path: join(out, 'failure.png'), fullPage: true, animations: 'disabled', timeout: 10_000});
      report.failureScreenshot = 'failure.png'; report.failureUrl = activePage.url();
    } catch { report.failureScreenshotUnavailable = true; }
  };
  try {
    report.healthBefore = hostHealth(); assert(report.healthBefore.ok, 'Insufficient runner disk headroom');
    // Build with closed DB URLs before starting PostgreSQL, reducing peak concurrent memory.
    const buildEnv = {...dbEnv, NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=6144'};
    for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'])
      buildEnv[key] = 'postgres://nobody:nothing@127.0.0.1:1/no_database';
    run('production-build', 'pnpm', ['build'], buildEnv, 900_000);
    report.buildId = readFileSync('.next/BUILD_ID', 'utf8').trim(); assert(report.buildId);
    databaseStarted = true;
    run('postgres-setup', 'bash', [postgres, 'reset'], pgEnv);
    run('create-new-fictional-database', 'docker', ['exec', container, 'psql', '-U', 'postgres', '-p', '5433', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-c', `CREATE DATABASE ${target}`, '-c', `GRANT CONNECT ON DATABASE ${target} TO ai_hr_app`], pgEnv);
    run('migrate-fictional-database', 'pnpm', ['db:migrate'], dbEnv, 300_000);
    run('seed-fictional-database', process.execPath, ['--import', 'tsx', 'db/seed.ts']);
    const first = validateFixture(fixture('prepare'), false), second = validateFixture(fixture('prepare'), true);
    assert.deepEqual(second.actors, first.actors); assert.deepEqual(second.companies, first.companies); assert.deepEqual(second.views, first.views);
    report.fixture = second;
    report.modelRunsBefore = Number(psql('select count(*) from ai_model_run'));
    assert(Number.isSafeInteger(report.modelRunsBefore));

    const fd = openSync(join(out, 'server.log'), 'wx', 0o600);
    app = spawn(process.execPath, [join(process.cwd(), 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3174'],
      {env: {...dbEnv, NODE_ENV: 'production'}, stdio: ['ignore', fd, fd]});
    closeSync(fd);
    let spawnError; app.on('error', error => { spawnError = error; });
    const auth = 'Basic ' + Buffer.from('ci:' + gate).toString('base64');
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      assert(!spawnError && app.exitCode === null && app.signalCode === null, 'Production server exited during startup');
      try {
        const response = await fetch(base + '/login', {headers: {authorization: auth}, signal: AbortSignal.timeout(2000)});
        if (response.status === 200) { ready = true; await response.arrayBuffer(); break; }
      } catch { /* The owned child may still be starting; bounded readiness polling only. */ }
      await sleep(1000);
    }
    assert(ready, 'Production server did not become ready');
    assert.equal((await fetch(base + '/', {redirect: 'manual'})).status, 401, 'The real demo gate must remain active');
    const require = createRequire(join(process.cwd(), 'package.json'));
    checkpoint('browser-launch');
    const {chromium} = require('playwright'); browser = await chromium.launch({headless: true, timeout: 15_000});
    const catalogues = Object.fromEntries(locales.map(locale => [locale, JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')).controlTower.orchestrator]));
    const onboarding = JSON.parse(readFileSync('messages/en.json', 'utf8')).onboarding;
    const login = async actor => {
      checkpoint('login-start', {actor: actor.key});
      // Read the real preference only to know whether this login should present the welcome tour.
      // Dismiss it through its real UI/action; never write a completion flag in the fixture or browser.
      assert(uuid(actor.userId));
      const needsTour = psql(`select onboarded_at is null from app_user where id = '${actor.userId}'`);
      assert(['t', 'f'].includes(needsTour));
      const context = await bounded(browser.newContext({httpCredentials: {username: 'ci', password: gate}, locale: 'en-US'}), 'Browser context creation');
      const page = await bounded(context.newPage(), 'Browser page creation');
      page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(15_000);
      activePage = page;
      page.on('pageerror', error => report.browserErrors.push(scrub(error.message)));
      page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(scrub(message.text())); });
      page.on('response', response => { if (response.status() >= 500) report.serverErrors.push({url: response.url(), status: response.status()}); });
      await page.goto(base + '/login');
      await page.locator(`form[action="/login/as"]:visible:has(input[name="userId"][value="${actor.userId}"]) button[type="submit"]`).click();
      await page.waitForURL(url => url.pathname !== '/login' && url.pathname !== '/login/as');
      if (needsTour === 't' && !actor.key.endsWith('-employee')) {
        checkpoint('onboarding-dialog', {actor: actor.key});
        const tour = page.getByRole('dialog', {name: onboarding.aria, exact: true});
        await tour.waitFor({state: 'visible'});
        checkpoint('onboarding-skip', {actor: actor.key});
        const [completed] = await Promise.all([
          page.waitForResponse(response => response.request().method() === 'POST'
            && Boolean(response.request().headers()['next-action']), {timeout: 15_000}),
          tour.getByRole('button', {name: onboarding.skip, exact: true}).click(),
        ]);
        checkpoint('onboarding-observe-saved-state', {actor: actor.key, status: completed.status()});
        assert(completed.ok(), 'Onboarding action returned an unsuccessful response');
        await tour.waitFor({state: 'hidden'});
        // UI dismissal alone is optimistic. Require its actual saved preference, without relying
        // on a response-body stream ending and without writing fixture/browser state ourselves.
        await observed(() => {
          const saved = psql(`select onboarded_at is not null from app_user where id = '${actor.userId}'`);
          assert(['t', 'f'].includes(saved)); return saved === 't';
        }, 'Saved onboarding preference');
        (report.onboardingDismissed ??= []).push(actor.key);
      }
      checkpoint('login-complete', {actor: actor.key});
      return {context, page};
    };
    const cardFor = (page, t) => page.getByRole('heading', {name: t.workTitle, exact: true}).locator('xpath=ancestor::*[@data-ui-card][1]');
    const expandWithKeyboard = async (details, label) => {
      const summary = details.locator(':scope > summary');
      await summary.waitFor({state: 'visible'});
      await summary.scrollIntoViewIfNeeded();
      // Navigation/hydration may preserve a disclosure's prior state. Normalize through the real
      // keyboard control, then prove its closed -> open transition. No DOM-state injection.
      if (await details.getAttribute('open') !== null) {
        checkpoint('keyboard-collapse', {label});
        await summary.press('Enter');
        await observed(async () => await details.getAttribute('open') === null, `${label} keyboard collapse`);
      }
      checkpoint('keyboard-expand', {label});
      await summary.press('Enter');
      await observed(async () => await details.getAttribute('open') !== null, `${label} keyboard expansion`);
    };
    const language = async (page, context, locale, actor) => {
      checkpoint('locale-start', {actor, locale});
      await page.getByRole('button', {name: 'Change language', exact: true}).click();
      const [response] = await Promise.all([
        page.waitForResponse(r => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']), {timeout: 15_000}),
        page.locator(`button[name="locale"][value="${locale}"]:visible`).click(),
      ]);
      checkpoint('locale-observe-rendered-state', {actor, locale, status: response.status()});
      assert(response.ok(), 'Locale action returned an unsuccessful response');
      await observed(async () => (await context.cookies(base)).find(cookie => cookie.name === 'NEXT_LOCALE')?.value === locale,
        'Saved locale cookie');
      await page.waitForFunction(expected => document.documentElement.lang === expected, locale, {timeout: 15_000});
      checkpoint('locale-complete', {actor, locale});
    };
    const noPrivateText = async page => assert(!(await page.content()).includes(second.privateSentinel), 'Private receipt text reached HTML');
    for (const actor of second.actors) {
      const {context, page} = await login(actor);
      try {
        for (const viewport of [{name: 'desktop', width: 1440, height: 1000}, {name: 'mobile', width: 375, height: 812}]) {
          await page.setViewportSize({width: viewport.width, height: viewport.height});
          for (const locale of localesForActor(actor.key)) {
            await language(page, context, locale, actor.key);
            for (const route of routes) {
              checkpoint('visit-start', {actor: actor.key, locale, route, viewport: viewport.name});
              await page.goto(base + route); const t = catalogues[locale];
              if (actor.key.endsWith('-employee')) {
                // A streamed server redirect can complete after goto's load event. Require the
                // actual canonical refusal destination before assessing access; never accept
                // an arbitrary non-administrative URL (including login or an error page).
                await page.waitForURL(url => url.origin === base && url.pathname === '/', {timeout: 15_000});
                assert(!routes.includes(new URL(page.url()).pathname), 'Employee reached an administrative queue');
                assert.equal(await page.getByRole('heading', {name: t.workTitle, exact: true}).count(), 0);
              } else {
                if (route === '/control-tower/agents') {
                  const panel = page.getByRole('main').locator('details#orchestrator:visible');
                  await expandWithKeyboard(panel, 'Orchestrator panel');
                }
                const card = cardFor(page, t); await card.waitFor({state: 'visible'});
                const text = await card.innerText();
                if (actor.key === 'A-hr') { assert(text.includes('Orchestration fictional employee A')); assert(!text.includes('Orchestration fictional employee B')); }
                if (actor.key === 'B-hr') { assert(text.includes('Orchestration fictional employee B')); assert(!text.includes('Orchestration fictional employee A')); }
                if (actor.key === 'Empty-hr') { assert(!text.includes('Orchestration fictional employee')); assert(text.includes(t.empty)); }
                assert.equal(await card.locator('a[href="/admin/scheduled-actions"]').count(), actor.key === 'group-admin' ? 1 : 0);
                const details = card.locator('details');
                await expandWithKeyboard(details, 'Recorded receipt');
                const summary = details.locator(':scope > summary');
                assert((await summary.innerText()).includes(t.runDetails.outcomes.succeeded));
              }
              await noPrivateText(page);
              const dimensions = await page.evaluate(() => ({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
              assert(dimensions.scroll <= dimensions.width + 1, 'Page overflows viewport');
              const image = `${actor.key}-${locale}-${viewport.name}-${route.split('/').filter(Boolean).join('-')}.png`;
              await page.screenshot({path: join(out, image), fullPage: true, animations: 'disabled'});
              report.visits.push({actor: actor.key, locale, route, viewport: viewport.name, image, dimensions});
              checkpoint('visit-complete', {actor: actor.key, locale, route, viewport: viewport.name});
            }
          }
        }
      } catch (error) { await captureFailure(); throw error; }
      finally { await bounded(context.close(), 'Browser context cleanup', 5000); }
    }
    const actor = second.actors.find(row => row.key === 'A-hr');
    const {context, page} = await login(actor);
    try {
      const t = catalogues.en;
      checkpoint('safe-refresh-start');
      await page.goto(base + '/control-tower');
      await cardFor(page, t).getByRole('button', {name: t.refresh, exact: true}).click();
      await page.waitForURL(url => url.searchParams.get('refresh') === 'complete');
      assert((await cardFor(page, t).innerText()).includes(t.refreshed));
      report.safeRefresh = true;
      checkpoint('safe-refresh-complete');
      for (const scenario of ['legacy', 'unsupported', 'malformed', 'failed', 'current']) {
        checkpoint('receipt-start', {scenario});
        fixture(scenario); await page.goto(base + '/control-tower');
        const expected = receiptExpectation(scenario), details = cardFor(page, t).locator('details');
        await expandWithKeyboard(details, `Receipt ${scenario}`);
        const summary = details.locator(':scope > summary');
        assert((await summary.innerText()).includes(t.runDetails.outcomes[expected.outcome]));
        assert.deepEqual((await details.locator('dd').allTextContents()).map(text => text.trim()), expected.steps.map(state => t.runDetails.states[state]));
        assert.equal((await details.innerText()).includes(t.runDetails.incomplete), expected.incomplete);
        if (expected.version) assert((await details.innerText()).includes(expected.version));
        await noPrivateText(page);
        await page.screenshot({path: join(out, `receipt-${scenario}.png`), fullPage: true, animations: 'disabled'});
        report.scenarios.push({scenario, ...expected});
        checkpoint('receipt-complete', {scenario});
      }
    } catch (error) { await captureFailure(); throw error; }
    finally { await bounded(context.close(), 'Browser context cleanup', 5000); }
    assert.equal(report.visits.length, report.plannedVisits, 'Incomplete actor/locale/viewport/route coverage');
    report.modelRunsAfter = Number(psql('select count(*) from ai_model_run'));
    assert.equal(report.modelRunsAfter, report.modelRunsBefore, 'Walkthrough created a model admission');
    assert.equal(report.browserErrors.length, 0); assert.equal(report.consoleErrors.length, 0); assert.equal(report.serverErrors.length, 0);
    assert.equal(git('rev-parse', 'HEAD'), sha); assert.equal(git('status', '--porcelain'), '');
    report.exitCode = 0;
  } catch (error) {
    report.failedAt = {...report.current};
    report.error = scrub(error instanceof Error ? error.message : 'Walkthrough failed').slice(0, 3000);
    await captureFailure();
    checkpoint('failed');
  }
  finally {
    checkpoint('cleanup-start');
    if (browser) await bounded(browser.close(), 'Browser cleanup', 5000).catch(() => { report.exitCode = 1; });
    if (app && app.exitCode === null && app.signalCode === null) {
      app.kill('SIGTERM');
      for (let i = 0; i < 50 && app.exitCode === null && app.signalCode === null; i++) await sleep(100);
      if (app.exitCode === null && app.signalCode === null) {
        app.kill('SIGKILL'); report.exitCode = 1;
        for (let i = 0; i < 50 && app.exitCode === null && app.signalCode === null; i++) await sleep(100);
      }
      if (app.exitCode === null && app.signalCode === null) {
        report.serverShutdownError = 'Owned server did not exit within the bounded termination wait'; report.exitCode = 1;
      }
    }
    if (existsSync(join(out, 'server.log'))) {
      const text = scrub(readFileSync(join(out, 'server.log'), 'utf8'));
      writeFileSync(join(out, 'server.log'), text, {mode: 0o600});
      report.serverLogHash = digest(text);
      if (/MISSING_MESSAGE|FORMATTING_ERROR|Unhandled|unhandledRejection|RangeError|TypeError/.test(text)) {
        report.serverLogError = true; report.exitCode = 1;
      }
    }
    if (databaseStarted) {
      const stats = spawnSync('bash', [postgres, 'stats'], {env: pgEnv, encoding: 'utf8', timeout: 15_000});
      writeFileSync(join(out, 'postgres-stats.txt'), (stats.stdout ?? '') + (stats.stderr ?? ''), {flag: 'wx', mode: 0o600});
      if (stats.status !== 0) report.exitCode = 1;
      try {
        const snapshot = capturePostgresEvidence('db-1');
        writeFileSync(join(out, 'postgres-evidence.json'), scrub(JSON.stringify(snapshot, null, 2)) + '\n', {flag: 'wx', mode: 0o600});
        validatePostgresEvidence(snapshot, CI_EXECUTION);
        report.databaseEvidenceValid = true;
      } catch (error) {
        report.databaseEvidenceValid = false;
        report.databaseEvidenceError = scrub(error instanceof Error ? error.message : 'Database evidence unavailable').slice(0, 3000);
        report.exitCode = 1;
      }
      if (spawnSync('bash', [postgres, 'stop'], {env: pgEnv, stdio: 'inherit', timeout: 15_000}).status !== 0) report.exitCode = 1;
    }
    report.healthAfter = hostHealth();
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - started;
    checkpoint('cleanup-complete');
    if (report.progressError) report.exitCode = 1;
    report.terminal = true;
    writeFileSync(join(out, 'walkthrough.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    console.log(JSON.stringify({kind: report.kind, sha, visits: report.visits.length, exitCode: report.exitCode, error: report.error}));
  }
  process.exitCode = report.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'One runner-owned evidence directory is required');
  main().catch(() => { console.error('Production walkthrough setup failed; no release evidence.'); process.exitCode = 1; });
}
