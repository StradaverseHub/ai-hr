/**
 * Live timing of every screen, button action and API call the web process serves, so slow work can be found from real
 * use instead of guessed (docs/PERFORMANCE-TIMING.md).
 *
 * Installed once by instrumentation.ts. It listens on Node's HTTP diagnostics channels, so it needs no wrapper in the
 * 590 pages, 258 action modules or 355 route handlers, and it never changes a response. For each request it splits the
 * wall time into three parts that add up to the total:
 *   - dbMs:      wall time while at least one database transaction or pool unit was held;
 *   - dbWaitMs:  wall time spent waiting for a database admission permit while nothing was held;
 *   - appMs:     everything else (rendering, application code, streaming the response).
 * Time inside a transaction includes the application code that runs between its statements, so dbMs is an upper bound
 * on time spent in Postgres itself.
 *
 * Privacy: it records closed labels only. Paths are reduced to route shapes (ids and tokens replaced), query strings
 * are dropped, and no tenant, user, person, value or SQL text is ever read or written.
 *
 * Output (one JSON object per line after the `[aihr-timing]` prefix, on stdout):
 *   - `slow`: one line per request at or above AIHR_TIMING_SLOW_MS (default 1000);
 *   - `window`: every AIHR_TIMING_WINDOW_S (default 300) seconds, one line per route seen, with bucket counts that the
 *     report (scripts/performance/slow-work-report.mjs) can merge across windows and processes.
 * AIHR_TIMING=off turns it off.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';
import {readFileSync} from 'node:fs';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {join} from 'node:path';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';

export type RequestKind = 'page' | 'navigation' | 'action' | 'api';
/** Upper bounds (ms) of the histogram buckets; the last bucket is open. 1000 is a boundary, so "over 1 s" is exact. */
export const TIMING_BUCKETS_MS = Object.freeze([100, 250, 500, 1000, 2000, 5000, 10000, 30000]);
const MAX_KEYS = 600;
const PREFIX = '[aihr-timing]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\d+$/;
const DATE = /^\d{4}-\d{2}(-\d{2})?$/;
/** A long opaque segment (public links, invitation and reset tokens): mixed letters and digits, 16 or more characters. */
const TOKEN = /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_~.-]{16,}$/i;

/** The route shape of a request path: no query, no ids, no tokens, no dates, no encoded text. */
export function normalizeRoute(url: string): string {
  const path = url.split(/[?#]/, 1)[0] || '/';
  const segments = path.split('/').filter(Boolean).map((segment) => {
    if (UUID.test(segment)) return '[id]';
    if (NUMBER.test(segment)) return '[n]';
    if (DATE.test(segment)) return '[date]';
    if (segment.includes('%') || segment.includes('@')) return '[value]';
    if (TOKEN.test(segment)) return '[token]';
    return segment.length > 48 ? '[value]' : segment;
  });
  return '/' + segments.join('/');
}

type HeaderBag = Record<string, string | string[] | undefined>;
const header = (headers: HeaderBag, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** What a request is, or null for requests that are not user work (static files, prefetches, health checks). */
export function classifyRequest(method: string | undefined, url: string | undefined, headers: HeaderBag): RequestKind | null {
  if (!url || !method) return null;
  if (url.startsWith('/_next/') || url.startsWith('/favicon') || /\.(?:js|css|map|png|jpe?g|gif|svg|ico|webp|woff2?|txt|xml)(?:\?|$)/i.test(url)) return null;
  if (header(headers, 'next-router-prefetch') === '1' || header(headers, 'purpose') === 'prefetch') return null;
  if (method === 'POST' && header(headers, 'next-action')) return 'action';
  if (url === '/health' || url.startsWith('/health?')) return null;
  if (url.startsWith('/api/')) return 'api';
  if (method === 'GET' || method === 'HEAD') return header(headers, 'rsc') === '1' ? 'navigation' : 'page';
  return 'api';
}

/** Server action ids to "file#export", read once from the build's own manifest. Unknown ids keep a short id. */
export function createActionNamer(manifestPath = join(process.cwd(), '.next', 'server', 'server-reference-manifest.json')) {
  let names: Map<string, string> | null = null;
  const load = () => {
    names = new Map();
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, Record<string, {filename?: string; exportedName?: string}> | undefined>;
      for (const layer of ['node', 'edge']) {
        for (const [id, entry] of Object.entries(manifest[layer] ?? {})) {
          if (!entry?.filename) continue;
          const exported = entry.exportedName && !entry.exportedName.startsWith('$$RSC_SERVER_ACTION') ? entry.exportedName : 'inline';
          names.set(id, `${entry.filename}#${exported}`);
        }
      }
    } catch {/* No manifest (development, tests): ids stay short ids. */}
    return names;
  };
  return (id: string): string => (names ?? load()).get(id) ?? `action:${id.slice(0, 12)}`;
}

type Bucketed = {count: number; buckets: number[]; totalMs: number; maxMs: number; dbMs: number; dbWaitMs: number; transactions: number; errors: number};
export type TimingSample = {kind: RequestKind; method: string; route: string; action?: string; status: number; ms: number; dbMs: number; dbWaitMs: number; transactions: number};
export type WindowRow = {kind: RequestKind; method: string; route: string; action?: string} & Bucketed;

/** Bucketed totals per route for one window. Bounded: past MAX_KEYS distinct routes, the rest share one row. */
export class TimingWindow {
  private rows = new Map<string, WindowRow>();
  add(sample: TimingSample): void {
    let key = JSON.stringify([sample.kind, sample.method, sample.route, sample.action ?? '']);
    let row = this.rows.get(key);
    if (!row && this.rows.size >= MAX_KEYS) {
      key = JSON.stringify([sample.kind, sample.method, '[other]', '']);
      row = this.rows.get(key);
    }
    if (!row) {
      const overflow = this.rows.size >= MAX_KEYS;
      row = {kind: sample.kind, method: sample.method, route: overflow ? '[other]' : sample.route, ...(sample.action && !overflow ? {action: sample.action} : {}),
        count: 0, buckets: new Array(TIMING_BUCKETS_MS.length + 1).fill(0), totalMs: 0, maxMs: 0, dbMs: 0, dbWaitMs: 0, transactions: 0, errors: 0};
      this.rows.set(key, row);
    }
    row.count++;
    const at = TIMING_BUCKETS_MS.findIndex((limit) => sample.ms < limit);
    row.buckets[at === -1 ? TIMING_BUCKETS_MS.length : at]++;
    row.totalMs += sample.ms;
    row.maxMs = Math.max(row.maxMs, sample.ms);
    row.dbMs += sample.dbMs;
    row.dbWaitMs += sample.dbWaitMs;
    row.transactions += sample.transactions;
    if (sample.status >= 500) row.errors++;
  }
  drain(): WindowRow[] {
    const out = [...this.rows.values()].map((row) => ({...row, totalMs: Math.round(row.totalMs), maxMs: Math.round(row.maxMs), dbMs: Math.round(row.dbMs), dbWaitMs: Math.round(row.dbWaitMs)}));
    this.rows.clear();
    return out;
  }
}

/** Per-request database clock: union of held intervals, and waiting only while nothing is held. */
export class RequestClock {
  readonly started = performance.now();
  private held = 0;
  private waiting = 0;
  private since = this.started;
  dbMs = 0;
  dbWaitMs = 0;
  transactions = 0;
  private advance(now: number) {
    if (this.held > 0) this.dbMs += now - this.since;
    else if (this.waiting > 0) this.dbWaitMs += now - this.since;
    this.since = now;
  }
  /** One unit of database work; the returned callbacks match db/client.ts's timing hooks. waitOnly ignores the hold. */
  begin(waitOnly = false): {acquired: () => void; finished: () => void} {
    this.advance(performance.now());
    this.waiting++;
    let state: 'waiting' | 'held' | 'done' = 'waiting';
    return {
      acquired: () => {
        if (state !== 'waiting') return;
        this.advance(performance.now());
        this.waiting--;
        state = waitOnly ? 'done' : 'held';
        if (!waitOnly) {this.held++; this.transactions++;}
      },
      finished: () => {
        if (state === 'done') return;
        this.advance(performance.now());
        if (state === 'waiting') this.waiting--; else this.held--;
        state = 'done';
      },
    };
  }
  finish(): {ms: number; dbMs: number; dbWaitMs: number} {
    const now = performance.now();
    this.advance(now);
    return {ms: now - this.started, dbMs: this.dbMs, dbWaitMs: this.dbWaitMs};
  }
}

type Hook = (poolMax?: number) => {acquired: () => void; finished: () => void} | undefined;
type HookName = '__aihrPerfBeginTransaction' | '__aihrPerfBeginPoolWork' | '__aihrPerfBeginBackgroundRead';
export type RequestTimingHandle = {stop: () => void; flush: () => void};
type TimingGlobal = typeof globalThis & {[K in HookName]?: Hook} & {__aihrRequestTiming?: RequestTimingHandle};

export type RequestTimingOptions = {
  slowMs?: number;
  windowSeconds?: number;
  write?: (line: string) => void;
  actionName?: (id: string) => string;
};

/** Start timing this process's HTTP requests. Idempotent: a second call returns the running instance. */
export function installRequestTiming(options: RequestTimingOptions = {}): RequestTimingHandle {
  const g = globalThis as TimingGlobal;
  if (g.__aihrRequestTiming) return g.__aihrRequestTiming;
  const slowMs = options.slowMs ?? 1000;
  const write = options.write ?? ((line: string) => console.info(line));
  const actionName = options.actionName ?? createActionNamer();
  const current = new AsyncLocalStorage<RequestClock | undefined>();
  const open = new WeakMap<IncomingMessage, {clock: RequestClock; kind: RequestKind; route: string; action?: string}>();
  const window = new TimingWindow();
  const loop = monitorEventLoopDelay({resolution: 20});
  loop.enable();
  let windowStarted = Date.now();

  const emit = (record: Record<string, unknown>) => {
    try {write(`${PREFIX} ${JSON.stringify(record)}`);} catch {/* Observation must never change a response. */}
  };

  // Chain the existing optional hooks (scripts/performance/transaction-timing.mjs preloads them on isolated runs).
  const previous = new Map<HookName, Hook | undefined>();
  const chain = (name: HookName, waitOnly: boolean) => {
    const before = g[name];
    previous.set(name, before);
    g[name] = (poolMax?: number) => {
      const outer = before?.(poolMax);
      const clock = current.getStore();
      if (!clock) return outer;
      let inner: {acquired: () => void; finished: () => void} | undefined;
      try {inner = clock.begin(waitOnly);} catch {inner = undefined;}
      return {
        acquired: () => {outer?.acquired(); try {inner?.acquired();} catch {/* ignore */}},
        finished: () => {outer?.finished(); try {inner?.finished();} catch {/* ignore */}},
      };
    };
  };
  chain('__aihrPerfBeginTransaction', false);
  chain('__aihrPerfBeginPoolWork', false);
  chain('__aihrPerfBeginBackgroundRead', true);

  const onStart = (message: unknown) => {
    try {
      const {request} = message as {request: IncomingMessage};
      const kind = classifyRequest(request.method, request.url, request.headers);
      // A skipped request (static file, prefetch) must not inherit the store of an earlier request on the same socket.
      if (!kind) {current.enterWith(undefined); return;}
      const clock = new RequestClock();
      const actionId = kind === 'action' ? header(request.headers, 'next-action') : undefined;
      open.set(request, {clock, kind, route: normalizeRoute(request.url ?? '/'), ...(actionId ? {action: actionName(actionId)} : {})});
      // Published synchronously just before the server's 'request' event, so the handler and everything it awaits
      // run inside this store (verified across keep-alive and concurrent requests in test/request-timing.test.ts).
      current.enterWith(clock);
    } catch {/* ignore */}
  };
  const onFinish = (message: unknown) => {
    try {
      const {request, response} = message as {request: IncomingMessage; response: ServerResponse};
      const entry = open.get(request);
      if (!entry) return;
      open.delete(request);
      const {ms, dbMs, dbWaitMs} = entry.clock.finish();
      const sample: TimingSample = {kind: entry.kind, method: request.method ?? 'GET', route: entry.route, ...(entry.action ? {action: entry.action} : {}),
        status: response.statusCode, ms, dbMs, dbWaitMs, transactions: entry.clock.transactions};
      window.add(sample);
      if (ms >= slowMs) {
        emit({t: 'slow', kind: sample.kind, method: sample.method, route: sample.route, ...(sample.action ? {action: sample.action} : {}), status: sample.status,
          ms: Math.round(ms), dbMs: Math.round(dbMs), dbWaitMs: Math.round(dbWaitMs), appMs: Math.max(0, Math.round(ms - dbMs - dbWaitMs)), transactions: sample.transactions});
      }
    } catch {/* ignore */}
  };
  diagnosticsChannel.subscribe('http.server.request.start', onStart);
  diagnosticsChannel.subscribe('http.server.response.finish', onFinish);

  const flush = () => {
    const now = Date.now();
    const rows = window.drain();
    const eventLoopP99Ms = loop.count ? Math.round(loop.percentile(99) / 1e6) : 0;
    const eventLoopMaxMs = loop.count ? Math.round(loop.max / 1e6) : 0;
    loop.reset();
    for (const row of rows) emit({t: 'window', from: new Date(windowStarted).toISOString(), to: new Date(now).toISOString(), bucketsMs: TIMING_BUCKETS_MS, ...row});
    emit({t: 'process', from: new Date(windowStarted).toISOString(), to: new Date(now).toISOString(), eventLoopP99Ms, eventLoopMaxMs, pid: process.pid});
    windowStarted = now;
  };
  const timer = setInterval(flush, Math.max(10, options.windowSeconds ?? 300) * 1000);
  timer.unref();

  const stop = () => {
    clearInterval(timer);
    loop.disable();
    diagnosticsChannel.unsubscribe('http.server.request.start', onStart);
    diagnosticsChannel.unsubscribe('http.server.response.finish', onFinish);
    for (const [name, hook] of previous) g[name] = hook;
    delete g.__aihrRequestTiming;
  };
  const handle = {stop, flush};
  g.__aihrRequestTiming = handle;
  return handle;
}

/** Called from instrumentation.ts: reads the switches from the environment. */
export function installRequestTimingFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.AIHR_TIMING ?? '').toLowerCase() === 'off') return;
  const slowMs = Number(env.AIHR_TIMING_SLOW_MS);
  const windowSeconds = Number(env.AIHR_TIMING_WINDOW_S);
  installRequestTiming({
    ...(Number.isFinite(slowMs) && slowMs > 0 ? {slowMs} : {}),
    ...(Number.isFinite(windowSeconds) && windowSeconds > 0 ? {windowSeconds} : {}),
  });
}
