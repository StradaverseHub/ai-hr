/** Supplemental rendered evidence from an unmodified candidate and an isolated database. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {realpathSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const source = realpathSync(process.cwd());
const automation = realpathSync(join(source, '../automation'));
const evidence = join(realpathSync(process.env.RUNNER_TEMP), 'payroll-four-grant');
const candidate = process.env.AIHR_CI_HEAD;
const controller = process.env.AIHR_CI_CONTROL_HEAD;
const appUrl = 'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test';
const ownerUrl = 'postgres://postgres@127.0.0.1:5433/ai_hr_test';
const origin = 'http://127.0.0.1:3159';

function assertClean(checkout, sha) {
  const git = (...args) => execFileSync('git', args, {cwd: checkout, encoding: 'utf8'}).trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(git('rev-parse', 'HEAD'), sha);
  assert.equal(git('status', '--porcelain'), '');
}

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
assert.equal(process.env.GITHUB_REPOSITORY, 'StradaverseHub/ai-hr');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.platform, 'linux');
assert.equal(source, join(realpathSync(process.env.GITHUB_WORKSPACE), 'source'));
assert.deepEqual([process.env.DATABASE_URL, process.env.TEST_DATABASE_URL], [appUrl, appUrl]);
assert.deepEqual([process.env.MIGRATION_DATABASE_URL, process.env.TEST_MIGRATION_DATABASE_URL], [ownerUrl, ownerUrl]);
assertClean(source, candidate);
assertClean(automation, controller);

const fromCandidate = file => import(pathToFileURL(join(source, file)).href);
const {chromium} = createRequire(join(source, 'package.json'))('playwright');
const {owner, seedBase, resetDb, entitledCtx, setModule, closeAll} = await fromCandidate('test/harness.ts');
const {seedCatalogs} = await fromCandidate('scripts/seed-catalogs.ts');
const {createCompany, createDepartment, assignRole} = await fromCandidate('core/admin.ts');
const {hireEmployee} = await fromCandidate('core/org.ts');
const {seedPayrollCycleCatalog} = await fromCandidate('core/payroll-cycle.ts');
const {previewPayrollHistoryUpload, confirmPayrollHistoryUpload} = await fromCandidate('core/payroll-history-revisions.ts');
const {PAYROLL_HISTORY_HEADERS} = await fromCandidate('lib/payroll-history-import-schema.ts');
const {toCsv} = await fromCandidate('lib/csv.ts');
const {todayInKualaLumpur} = await fromCandidate('lib/hr-date.ts');
const {LOCALE_COOKIE} = await fromCandidate('i18n/config.ts');
const {OwnedVisualPreview} = await fromCandidate('test/helpers/owned-visual-preview.ts');
const {PROJECT_INSTALLED_OWNERSHIP} = await fromCandidate('test/helpers/installed-owner-projection.ts');
const {client: runtime} = await fromCandidate('db/client.ts');

async function seed() {
  await seedCatalogs(owner.db);
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'payroll', 'active');
  const ctx = await entitledCtx(base);
  const userId = randomUUID();
  await owner.client`insert into public.app_user(id,tenant_id,workos_user_id,onboarded_at)
    values(${userId},${base.tenantId},${'payroll-browser-' + userId},now())`;

  const year = Number(todayInKualaLumpur().slice(0, 4)) - 1;
  const companies = [];
  const csv = [Array.from(PAYROLL_HISTORY_HEADERS)];
  for (const [index, month] of ['02', '04', '06', '08', '10'].entries()) {
    const code = `DEMO-PAY-${index + 1}`;
    const name = `Fictional Payroll Company ${index + 1}`;
    const period = `${year}-${month}`;
    const amount = (5101 + index).toFixed(2);
    const {id} = await createCompany(ctx, {legalName: name, country: 'MY', currency: 'MYR'});
    const department = await createDepartment(ctx, {companyId: id, name: 'Payroll Diagnostic'});
    await hireEmployee(ctx, {
      person: {fullName: `Fictional Payroll Employee ${index + 1}`, primaryEmail: `${code}@fixture.invalid`},
      companyId: id, departmentId: department.id, employeeCode: code,
      employmentType: 'full_time', hiredOn: `${year - 1}-01-01`,
    });
    await seedPayrollCycleCatalog(ctx, id);
    for (const component of ['BASIC', 'EEEPF', 'EESOCSO', 'EEEIS', 'PCB']) {
      csv.push([code, period, 'ME', component, id, component === 'BASIC' ? amount : '0.00']);
    }
    if (index < 4) await assignRole(ctx, {appUserId: userId, role: 'hr_admin', companyId: id});
    companies.push({id, name, period, month, amount});
  }

  const upload = await previewPayrollHistoryUpload(ctx, {
    name: 'fictional-four-company-history.csv', content: Buffer.from(toCsv(csv)), operationKey: randomUUID(),
  });
  assert.equal(upload.plan.counts.created, 5);
  assert.equal(upload.plan.counts.invalid, 0);
  await confirmPayrollHistoryUpload(ctx, {
    attemptId: upload.attemptId, previewHash: upload.plan.previewHash, confirmReplacement: true,
  });
  return {userId, tenantId: base.tenantId, year, companies, attemptId: upload.attemptId};
}

async function assertDatabase(fixture) {
  const [server] = await owner.client`select current_database() as database,
    current_setting('server_version_num')::int as version, session_user::text as session`;
  assert.equal(server.database, 'ai_hr_test');
  assert.equal(server.session, 'postgres');
  assert.equal(Math.floor(server.version / 10000), 16);

  // This diagnostic runs ordinary CI migrations, then projects their installed ownership on its disposable database.
  const roles = await owner.client`select 1 from pg_roles where rolname='ai_hr_owner'`;
  if (roles.length === 0) {
    await owner.client`create role ai_hr_owner login nosuperuser nocreatedb nocreaterole noreplication nobypassrls`;
  }
  await owner.client`alter database ai_hr_test owner to ai_hr_owner`;
  await owner.client.unsafe(PROJECT_INSTALLED_OWNERSHIP);

  const [actor] = await runtime`select session_user::text as session,current_user::text as actor,rolsuper,rolbypassrls
    from pg_roles where rolname=current_user`;
  assert.deepEqual({...actor}, {session: 'ai_hr_app', actor: 'ai_hr_app', rolsuper: false, rolbypassrls: false});
  const [migrationOwner] = await owner.client`select rolname::text as role, rolsuper, rolbypassrls
    from pg_roles where rolname='ai_hr_owner'`;
  assert.deepEqual({...migrationOwner}, {role: 'ai_hr_owner', rolsuper: false, rolbypassrls: false});

  const routines = await owner.client`select p.oid::regprocedure::text as name, p.proowner::regrole::text as owner,
    p.prosecdef as definer, p.proconfig as config from pg_proc p where oid in (
      'app.payroll_tax_basis_original_employer_read(uuid)'::regprocedure,
      'app.principal_snapshot_current()'::regprocedure,
      'app.is_company_descendant(uuid,uuid)'::regprocedure
    ) order by 1`;
  assert.equal(routines.length, 3);
  assert.ok(routines.every(routine => routine.owner === 'ai_hr_owner' && routine.definer));
  assert.ok(routines.find(routine => routine.name.includes('original_employer_read')).config.includes('row_security=on'));
  const relations = await owner.client`select oid::regclass::text as name, relowner::regrole::text as owner,
    relrowsecurity as rls, relforcerowsecurity as force_rls, reloptions as options from pg_class where oid in (
      'public.company_organisation_mapping'::regclass, 'public.payroll_batch'::regclass,
      'public.payslip'::regclass, 'public.payroll_history_effective_batch'::regclass
    ) order by 1`;
  assert.equal(relations.length, 4);
  assert.ok(relations.every(relation => relation.owner === 'ai_hr_owner'));
  assert.ok(relations.some(relation => relation.name.endsWith('company_organisation_mapping') && relation.rls && relation.force_rls));
  for (const table of ['payroll_batch', 'payslip']) {
    assert.ok(relations.some(relation => relation.name === table && relation.rls));
  }
  assert.ok(relations.some(relation => relation.name === 'payroll_history_effective_batch'
    && relation.options.includes('security_invoker=true')));

  const grants = await owner.client`select role::text, company_id::text from public.role_assignment
    where tenant_id=${fixture.tenantId} and app_user_id=${fixture.userId} order by company_id`;
  assert.equal(grants.length, 4);
  assert.ok(grants.every(grant => grant.role === 'hr_admin'));
  assert.deepEqual(grants.map(grant => grant.company_id), fixture.companies.slice(0, 4).map(company => company.id).sort());
  const imported = await owner.client`select company_id::text, pay_period, employee_count::int
    from public.payroll_batch where tenant_id=${fixture.tenantId} and history_import_attempt_id=${fixture.attemptId} order by pay_period`;
  assert.deepEqual([...imported], fixture.companies.map(company => ({company_id: company.id, pay_period: company.period, employee_count: 1})));
  const [mapping] = await owner.client`select count(*)::int as mappings from public.company_organisation_mapping
    where tenant_id=${fixture.tenantId}`;
  assert.equal(mapping.mappings, 0);
  return {server, actor, migrationOwner, routines, relations, grants, imported};
}

const money = new Intl.NumberFormat('en-MY', {minimumFractionDigits: 2, maximumFractionDigits: 2});

async function render(page, label, query, scope, expected, denied) {
  await page.context().addCookies([{name: 'company_scope', value: scope.map(company => company.id).join(','), url: origin}]);
  const url = new URL('/payroll', origin);
  url.search = query.toString();
  const response = await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 120000});
  assert.equal(response.status(), 200, label);
  assert.equal(new URL(page.url()).origin, origin, label);
  assert.equal(new URL(page.url()).pathname, '/payroll', label);
  const main = page.locator('main');
  await main.getByRole('heading', {level: 1}).first().waitFor();
  const table = main.locator('[data-tour="payroll-batches"] table');
  await table.waitFor();
  const rows = table.locator('tbody tr');
  const rendered = await rows.evaluateAll(items => items.filter(row => row.cells.length > 1).map(row => {
    const cells = [...row.cells].map(cell => cell.innerText.trim());
    return {period: cells[0], company: cells[2], employees: cells[4], net: cells[5]};
  }));
  assert.deepEqual(rendered, expected.map(company => ({
    period: company.period, company: company.name, employees: '1',
    net: `MYR ${money.format(Number(company.amount))}`,
  })), label);
  const mainText = await main.innerText();
  assert.doesNotMatch(mainText, /Application error|MISSING_MESSAGE|INVALID_MESSAGE/);
  assert.ok(!mainText.includes(denied.name), label + ' leaks the ungranted company');
  assert.ok(!mainText.includes(money.format(Number(denied.amount))), label + ' leaks the ungranted amount');
  await page.screenshot({path: join(evidence, label + '.png'), fullPage: true});
  return {label, path: url.pathname + url.search, selectedCompanyIds: scope.map(company => company.id), rendered};
}

let browser, preview;
try {
  const fixture = await seed();
  const database = await assertDatabase(fixture);
  preview = new OwnedVisualPreview(origin, join(evidence, 'preview.log'), AbortSignal.timeout(12 * 60 * 1000), evidence);
  await preview.start();
  browser = await chromium.launch();
  const context = await browser.newContext({viewport: {width: 1440, height: 1050}});
  await context.addCookies([{name: 'dev_user', value: fixture.userId, url: origin}, {name: LOCALE_COOKIE, value: 'en', url: origin}]);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const allowed = fixture.companies.slice(0, 4);
  const denied = fixture.companies[4];
  const checks = [];
  for (const [index, company] of allowed.entries()) {
    checks.push(await render(page, 'selected-company-' + (index + 1), new URLSearchParams(), [company], [company], denied));
  }
  const all = new URLSearchParams(allowed.map(company => ['company', company.id]));
  checks.push(await render(page, 'four-companies-latest', all, allowed, [allowed.at(-1)], denied));
  all.set('year', String(fixture.year));
  for (const company of allowed) all.append('m', company.month);
  checks.push(await render(page, 'four-companies-all-periods', all, allowed, [...allowed].reverse(), denied));
  checks.push(await render(page, 'ungranted-company', new URLSearchParams({
    company: denied.id, year: String(fixture.year), m: denied.month,
  }), [denied], [], denied));
  await context.close();
  assertClean(source, candidate);
  assertClean(automation, controller);
  writeFileSync(join(evidence, 'rendered-payroll.json'), JSON.stringify({
    kind: 'ISOLATED_RENDERED_PAYROLL_ACCEPTANCE', candidate, controller,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    releaseAuthorized: false, installedAcceptance: false,
    ownership: 'ordinary CI migration followed by canonical installed-ownership projection',
    authentication: 'isolated development browser session resolving live role assignments',
    database, checks,
  }, null, 2) + '\n');
} finally {
  const cleanup = await Promise.allSettled([browser?.close(), preview?.close(), closeAll()]);
  assertClean(source, candidate);
  assertClean(automation, controller);
  for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
}
