/** Live timing of screens, actions and background jobs (docs/PERFORMANCE-TIMING.md). No database: the database hooks
 * of db/client.ts are driven directly with known delays, so the split into database / waiting / app time has
 * independent expected values. */
import http from 'node:http';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {classifyRequest, createActionNamer, installRequestTiming, normalizeRoute, RequestClock, TimingWindow, TIMING_BUCKETS_MS, type RequestTimingHandle} from '../lib/request-timing';
import {recordUnitTiming} from '../lib/bulk-job-timing';
import {collect, diagnose, overThreshold, percentileAtMost, renderJobs, renderRequests} from '../scripts/performance/slow-work-report.mjs';

type Hook = (poolMax?: number) => {acquired: () => void; finished: () => void} | undefined;
const hooks = globalThis as typeof globalThis & {__aihrPerfBeginTransaction?: Hook; __aihrPerfBeginPoolWork?: Hook; __aihrPerfBeginBackgroundRead?: Hook};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (lines: string[], t: string) => lines.filter((l) => l.startsWith('[aihr-timing] ')).map((l) => JSON.parse(l.slice(14))).filter((r) => r.t === t);

describe('route shapes carry no identities', () => {
  it.each([
    ['/admin/personnel/0b0f4f5e-6a55-4d55-9a3c-1c2d3e4f5a6b/profile?tab=pay', '/admin/personnel/[id]/profile'],
    ['/payroll/runs/123/payslips', '/payroll/runs/[n]/payslips'],
    ['/payroll/2026-06/register', '/payroll/[date]/register'],
    ['/invite/aB3dE5fG7hJ9kL1mN3pQ', '/invite/[token]'],
    ['/search/jane%40example.com', '/search/[value]'],
    ['/people/jane@example.com', '/people/[value]'],
    ['/payroll/formula-builder/new', '/payroll/formula-builder/new'],
    ['/', '/'],
    ['?x=1', '/'],
  ])('%s → %s', (url, shape) => expect(normalizeRoute(url)).toBe(shape));
});

describe('request kinds', () => {
  it('separates page loads, navigations, actions and API calls, and skips non-user work', () => {
    expect(classifyRequest('GET', '/payroll', {})).toBe('page');
    expect(classifyRequest('GET', '/payroll?_rsc=1', {rsc: '1'})).toBe('navigation');
    expect(classifyRequest('POST', '/payroll', {'next-action': 'abc'})).toBe('action');
    expect(classifyRequest('POST', '/api/attendance/clock', {})).toBe('api');
    expect(classifyRequest('GET', '/payroll', {rsc: '1', 'next-router-prefetch': '1'})).toBeNull();
    expect(classifyRequest('GET', '/_next/static/chunks/a.js', {})).toBeNull();
    expect(classifyRequest('GET', '/logo.svg', {})).toBeNull();
    expect(classifyRequest('GET', '/health', {})).toBeNull();
  });

  it('names server actions from the build manifest and keeps a short id otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timing-'));
    const manifest = join(dir, 'server-reference-manifest.json');
    writeFileSync(manifest, JSON.stringify({node: {
      '7f00aa': {filename: 'app/payroll/actions.ts', exportedName: 'processPayrollRun'},
      '7f00bb': {filename: 'app/payroll/page.tsx', exportedName: '$$RSC_SERVER_ACTION_0'},
    }, edge: {}}));
    const name = createActionNamer(manifest);
    expect(name('7f00aa')).toBe('app/payroll/actions.ts#processPayrollRun');
    expect(name('7f00bb')).toBe('app/payroll/page.tsx#inline');
    expect(name('0123456789abcdef0123')).toBe('action:0123456789ab');
    expect(createActionNamer(join(dir, 'missing.json'))('7f00aa')).toBe('action:7f00aa');
  });
});

describe('the per-request clock', () => {
  afterEach(() => vi.restoreAllMocks());
  it('counts overlapping transactions once and waiting only while nothing is held', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const clock = new RequestClock();
    now = 10; const a = clock.begin();         // 10–15 waiting
    now = 15; a.acquired();                    // 15–40 held (a)
    now = 20; const b = clock.begin();         // b waits while a is held: not waiting time
    now = 30; b.acquired();                    // a and b overlap 30–40
    now = 40; a.finished();
    now = 50; b.finished();                    // held until 50
    now = 60; const r = clock.begin(true);     // background-read admission: wait 60–70, hold ignored
    now = 70; r.acquired();
    now = 90; r.finished();
    now = 100; const failed = clock.begin();   // refused admission: waited 100–110, never held
    now = 110; failed.finished();
    now = 120;
    expect(clock.finish()).toEqual({ms: 120, dbMs: 35, dbWaitMs: 25});
    expect(clock.transactions).toBe(2);
  });
});

describe('window buckets', () => {
  it('puts exactly-one-second requests in the over-a-second count and bounds the number of routes', () => {
    const w = new TimingWindow();
    const base = {kind: 'page' as const, method: 'GET', status: 200, dbMs: 0, dbWaitMs: 0, transactions: 0};
    w.add({...base, route: '/a', ms: 999});
    w.add({...base, route: '/a', ms: 1000});
    w.add({...base, route: '/a', ms: 45000, status: 500});
    const [row] = w.drain();
    expect(row.count).toBe(3);
    expect(row.errors).toBe(1);
    expect(overThreshold(row, TIMING_BUCKETS_MS, 1000)).toBe(2);
    expect(percentileAtMost(row, TIMING_BUCKETS_MS, 0.5)).toBe(2000);
    expect(percentileAtMost(row, TIMING_BUCKETS_MS, 0.95)).toBeNull();
    for (let i = 0; i < 700; i++) w.add({...base, route: `/r${i}`, ms: 5});
    const rows = w.drain();
    expect(rows.length).toBe(601);
    expect(rows.find((r) => r.route === '[other]')?.count).toBe(100);
  });
});

describe('live HTTP timing', () => {
  let handle: RequestTimingHandle | undefined;
  let server: http.Server | undefined;
  afterEach(async () => {
    handle?.stop(); handle = undefined;
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()); server = undefined;
    delete hooks.__aihrPerfBeginTransaction;
  });

  it('splits each request into database, waiting and app time, per request, under concurrency', async () => {
    const outer: string[] = [];
    hooks.__aihrPerfBeginTransaction = () => ({acquired: () => outer.push('acquired'), finished: () => outer.push('finished')});
    const lines: string[] = [];
    handle = installRequestTiming({slowMs: 100, windowSeconds: 3600, write: (line) => lines.push(line), actionName: (id) => `named:${id}`});
    server = http.createServer(async (req, res) => {
      const wait = Number(req.headers['x-wait']), hold = Number(req.headers['x-hold']), app = Number(req.headers['x-app']);
      const tx = hooks.__aihrPerfBeginTransaction?.(10);
      await sleep(wait); tx?.acquired();
      await sleep(hold); tx?.finished();
      await sleep(app);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port: number}).port;
    const agent = new http.Agent({keepAlive: true, maxSockets: 2});
    const send = (path: string, headers: Record<string, string>, method = 'GET') => new Promise<void>((resolve, reject) => {
      const req = http.request({port, host: '127.0.0.1', path, method, agent, headers}, (res) => {res.resume(); res.on('end', resolve);});
      req.on('error', reject); req.end();
    });
    await Promise.all([
      send('/payroll/runs/42', {'x-wait': '40', 'x-hold': '150', 'x-app': '20', 'next-action': 'p1'}, 'POST'),
      send('/admin/personnel', {'x-wait': '0', 'x-hold': '10', 'x-app': '150'}),
      send('/payroll', {'x-wait': '0', 'x-hold': '0', 'x-app': '0', rsc: '1', 'next-router-prefetch': '1'}),
      send('/admin/personnel', {'x-wait': '0', 'x-hold': '0', 'x-app': '0'}),
    ]);
    agent.destroy();
    handle.flush();

    const slow = parse(lines, 'slow');
    const action = slow.find((s) => s.kind === 'action');
    expect(action).toMatchObject({method: 'POST', route: '/payroll/runs/[n]', action: 'named:p1', status: 200, transactions: 1});
    expect(action.dbWaitMs).toBeGreaterThanOrEqual(35); expect(action.dbWaitMs).toBeLessThan(120);
    expect(action.dbMs).toBeGreaterThanOrEqual(140); expect(action.dbMs).toBeLessThan(260);
    expect(action.appMs).toBeLessThan(120);
    const page = slow.find((s) => s.kind === 'page');
    expect(page).toMatchObject({route: '/admin/personnel', transactions: 1});
    expect(page.appMs).toBeGreaterThanOrEqual(140);
    expect(page.dbMs).toBeLessThan(80);
    expect(slow).toHaveLength(2);

    const windows = parse(lines, 'window');
    expect(windows.map((w) => [w.kind, w.route, w.count]).sort()).toEqual([['action', '/payroll/runs/[n]', 1], ['page', '/admin/personnel', 2]]);
    expect(parse(lines, 'process')).toHaveLength(1);
    // The isolated-run hooks that were installed first still see every transaction.
    expect(outer.filter((e) => e === 'acquired')).toHaveLength(4);
    // Nothing identifying leaves the process: no raw ids, query strings or header values.
    expect(lines.join('\n')).not.toMatch(/\/42\b|x-wait|_rsc/);
  });

  it('restores the hooks it chained when stopped', () => {
    const original: Hook = () => undefined;
    hooks.__aihrPerfBeginTransaction = original;
    handle = installRequestTiming({write: () => undefined});
    expect(hooks.__aihrPerfBeginTransaction).not.toBe(original);
    handle.stop(); handle = undefined;
    expect(hooks.__aihrPerfBeginTransaction).toBe(original);
  });
});

describe('background job timing', () => {
  it('records queue wait once and keeps growing totals of working time and units', () => {
    const created = new Date('2026-11-23T01:00:00Z');
    const metrics: Record<string, number> = {};
    recordUnitTiming({state: 'queued', created_at: created, metrics: {}}, metrics, 200, created.getTime() + 5200);
    expect(metrics).toEqual({workMs: 200, units: 1, queuedMs: 5000});
    const next: Record<string, number> = {};
    recordUnitTiming({state: 'running', created_at: created, metrics: {...metrics, maxChunkMs: 90}}, next, 120.4, created.getTime() + 9000);
    expect(next).toEqual({workMs: 320, units: 2});
    const notice: Record<string, number> = {};
    recordUnitTiming({state: 'completed', created_at: created, metrics}, notice, 50);
    expect(notice).toEqual({});
  });
});

describe('slow-work report', () => {
  const window = (route: string, buckets: number[], extra: Record<string, unknown> = {}) => `Nov 23 host node[1]: [aihr-timing] ${JSON.stringify({t: 'window', kind: 'page', method: 'GET', route,
    bucketsMs: TIMING_BUCKETS_MS, count: buckets.reduce((a, b) => a + b, 0), buckets, totalMs: 0, maxMs: 0, dbMs: 0, dbWaitMs: 0, transactions: 0, errors: 0, ...extra})}`;

  it('merges windows from several processes and ranks only routes with requests of a second or more', () => {
    const data = collect([
      window('/payroll', [0, 0, 0, 2, 1, 1, 0, 0, 0], {totalMs: 9000, maxMs: 4200, dbMs: 7200, dbWaitMs: 300}),
      window('/payroll', [0, 0, 0, 1, 1, 0, 0, 0, 0], {totalMs: 2500, maxMs: 1600, dbMs: 2000, dbWaitMs: 0}),
      window('/me', [5, 0, 0, 0, 0, 0, 0, 0, 0], {totalMs: 200}),
      'unrelated line',
      '[aihr-timing] {not json',
    ]);
    expect(data.rows).toHaveLength(2);
    const payroll = data.rows.find((r: {route: string}) => r.route === '/payroll');
    expect(payroll.count).toBe(6);
    expect(overThreshold(payroll, data.bucketsMs, 1000)).toBe(3);
    const text = renderRequests(data, 1000);
    expect(text).toContain('| /payroll | 6 | 3 (50%)');
    expect(text).toContain('database work');
    expect(text).not.toContain('| /me |');
    expect(() => overThreshold(payroll, data.bucketsMs, 1500)).toThrow(RangeError);
  });

  it('points app-heavy work at profiling, database-heavy work at queries, and waiting at capacity', () => {
    expect(diagnose({totalMs: 1000, dbMs: 100, dbWaitMs: 0}).hint).toMatch(/application code/);
    expect(diagnose({totalMs: 1000, dbMs: 700, dbWaitMs: 0}).hint).toMatch(/Rust would not help/);
    expect(diagnose({totalMs: 1000, dbMs: 200, dbWaitMs: 400}).hint).toMatch(/database slot/);
  });

  it('lists slow job kinds with what is and is not recorded yet', () => {
    const text = renderJobs([
      {kind: 'payroll_process', jobs: 4, unsuccessful: 0, p50_ms: 42000, p95_ms: 95000, max_ms: 101000, queued_ms: 1500, work_ms: 30000, max_chunk_ms: 110, steps: 3000},
      {kind: 'payroll_reprocess', jobs: 2, unsuccessful: 1, p50_ms: 8000, p95_ms: 9000, max_ms: 9100, queued_ms: null, work_ms: null, max_chunk_ms: null, steps: 12},
      {kind: 'leave_recalc', jobs: 9, unsuccessful: 0, p50_ms: 300, p95_ms: 700, max_ms: 800, queued_ms: 100, work_ms: 200, max_chunk_ms: 50, steps: 1},
    ]);
    expect(text).toContain('| payroll_process | 4 | 0 | 42 s | 95 s | 101 s | 1.5 s | 30 s | 3000 | 110 ms |');
    expect(text).toContain('| payroll_reprocess | 2 | 1 | 8 s | 9 s | 9.1 s | not recorded yet | not recorded yet |');
    expect(text).not.toContain('leave_recalc');
  });
});
