/** Actual production renderer on a NEW fictional runner database. Never a staging deployment. */
import assert from 'node:assert/strict';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join, relative, resolve, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {hostHealth} from './host-health.mjs';
import {CI_EXECUTION} from './manifest.mjs';
import {capturePostgresEvidence, validatePostgresEvidence, postgresProfileFromEnv} from './postgres-evidence.mjs';

const base = 'http://127.0.0.1:3174';
const tenant = '11111111-1111-1111-1111-111111111111';
const target = 'ai_hr_orchestrator_browser';
const locales = ['en', 'ms', 'zh', 'vi', 'th', 'ta'];
// /control-tower/agents became the AI administration area (1c868f527) and no longer holds the work queue.
const routes = ['/control-tower'];
const postgres = fileURLToPath(new URL('./postgres.sh', import.meta.url));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();
const digest = value => createHash('sha256').update(value).digest('hex');

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

/**
 * ADR-0151 §4.6c fictional prepared-action rows, inserted as the database owner. Counts per administrator are
 * fixed: company A's employee 6 leave.apply plus 1 claims.cancel, company B's 1 leave.apply, and one
 * tenant-wide Knowledge Base review that only the group administrator may count.
 */
export function outcomeFixtureSql(fixture) {
  const actor = key => fixture.actors.find(row => row.key === key);
  const [a, b, group] = [actor('A-employee'), actor('B-employee'), actor('group-admin')];
  for (const row of [a, b, group]) assert(uuid(row.userId) && (row.personId === null || uuid(row.personId)));
  const own = (who, kind, state, days, extra = '') => `('${kind}',gen_random_uuid(),'${fixture.tenantId}','${who.userId}','${who.personId}',
    (select e.id from employment e where e.person_id='${who.personId}' order by e.created_at limit 1),'${who.companyId}',
    ${state === 'awaiting_confirmation' ? `repeat('a',64),repeat('b',64)` : 'null,null'},'${state}',
    now()-interval '${days} days',now()-interval '${days} days'+interval '${state === 'awaiting_confirmation' ? '30 days' : '10 minutes'}'${extra})`;
  const apply = ",gen_random_uuid(),gen_random_uuid(),null,null,null", cancel = ",null,null,'claim_request',gen_random_uuid(),gen_random_uuid()", none = ',null,null,null,null,null';
  const rows = [own(a, 'leave.apply', 'completed', 12, apply), own(a, 'leave.apply', 'completed', 9, apply), own(a, 'leave.apply', 'discarded', 8, none),
    own(a, 'leave.apply', 'expired', 6, none), own(a, 'leave.apply', 'refused', 4, none), own(a, 'leave.apply', 'awaiting_confirmation', 0, none),
    own(a, 'claims.cancel', 'completed', 3, cancel), own(b, 'leave.apply', 'discarded', 2, none),
    `('knowledge_base.article.create',gen_random_uuid(),'${fixture.tenantId}','${group.userId}',null,null,null,null,null,'discarded',now()-interval '1 day',now()-interval '1 day'+interval '10 minutes'${none})`];
  return `insert into app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,intent_digest,reviewed_digest,state,created_at,expires_at,
    leave_request_id,submission_event_id,receipt_subject_kind,receipt_subject_id,receipt_event_id) values ${rows.join(',')}`;
}
export const OUTCOME_EXPECTED = {'group-admin': {apply: '7', kb: true}, 'A-hr': {apply: '6', kb: false}, 'B-hr': {apply: '1', kb: false}};

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

export function assertBrowserPostgresProfile(env) {
  const profile = postgresProfileFromEnv(env);
  assert.deepEqual(profile, CI_EXECUTION.postgres, 'Browser checks require the exact v15 PostgreSQL profile');
  return profile;
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.CI, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted'); assert.equal(process.platform, 'linux');
  assert.equal(process.env.GITHUB_REPOSITORY, 'StradaverseHub/ai-hr');
  const postgresProfile = assertBrowserPostgresProfile(process.env);
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
  const report = {kind: 'PRODUCTION_RENDERER_DEVELOPMENT_ONLY', releaseEligible: false, sha, controller,
    execution: {workers: CI_EXECUTION.workers, postgres: postgresProfile},
    run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    fixtureOrigin: 'NEW_SYNTHETIC_CI_FIXTURE_NOT_RECOVERED_RAM_DATA', phases: [], visits: [], scenarios: [],
    browserErrors: [], consoleErrors: [], serverErrors: [], exitCode: 1,
    remaining: ['Profile-correction closure/reopen through the real UI', 'Final integrated release-candidate gate and staging arrival']};
  const gate = randomBytes(24).toString('hex'), secret = randomBytes(32).toString('hex');
  const scrub = text => String(text).replaceAll(gate, '[ephemeral gate]').replaceAll(secret, '[ephemeral key]');
  const dbEnv = {...process.env, NODE_ENV: 'development', ALLOW_DEMO_SESSION: 'true', SHARE_PASSWORD: gate,
    AI_CONFIG_SECRET: secret, TEST_DB_NAMESPACE: 'orchbrowser23',
    DATABASE_URL: `postgres://ai_hr_app@127.0.0.1:5433/${target}`,
    MIGRATION_DATABASE_URL: `postgres://postgres@127.0.0.1:5433/${target}`,
    TEST_DATABASE_URL: `postgres://ai_hr_app@127.0.0.1:5433/${target}`,
    TEST_MIGRATION_DATABASE_URL: `postgres://postgres@127.0.0.1:5433/${target}`};
  const pgEnv = {...process.env, AIHR_CI_UNIT: 'db-1'};
  const container = `aihr-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-db-1`;
  let app, browser, databaseStarted = false;
  const run = (label, bin, args, env = dbEnv, timeout = 180_000) => {
    const started = Date.now();
    const child = spawnSync(bin, args, {env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024});
    writeFileSync(join(out, label + '.log'), scrub((child.stdout ?? '') + (child.stderr ?? '')), {flag: 'wx', mode: 0o600});
    report.phases.push({label, exit: child.status, signal: child.signal, elapsedMs: Date.now() - started});
    console.log(JSON.stringify({phase: label, exit: child.status, elapsedMs: Date.now() - started}));
    assert(!child.error && child.status === 0 && child.signal === null, label + ' did not exit naturally with success');
    return child.stdout;
  };
  const psql = query => run('query-' + report.phases.length, 'docker', ['exec', container, 'psql', '-U', 'postgres', '-p', '5433', '-d', target, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], pgEnv).trim();
  const fixture = scenario => JSON.parse(run('fixture-' + scenario + '-' + report.phases.length,
    process.execPath, ['--import', 'tsx', 'scripts/dev-fixture-orchestrator-harness.ts', scenario]));
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
    const {chromium} = require('playwright'); browser = await chromium.launch({headless: true});
    const catalogues = Object.fromEntries(locales.map(locale => [locale, JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')).controlTower.orchestrator]));
    const login = async actor => {
      const context = await browser.newContext({httpCredentials: {username: 'ci', password: gate}, locale: 'en-US'});
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      page.on('pageerror', error => report.browserErrors.push(scrub(error.message)));
      page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(scrub(message.text())); });
      page.on('response', response => { if (response.status() >= 500) report.serverErrors.push({url: response.url(), status: response.status()}); });
      await page.goto(base + '/login');
      await page.locator(`form[action="/login/as"]:has(input[name="userId"][value="${actor.userId}"]) button[type="submit"]:visible`).click();
      await page.waitForURL(url => url.pathname !== '/login' && url.pathname !== '/login/as');
      return {context, page};
    };
    const cardFor = (page, t) => page.getByRole('heading', {name: t.workTitle, exact: true}).locator('xpath=ancestor::*[@data-ui-card][1]');
    // The renderer no longer exposes the "Change language" button this walkthrough used to click (run
    // 40751449728 timed out waiting for it), so it sets the NEXT_LOCALE cookie that button's server action
    // writes. Each visit still proves the locale by finding that locale's own copy on the page.
    const language = async (page, context, locale) => {
      await context.addCookies([{name: 'NEXT_LOCALE', value: locale, url: base}]);
      assert.equal((await context.cookies(base)).find(cookie => cookie.name === 'NEXT_LOCALE')?.value, locale);
    };
    const noPrivateText = async page => assert(!(await page.content()).includes(second.privateSentinel), 'Private receipt text reached HTML');
    for (const actor of second.actors) {
      const {context, page} = await login(actor);
      try {
        for (const viewport of [{name: 'desktop', width: 1440, height: 1000}, {name: 'mobile', width: 375, height: 812}]) {
          await page.setViewportSize({width: viewport.width, height: viewport.height});
          for (const locale of locales) {
            await language(page, context, locale);
            for (const route of routes) {
              await page.goto(base + route); const t = catalogues[locale];
              if (actor.key.endsWith('-employee')) {
                // A streamed response can carry requireAdmin's redirect to the client, after goto resolves.
                await page.waitForURL(url => !routes.includes(url.pathname)).catch(() => {});
                assert(!routes.includes(new URL(page.url()).pathname), 'Employee reached an administrative queue');
                assert.equal(await page.getByRole('heading', {name: t.workTitle, exact: true}).count(), 0);
              } else {
                const card = cardFor(page, t); await card.waitFor({state: 'visible'});
                const text = await card.innerText();
                if (actor.key === 'A-hr') { assert(text.includes('Orchestration fictional employee A')); assert(!text.includes('Orchestration fictional employee B')); }
                if (actor.key === 'B-hr') { assert(text.includes('Orchestration fictional employee B')); assert(!text.includes('Orchestration fictional employee A')); }
                if (actor.key === 'Empty-hr') { assert(!text.includes('Orchestration fictional employee')); assert(text.includes(t.empty)); }
                assert.equal(await card.locator('a[href="/admin/scheduled-actions"]').count(), actor.key === 'group-admin' ? 1 : 0);
                const details = card.locator('details'); assert.equal(await details.getAttribute('open'), null);
                const summary = details.locator('summary'); await summary.focus(); await page.keyboard.press('Enter');
                assert.notEqual(await details.getAttribute('open'), null, 'Keyboard could not expand receipt');
                assert((await summary.innerText()).includes(t.runDetails.outcomes.succeeded));
              }
              await noPrivateText(page);
              const dimensions = await page.evaluate(() => ({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
              assert(dimensions.scroll <= dimensions.width + 1, 'Page overflows viewport');
              const image = `${actor.key}-${locale}-${viewport.name}-${route.split('/').filter(Boolean).join('-')}.png`;
              await page.screenshot({path: join(out, image), fullPage: true, animations: 'disabled'});
              report.visits.push({actor: actor.key, locale, route, viewport: viewport.name, image, dimensions});
            }
          }
        }
      } finally { await context.close(); }
    }
    const actor = second.actors.find(row => row.key === 'A-hr');
    const {context, page} = await login(actor);
    try {
      const t = catalogues.en;
      await page.goto(base + '/control-tower');
      await cardFor(page, t).getByRole('button', {name: t.refresh, exact: true}).click();
      await page.waitForURL(url => url.searchParams.get('refresh') === 'complete');
      assert((await cardFor(page, t).innerText()).includes(t.refreshed));
      report.safeRefresh = true;
      for (const scenario of ['legacy', 'unsupported', 'malformed', 'failed', 'current']) {
        fixture(scenario); await page.goto(base + '/control-tower');
        const expected = receiptExpectation(scenario), details = cardFor(page, t).locator('details');
        const summary = details.locator('summary'); await summary.focus(); await page.keyboard.press('Enter');
        assert.notEqual(await details.getAttribute('open'), null);
        assert((await summary.innerText()).includes(t.runDetails.outcomes[expected.outcome]));
        assert.deepEqual((await details.locator('dd').allTextContents()).map(text => text.trim()), expected.steps.map(state => t.runDetails.states[state]));
        assert.equal((await details.innerText()).includes(t.runDetails.incomplete), expected.incomplete);
        if (expected.version) assert((await details.innerText()).includes(expected.version));
        await noPrivateText(page);
        await page.screenshot({path: join(out, `receipt-${scenario}.png`), fullPage: true, animations: 'disabled'});
        report.scenarios.push({scenario, ...expected});
      }
    } finally { await context.close(); }
    // ADR-0151 §4.6c: the outcome view beside the process assessment, on fictional rows, per administrator scope.
    psql(outcomeFixtureSql(second));
    const messages = Object.fromEntries(locales.map(locale => [locale, JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'))]));
    for (const [key, expected] of Object.entries(OUTCOME_EXPECTED)) {
      const {context, page} = await login(second.actors.find(row => row.key === key));
      try {
        for (const viewport of [{name: 'desktop', width: 1440, height: 1000}, {name: 'mobile', width: 375, height: 812}]) {
          await page.setViewportSize({width: viewport.width, height: viewport.height});
          for (const locale of key === 'group-admin' ? locales : ['en']) {
            await language(page, context, locale);
            await page.goto(base + '/control-tower/opportunities');
            const o = messages[locale].processAssessment.outcomes;
            // The first-visit product tour covers the page; dismiss it as a person would.
            const skip = page.getByRole('button', {name: messages[locale].onboarding.skip, exact: true});
            if (await skip.isVisible().catch(() => false)) { await skip.click(); await skip.waitFor({state: 'hidden'}); }
            // Streaming can leave a hidden copy of a card in the document; only the visible one is the page.
            const section = title => page.locator('[data-ui-section-header]:visible', {hasText: title}).locator('xpath=ancestor::*[@data-ui-card][1]');
            const table = section(o.title);
            await table.waitFor({state: 'visible'});
            const row = kind => table.locator('tr', {has: page.locator('span.font-mono', {hasText: new RegExp(`^${kind.replace('.', '\\.')}$`)})});
            const cells = (await row('leave.apply').locator('td').allTextContents()).map(text => text.trim());
            assert.equal(cells[2], expected.apply, `${key} leave.apply prepared`);
            assert.equal(await row('knowledge_base.article.create').count(), expected.kb ? 1 : 0, `${key} tenant-wide row visibility`);
            await section(o.coverageTitle).waitFor({state: 'visible'});
            await noPrivateText(page);
            const dimensions = await page.evaluate(() => ({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
            assert(dimensions.scroll <= dimensions.width + 1, 'Outcome page overflows viewport');
            const image = `outcomes-${key}-${locale}-${viewport.name}.png`;
            await page.screenshot({path: join(out, image), fullPage: true, animations: 'disabled'});
            // The shell scrolls inside its own container, so each new card is also captured whole.
            const leaveCard = page.locator('[data-ui-card]:visible', {has: page.getByRole('heading', {name: messages[locale].processAssessment.processes.leave})});
            for (const [part, locator] of [['table', table], ['coverage', section(o.coverageTitle)], ['leave', leaveCard]])
              await locator.screenshot({path: join(out, `outcomes-${key}-${locale}-${viewport.name}-${part}.png`), animations: 'disabled'});
            report.visits.push({actor: key, locale, route: '/control-tower/opportunities', viewport: viewport.name, image, dimensions});
          }
        }
      } finally { await context.close(); }
    }
    report.modelRunsAfter = Number(psql('select count(*) from ai_model_run'));
    assert.equal(report.modelRunsAfter, report.modelRunsBefore, 'Walkthrough created a model admission');
    assert.equal(report.browserErrors.length, 0); assert.equal(report.consoleErrors.length, 0); assert.equal(report.serverErrors.length, 0);
    assert.equal(git('rev-parse', 'HEAD'), sha); assert.equal(git('status', '--porcelain'), '');
    report.exitCode = 0;
  } catch (error) { report.error = scrub(error instanceof Error ? error.message : 'Walkthrough failed').slice(0, 3000); }
  finally {
    if (browser) await browser.close().catch(() => { report.exitCode = 1; });
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
      const stats = spawnSync('bash', [postgres, 'stats'], {env: pgEnv, encoding: 'utf8'});
      writeFileSync(join(out, 'postgres-stats.txt'), (stats.stdout ?? '') + (stats.stderr ?? ''), {flag: 'wx', mode: 0o600});
      if (stats.status !== 0) report.exitCode = 1;
      try {
        const snapshot = capturePostgresEvidence('db-1', postgresProfile);
        writeFileSync(join(out, 'postgres-evidence.json'), scrub(JSON.stringify(snapshot, null, 2)) + '\n', {flag: 'wx', mode: 0o600});
        validatePostgresEvidence(snapshot, CI_EXECUTION);
        report.databaseEvidenceValid = true;
      } catch (error) {
        report.databaseEvidenceValid = false;
        report.databaseEvidenceError = scrub(error instanceof Error ? error.message : 'Database evidence unavailable').slice(0, 3000);
        report.exitCode = 1;
      }
      if (spawnSync('bash', [postgres, 'stop'], {env: pgEnv, stdio: 'inherit'}).status !== 0) report.exitCode = 1;
    }
    report.healthAfter = hostHealth();
    writeFileSync(join(out, 'walkthrough.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    console.log(JSON.stringify({kind: report.kind, sha, visits: report.visits.length, exitCode: report.exitCode, error: report.error}));
  }
  process.exitCode = report.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'One runner-owned evidence directory is required');
  main().catch(() => { console.error('Production walkthrough setup failed; no release evidence.'); process.exitCode = 1; });
}
