/** Shared hosted diagnostic for the real Personnel page, search and export at a fictional size.
 * The calling test file owns the module mocks (session, cookies, translations, navigation); this module
 * only drives the application code and records round trips, owners, wall time and nested plans.
 * It supplies no release evidence and never touches an installation. */
import {existsSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {cloneElement,createElement,isValidElement,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NextIntlClientProvider} from 'next-intl';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {vi,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {client as applicationClient,withTenant,type SessionContext} from '../../db/client';
import {owner} from '../harness';
import {seedPersonnelScaleFixture,type PersonnelScaleFixture} from './personnel-scale-fixture';

export type PersonnelDiagnosticState = {session?: SessionContext; scopeCookie?: string};
export const personnelDiagnosticState = ((globalThis as {__personnelPageDiagnostic?: PersonnelDiagnosticState})
  .__personnelPageDiagnostic ??= {});

const root = process.cwd();
const en = JSON.parse(readFileSync(fileURLToPath(new URL('../../messages/en.json', import.meta.url)), 'utf8'));
const print = (label: string, value: unknown) => console.info('[personnel-page-diagnostic] ' + label + ' ' + JSON.stringify(value));

type Statement = {connection: number; sql: string; owner: string};
let recording: Statement[] | null = null;
function statementOwner() {
  const limit = Error.stackTraceLimit; Error.stackTraceLimit = 60;
  const stack = new Error().stack ?? ''; Error.stackTraceLimit = limit;
  const frames: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const match = /at (?:async )?(?:(\S+) \()?(.+?):(\d+):\d+\)?$/.exec(line.trim());
    if (!match) continue;
    const file = relative(root, match[2].replace(/^file:\/\//, ''));
    if (file.startsWith('..') || file.startsWith('node_modules') || file.startsWith('db/') || file.startsWith('test/')
      || file.startsWith('node:') || file.includes('personnel-read-bounds')) continue;
    frames.push((match[1] ?? '?') + '@' + file + ':' + match[3]);
    if (frames.length === 2) break;
  }
  return frames.join(' < ') || 'unattributed';
}
function installTracer() {
  const options = applicationClient.options as {debug?: unknown};
  options.debug = (connection: number, query: string) => {
    if (recording) recording.push({connection, sql: query.replace(/\s+/g, ' ').trim().slice(0, 300), owner: statementOwner()});
  };
}
async function traced<T>(work: () => Promise<T>) {
  const statements: Statement[] = [];
  recording = statements;
  const started = performance.now();
  try {
    const result = await work();
    return {result, ms: performance.now() - started, statements};
  } finally {recording = null;}
}
function summarize(statements: Statement[]) {
  const byOwner = new Map<string, number>(), bySql = new Map<string, number>();
  for (const s of statements) {
    byOwner.set(s.owner, (byOwner.get(s.owner) ?? 0) + 1);
    bySql.set(s.sql.slice(0, 160), (bySql.get(s.sql.slice(0, 160)) ?? 0) + 1);
  }
  return {
    trips: statements.length,
    transactions: statements.filter(s => /^begin/i.test(s.sql)).length,
    connections: new Set(statements.map(s => s.connection)).size,
    byOwner: [...byOwner].map(([owner, trips]) => ({owner, trips})).sort((a, b) => b.trips - a.trips),
    repeated: [...bySql].filter(([, count]) => count > 1).map(([text, count]) => ({sql: text, count})).sort((a, b) => b.count - a.count).slice(0, 12),
  };
}

const isAsync = (fn: unknown) => typeof fn === 'function' && fn.constructor?.name === 'AsyncFunction';
const isPlainRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
async function settle(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (isValidElement(node)) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (isAsync(el.type)) return settle(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
    const next: Record<string, unknown> = {};
    let touched = false;
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === 'children' || isValidElement(v) || Array.isArray(v) || isPlainRecord(v)) {next[k] = await settle(v); touched = true;}
    }
    return touched ? cloneElement(el, next) : el;
  }
  return node;
}
function findProps(node: unknown, prop: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) node.forEach(n => findProps(n, prop, out));
  else if (isValidElement(node)) {
    const props = (node as ReactElement<Record<string, unknown>>).props ?? {};
    if (prop in props) out.push(props);
    for (const v of Object.values(props)) if (isValidElement(v) || Array.isArray(v)) findProps(v, prop, out);
  }
  return out;
}

type Scenario = {name: string; sp?: Record<string, string>; search?: string; exportQuery?: string};
function scenarios(f: PersonnelScaleFixture): Scenario[] {
  return [
    {name: 'list', sp: {}},
    {name: 'page-4', sp: {page: '3'}},
    {name: 'deep-page', sp: {page: String(Math.floor(f.count * 0.35 / 25))}},
    {name: 'size-100', sp: {size: '100'}},
    {name: 'search-q-name', sp: {q: 'Siew Ling'}},
    {name: 'search-q-code', sp: {q: 'FX0012'}},
    {name: 'filter-company', sp: {companies: f.companies.b}},
    {name: 'filter-department', sp: {dept: f.departments.b[1]}},
    {name: 'filter-business-unit', sp: {bu: f.businessUnits[2]}},
    {name: 'filter-status-resigned', sp: {bucket: 'resigned'}},
    {name: 'filter-status-probation', sp: {bucket: 'probation'}},
    {name: 'filter-legacy-terminated', sp: {status: 'terminated'}},
    {name: 'filter-department-active', sp: {dept: f.departments.b[1], bucket: 'active'}},
    {name: 'filter-parent-company', sp: {parent: f.companies.b}},
    {name: 'filter-grade', sp: {grade: '13,H'}},
    {name: 'filter-quality-superior', sp: {quality: 'missing_direct_superior'}},
    {name: 'sort-department', sp: {sort: 'department'}},
    {name: 'sort-join-date-desc', sp: {sort: 'joinDate', direction: 'desc'}},
    {name: 'private-search', search: 'Tan'},
    {name: 'export-page', exportQuery: 'mode=page&page=0&size=25&format=csv'},
    {name: 'export-all-department', exportQuery: 'mode=all&dept=' + f.departments.b[1] + '&format=csv'},
  ];
}

type Modules = {
  page: (props: {searchParams: Promise<Record<string, string>>}) => Promise<unknown>;
  search: (request: Request) => Promise<Response>;
  exportRoute: (request: Request) => Promise<Response>;
};

async function renderPage(modules: Modules, sp: Record<string, string>) {
  const tree = await settle(await modules.page({searchParams: Promise.resolve(sp)}));
  const dataDone = performance.now();
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider,
    {locale: 'en', timeZone: 'Asia/Kuala_Lumpur', messages: en} as never, tree as never));
  const table = findProps(tree, 'employees')[0] as {employees?: {employmentId: string}[]} | undefined;
  const pager = findProps(tree, 'state').map(p => p.state as {total?: number}).find(s => typeof s?.total === 'number');
  const cards = [...html.matchAll(/data-headcount="([a-z_]+)"[^>]*>[\s\S]*?tabular-nums">(\d+)</g)].map(m => [m[1], Number(m[2])]);
  return {ids: table?.employees?.map(e => e.employmentId) ?? [], total: pager?.total ?? null, cards: Object.fromEntries(cards),
    htmlBytes: html.length, renderMs: performance.now() - dataDone};
}

async function runScenario(modules: Modules, scenario: Scenario) {
  if (scenario.exportQuery) {
    const response = await modules.exportRoute(new Request('http://x/admin/personnel/export?' + scenario.exportQuery));
    expect(response.status).toBe(200);
    const text = new TextDecoder().decode(await response.arrayBuffer());
    return {ids: [], total: text.split('\n').filter(Boolean).length - 1, cards: {}, htmlBytes: text.length, renderMs: 0};
  }
  if (scenario.search) {
    const response = await modules.search(new Request('http://x/admin/personnel/search', {
      method: 'POST', headers: {Origin: 'http://x', Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({term: scenario.search, size: '25'}),
    }));
    expect(response.status).toBe(200);
    const {href} = await response.json() as {href: string};
    return {href};
  }
  return renderPage(modules, scenario.sp ?? {});
}

export type DiagnosticOptions = {size: number; evidenceName: string; budgetMs: number};

/** Seed, then measure every scenario for both roles; finish with a nested-plan pass. */
export async function runPersonnelPageDiagnostic(options: DiagnosticOptions) {
  const started = performance.now();
  const report: Record<string, unknown> = {kind: 'PERSONNEL_PAGE_READS_DIAGNOSTIC', releaseEligible: false, fictional: true,
    size: options.size, sha: process.env.AIHR_CI_HEAD ?? null};
  const save = () => {
    const dir = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
    if (dir) writeFileSync(join(dir, options.evidenceName), JSON.stringify(report, null, 1));
  };
  installTracer();
  const seedStarted = performance.now();
  const fixture = await seedPersonnelScaleFixture(options.size);
  try {await owner.client.unsafe('vacuum (analyze)');} catch {await owner.client.unsafe('analyze');}
  report.seedMs = Math.round(performance.now() - seedStarted);
  const modules: Modules = {
    page: (await import('../../app/admin/personnel/page')).default as Modules['page'],
    search: (await import('../../app/admin/personnel/search/route')).POST,
    exportRoute: (await import('../../app/admin/personnel/export/route')).GET,
  };
  const roles = {admin: fixture.admin, manager: fixture.manager} as const;
  const results: unknown[] = [];
  report.results = results;
  const searchHrefs: Record<string, string> = {};
  const measure = async (variant: string, only?: Set<string>) => {
  for (const [role, ctx] of Object.entries(roles)) {
    personnelDiagnosticState.session = ctx;
    for (const scenario of scenarios(fixture).filter(s => !only || only.has(s.name))) {
      if (performance.now() - started > options.budgetMs) {results.push({role, variant, scenario: scenario.name, skipped: 'budget'}); continue;}
      const runs: {ms: number; trips: number}[] = [];
      let first: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        let outcome: Awaited<ReturnType<typeof traced<Awaited<ReturnType<typeof runScenario>>>>>;
        try {outcome = await traced(() => runScenario(modules, scenario));}
        catch (error) {
          results.push({role, variant, scenario: scenario.name, attempt, error: {name: (error as Error)?.name, code: (error as {code?: string})?.code ?? null,
            message: String((error as Error)?.message ?? error).slice(0, 300)}});
          break;
        }
        runs.push({ms: Math.round(outcome.ms), trips: outcome.statements.length});
        if (attempt === 0) {
          first = {...summarize(outcome.statements), result: outcome.result};
          if ('href' in outcome.result) searchHrefs[role] = outcome.result.href;
        }
        if (outcome.ms > 8000 || (attempt === 1 && outcome.ms > 3000)) break;
      }
      const warm = runs.slice(1).map(r => r.ms).sort((a, b) => a - b);
      const row = {role, variant, scenario: scenario.name, coldMs: runs[0]?.ms, warmMs: warm.length ? warm[Math.floor((warm.length - 1) / 2)] : null, runs,
        ...(first ?? {})};
      const compact = {...row} as Record<string, unknown>;
      if (compact.result && typeof compact.result === 'object' && 'ids' in (compact.result as object)) {
        const r = compact.result as {ids: string[]};
        compact.result = {...r, ids: undefined, rowCount: r.ids.length, firstIds: r.ids.slice(0, 3)};
      }
      results.push(compact);
      print('scenario', {size: options.size, variant, role, scenario: scenario.name, coldMs: row.coldMs, warmMs: row.warmMs,
        trips: (first as {trips?: number} | undefined)?.trips, transactions: (first as {transactions?: number} | undefined)?.transactions});
      save();
    }
    // The page that the private search route redirected to.
    const href = searchHrefs[role];
    if (href && (!only || only.has('private-search')) && performance.now() - started <= options.budgetMs) {
      const params = Object.fromEntries(new URL(href, 'http://x').searchParams);
      const runs: number[] = [];let first: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        let outcome: Awaited<ReturnType<typeof traced<Awaited<ReturnType<typeof renderPage>>>>>;
        try {outcome = await traced(() => renderPage(modules, params));}
        catch (error) {first = {error: String((error as Error)?.message ?? error).slice(0, 300)}; break;}
        runs.push(Math.round(outcome.ms));
        if (attempt === 0) first = {...summarize(outcome.statements), rowCount: outcome.result.ids.length, total: outcome.result.total};
        if (outcome.ms > 3000) break;
      }
      results.push({role, variant, scenario: 'private-search-page', coldMs: runs[0], warmMs: runs.slice(1).sort((a, b) => a - b)[0] ?? null, runs, ...(first as object)});
      print('scenario', {size: options.size, variant, role, scenario: 'private-search-page', runs, trips: (first as {trips?: number} | undefined)?.trips});
      save();
    }
  }
  };
  await measure('installed');
  // The unallocated typed-facts draft, where this source carries it: the views that still use the exact
  // owner without it, measured again with it installed.
  const draftUrl = new URL('../../db/migration-drafts/personnel_overview_facts.sql', import.meta.url);
  if (existsSync(draftUrl)) {
    const {installPersonnelDraft} = await import('./personnel-scale-fixture');
    const removeDraft = await installPersonnelDraft();
    try {
      await measure('with-draft', new Set(['list', 'filter-department', 'filter-parent-company', 'filter-grade',
        'filter-quality-superior', 'sort-department', 'sort-join-date-desc', 'private-search', 'export-page', 'export-all-department']));
    } finally {
      await removeDraft();
    }
  }

  // Nested plans (auto_explain, ANALYZE + BUFFERS) for statements at or above 20 ms.
  if (performance.now() - started <= options.budgetMs + 60_000) {
    const [{db}] = await owner.client<{db: string}[]>`select current_database() as db`;
    const notices: {durationMs: number; role: string; scenario: string; plan: string}[] = [];
    let label = {role: '', scenario: ''};
    const log = console.log;
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const notice = args[0] as {message?: string} | undefined;
      if (notice && typeof notice === 'object' && typeof notice.message === 'string' && notice.message.startsWith('duration:')) {
        notices.push({durationMs: Number(/^duration: ([0-9.]+) ms/.exec(notice.message)?.[1] ?? 0), ...label, plan: notice.message.slice(0, 16000)});
        return;
      }
      log(...args);
    });
    try {
      await owner.client.unsafe(`alter role ai_hr_app in database "${db}" set session_preload_libraries='auto_explain'`);
      for (const [key, value] of [['log_min_duration', '20'], ['log_analyze', 'on'], ['log_buffers', 'on'], ['log_nested_statements', 'on'],
        ['log_level', 'notice'], ['log_timing', 'on'], ['log_format', 'text']])
        await owner.client.unsafe(`alter role ai_hr_app in database "${db}" set auto_explain.${key}='${value}'`);
      await owner.client`select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and usename='ai_hr_app' and pid<>pg_backend_pid()`;
      await new Promise(resolve => setTimeout(resolve, 200));
      for (let attempt = 0; attempt < 5; attempt++) {
        try {await withTenant(fixture.admin, tx => tx.execute(sql`select 1`)); break;} catch {await new Promise(resolve => setTimeout(resolve, 200));}
      }
      const [loaded] = await withTenant(fixture.admin, tx => tx.execute<{v: string | null}>(sql`select current_setting('auto_explain.log_min_duration',true) as v`));
      report.autoExplain = loaded?.v ?? null;
      const planned = ['list', 'filter-department', 'sort-department', 'filter-status-resigned', 'search-q-name', 'private-search', 'export-page'];
      for (const [role, ctx] of Object.entries(roles)) {
        personnelDiagnosticState.session = ctx;
        for (const scenario of scenarios(fixture).filter(s => planned.includes(s.name))) {
          label = {role, scenario: scenario.name};
          try {await runScenario(modules, scenario);} catch (error) {print('plan-error', {role, scenario: scenario.name, message: String((error as Error)?.message).slice(0, 200)});}
        }
        const href = searchHrefs[role];
        if (href) {label = {role, scenario: 'private-search-page'}; await renderPage(modules, Object.fromEntries(new URL(href, 'http://x').searchParams)).catch(() => undefined);}
      }
    } finally {
      spy.mockRestore();
      await owner.client.unsafe(`alter role ai_hr_app in database "${db}" reset all`);
      await owner.client`select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and usename='ai_hr_app' and pid<>pg_backend_pid()`;
    }
    notices.sort((a, b) => b.durationMs - a.durationMs);
    report.plans = notices.slice(0, 40);
    for (const notice of notices.slice(0, 12)) console.info(`[personnel-page-diagnostic] plan ${notice.role}/${notice.scenario} ${notice.durationMs}ms\n` + notice.plan.slice(0, 6000));
  }
  report.elapsedMs = Math.round(performance.now() - started);
  save();
  return {report, fixture};
}
