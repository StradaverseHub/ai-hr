#!/usr/bin/env node
/**
 * Slow-work report: which screens, actions and background jobs take a second or more, and where their time goes
 * (docs/PERFORMANCE-TIMING.md).
 *
 *   journalctl -u aihr --since "7 days ago" -o cat | node scripts/performance/slow-work-report.mjs
 *   node scripts/performance/slow-work-report.mjs --logs app.log --jobs-since "14 days" > report.md
 *
 * Reads `[aihr-timing]` lines (lib/request-timing.ts) from --logs or stdin. With JOBS_DATABASE_URL set (the owner role,
 * read only), it also summarises finished background jobs from bulk_job. Everything it prints is aggregate: route
 * shapes, action names, job kinds and durations. It never reads tenants, people or values.
 */
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const PREFIX = '[aihr-timing] ';

/** Merge `window` lines by route and collect `slow` and `process` lines. Lines that do not parse are skipped. */
export function collect(lines) {
  const rows = new Map(), slow = [], processes = [];
  let bucketsMs = null;
  for (const line of lines) {
    const at = line.indexOf(PREFIX);
    if (at === -1) continue;
    let record;
    try {record = JSON.parse(line.slice(at + PREFIX.length));} catch {continue;}
    if (record.t === 'slow') slow.push(record);
    else if (record.t === 'process') processes.push(record);
    else if (record.t === 'window' && Array.isArray(record.buckets)) {
      bucketsMs ??= record.bucketsMs;
      const key = JSON.stringify([record.kind, record.method, record.route, record.action ?? '']);
      const row = rows.get(key) ?? {kind: record.kind, method: record.method, route: record.route, action: record.action, count: 0,
        buckets: new Array(record.buckets.length).fill(0), totalMs: 0, maxMs: 0, dbMs: 0, dbWaitMs: 0, transactions: 0, errors: 0};
      row.count += record.count; row.totalMs += record.totalMs; row.maxMs = Math.max(row.maxMs, record.maxMs);
      row.dbMs += record.dbMs; row.dbWaitMs += record.dbWaitMs; row.transactions += record.transactions; row.errors += record.errors;
      record.buckets.forEach((n, i) => {row.buckets[i] += n;});
      rows.set(key, row);
    }
  }
  return {rows: [...rows.values()], slow, processes, bucketsMs: bucketsMs ?? [100, 250, 500, 1000, 2000, 5000, 10000, 30000]};
}

/** Requests at or above thresholdMs: exact when thresholdMs is a bucket boundary. */
export function overThreshold(row, bucketsMs, thresholdMs) {
  const from = bucketsMs.indexOf(thresholdMs);
  if (from === -1) throw new RangeError(`Threshold ${thresholdMs} ms is not a bucket boundary (${bucketsMs.join(', ')}).`);
  return row.buckets.slice(from + 1).reduce((a, b) => a + b, 0);
}

/** The upper bound of the bucket holding the p-th percentile ("at most"); null for the open last bucket. */
export function percentileAtMost(row, bucketsMs, p) {
  const target = Math.ceil(row.count * p);
  let seen = 0;
  for (let i = 0; i < row.buckets.length; i++) {
    seen += row.buckets[i];
    if (seen >= target) return i < bucketsMs.length ? bucketsMs[i] : null;
  }
  return null;
}

/** Where the time goes, and what kind of fix that points to. Shares are of total wall time. */
export function diagnose({totalMs, dbMs, dbWaitMs}) {
  if (!totalMs) return {db: 0, wait: 0, app: 0, hint: 'no data'};
  const db = dbMs / totalMs, wait = dbWaitMs / totalMs, app = Math.max(0, 1 - db - wait);
  const hint = wait >= 0.3 ? 'waiting for a database slot: capacity or another job holding connections'
    : db >= 0.6 ? 'database work: query count, indexes or row-security plans (Rust would not help)'
    : app >= 0.6 ? 'application code or rendering: profile it; caching or a Rust port of the hot loop may help'
    : 'mixed: profile one request';
  return {db, wait, app, hint};
}

const seconds = (ms) => ms == null ? 'over 30 s' : ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s` : `${Math.round(ms)} ms`;
const pct = (x) => `${Math.round(x * 100)}%`;
const label = (row) => row.action ? `${row.action} (on ${row.route})` : `${row.method === 'GET' ? '' : row.method + ' '}${row.route}`;
const KIND_TITLES = {page: 'Screens: full page loads', navigation: 'Screens: in-app navigation', action: 'Actions: buttons and forms', api: 'API calls and downloads'};

export function renderRequests({rows, slow, processes, bucketsMs}, thresholdMs = 1000) {
  const out = [];
  for (const kind of ['page', 'navigation', 'action', 'api']) {
    const ranked = rows.filter((r) => r.kind === kind).map((r) => ({...r, over: overThreshold(r, bucketsMs, thresholdMs)}))
      .filter((r) => r.over > 0).sort((a, b) => b.over * (b.totalMs / b.count) - a.over * (a.totalMs / a.count));
    out.push(`## ${KIND_TITLES[kind]} taking ${seconds(thresholdMs)} or more`, '');
    if (!ranked.length) {out.push(`None of the ${rows.filter((r) => r.kind === kind).length} measured routes reached ${seconds(thresholdMs)}.`, ''); continue;}
    out.push('| What | Requests | ' + `${seconds(thresholdMs)}+` + ' | Median | 95th pct | Slowest | Database | Waiting for DB | App code | Likely cause |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const r of ranked) {
      const d = diagnose(r);
      out.push(`| ${label(r)} | ${r.count} | ${r.over} (${pct(r.over / r.count)}) | ≤ ${seconds(percentileAtMost(r, bucketsMs, 0.5))} | ≤ ${seconds(percentileAtMost(r, bucketsMs, 0.95))} | ${seconds(r.maxMs)} | ${pct(d.db)} | ${pct(d.wait)} | ${pct(d.app)} | ${d.hint} |`);
    }
    out.push('');
  }
  const worst = [...slow].sort((a, b) => b.ms - a.ms).slice(0, 25);
  if (worst.length) {
    out.push('## Slowest single requests', '', '| What | Kind | Status | Total | Database | Waiting for DB | App code | Transactions |', '|---|---|---:|---:|---:|---:|---:|---:|');
    for (const s of worst) out.push(`| ${label(s)} | ${s.kind} | ${s.status} | ${seconds(s.ms)} | ${seconds(s.dbMs)} | ${seconds(s.dbWaitMs)} | ${seconds(s.appMs)} | ${s.transactions} |`);
    out.push('');
  }
  if (processes.length) {
    const p99 = Math.max(...processes.map((p) => p.eventLoopP99Ms)), max = Math.max(...processes.map((p) => p.eventLoopMaxMs));
    out.push('## Web process', '', `Worst 5-minute event-loop delay: 99th percentile ${seconds(p99)}, longest single block ${seconds(max)}. ` +
      'A long block means one piece of synchronous code held every other user\'s request while it ran.', '');
  }
  return out.join('\n');
}

/** Finished background jobs per kind (payroll processing, reprocessing, imports), owner role, read only. */
export async function jobSummary(databaseUrl, since = '14 days') {
  const {default: postgres} = await import('postgres');
  const sql = postgres(databaseUrl, {max: 1, onnotice: () => {}});
  const num = (key) => `avg(case when metrics->>'${key}' ~ '^[0-9]+(\\.[0-9]+)?$' then (metrics->>'${key}')::numeric end)`;
  try {
    return await sql.begin('read only', (tx) => tx.unsafe(`
      select kind, count(*)::int as jobs, count(*) filter (where outcome is not null)::int as unsuccessful,
        percentile_cont(0.5) within group (order by extract(epoch from finished_at - created_at) * 1000) as p50_ms,
        percentile_cont(0.95) within group (order by extract(epoch from finished_at - created_at) * 1000) as p95_ms,
        max(extract(epoch from finished_at - created_at) * 1000) as max_ms,
        ${num('queuedMs')} as queued_ms, ${num('workMs')} as work_ms, ${num('maxChunkMs')} as max_chunk_ms,
        avg(steps_total) as steps
      from bulk_job where finished_at is not null and finished_at >= now() - $1::interval
      group by kind order by p95_ms desc`, [since]));
  } finally {await sql.end({timeout: 5});}
}

export function renderJobs(rows, thresholdMs = 1000) {
  const out = ['## Background jobs (payroll processing, reprocessing, imports)', '',
    'Total is creation to finish: what the person who pressed the button waited. Queued is the wait before a worker picked the job up; working is the time a worker spent on it. The rest is time between its chunks, while other tenants\' jobs ran.', ''];
  const slowRows = rows.filter((r) => Number(r.p95_ms) >= thresholdMs);
  if (!slowRows.length) return [...out, `No job kind reached ${seconds(thresholdMs)} at the 95th percentile.`, ''].join('\n');
  out.push('| Job kind | Jobs | Failed or cancelled | Median total | 95th pct total | Slowest | Avg queued | Avg working | Avg steps | Longest chunk |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const opt = (v) => v == null ? 'not recorded yet' : seconds(Number(v));
  for (const r of slowRows) out.push(`| ${r.kind} | ${r.jobs} | ${r.unsuccessful} | ${seconds(Number(r.p50_ms))} | ${seconds(Number(r.p95_ms))} | ${seconds(Number(r.max_ms))} | ${opt(r.queued_ms)} | ${opt(r.work_ms)} | ${r.steps == null ? '' : Math.round(Number(r.steps))} | ${opt(r.max_chunk_ms)} |`);
  out.push('');
  return out.join('\n');
}

async function main(argv) {
  const arg = (name) => {const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1];};
  const thresholdMs = Number(arg('--threshold-ms') ?? 1000);
  const logs = arg('--logs');
  const lines = [];
  if (logs || !process.stdin.isTTY) {
    const input = createInterface({input: logs ? createReadStream(logs) : process.stdin, crlfDelay: Infinity});
    for await (const line of input) if (line.includes(PREFIX)) lines.push(line);
  }
  const collected = collect(lines);
  const parts = [`# Slow work report`, '', `Threshold ${seconds(thresholdMs)}. ${collected.rows.reduce((a, r) => a + r.count, 0)} requests over ${collected.rows.length} routes; ${collected.slow.length} slow requests logged.`, '',
    renderRequests(collected, thresholdMs)];
  if (process.env.JOBS_DATABASE_URL) parts.push(renderJobs(await jobSummary(process.env.JOBS_DATABASE_URL, arg('--jobs-since') ?? '14 days'), thresholdMs));
  else parts.push('_Background jobs not included: set JOBS_DATABASE_URL (owner role) to add them._', '');
  process.stdout.write(parts.join('\n') + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {console.error(error instanceof Error ? error.message : error); process.exit(1);});
}
