#!/usr/bin/env node
/**
 * ADR-0181 — continuous request probe for proving a release was zero-downtime.
 *
 * Runs N concurrent loops against URLs through the same front door users reach (Nginx), plus a few
 * long requests that are deliberately in flight while traffic moves, until it receives SIGTERM/SIGINT
 * or --duration elapses. Then writes a JSON summary and exits non-zero on ANY failed request: a
 * connection error, a timeout, or a status outside the accepted set. Read-only GETs only.
 *
 *   node deploy/zero-downtime/probe.mjs --base http://127.0.0.1 --path /login --path /health \
 *     [--host app.example] [--concurrency 8] [--duration 600] [--slow-path /slow?ms=20000 --slow-every 5] \
 *     [--accept 200,302,307,401] [--out probe.json]
 *
 * The summary records which deployment ids answered (Next's x-nextjs-deployment-id header or the
 * html data-dpl-id attribute), so a run also shows the switch actually happened.
 */
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

function parse(argv) {
  const o = { paths: [], concurrency: 8, duration: 0, accept: new Set([200, 204, 301, 302, 303, 307, 308, 401]), timeoutMs: 15000, slowEvery: 0, out: null, host: null, slowPath: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--base': o.base = v; i++; break;
      case '--path': o.paths.push(v); i++; break;
      case '--host': o.host = v; i++; break;
      case '--concurrency': o.concurrency = Number(v); i++; break;
      case '--duration': o.duration = Number(v); i++; break;
      case '--timeout-ms': o.timeoutMs = Number(v); i++; break;
      case '--accept': o.accept = new Set(v.split(',').map(Number)); i++; break;
      case '--slow-path': o.slowPath = v; i++; break;
      case '--slow-every': o.slowEvery = Number(v); i++; break;
      case '--out': o.out = v; i++; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!o.base || !o.paths.length) throw new Error('--base and at least one --path are required');
  return o;
}

const o = parse(process.argv.slice(2));
let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const stats = { started: new Date().toISOString(), requests: 0, ok: 0, failures: [], byStatus: {}, deployments: {}, slow: { started: 0, ok: 0 }, maxLatencyMs: 0, latencies: [] };

async function once(path, timeoutMs) {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(o.base + path, { redirect: 'manual', signal: ctl.signal, headers: o.host ? { host: o.host } : {} });
    const body = await res.text();
    const ms = performance.now() - t0;
    const id = res.headers.get('x-nextjs-deployment-id') || /<html[^>]*data-dpl-id="([A-Za-z0-9_-]+)"/.exec(body)?.[1] || null;
    return { status: res.status, ms, id };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, error: e.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : String(e.cause?.code || e.message) };
  } finally {
    clearTimeout(timer);
  }
}

function record(path, r) {
  stats.requests++;
  stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1;
  if (r.id) stats.deployments[r.id] = (stats.deployments[r.id] || 0) + 1;
  stats.maxLatencyMs = Math.max(stats.maxLatencyMs, Math.round(r.ms));
  if (stats.latencies.length < 200000) stats.latencies.push(r.ms);
  if (r.status && o.accept.has(r.status)) stats.ok++;
  else stats.failures.push({ at: new Date().toISOString(), path, status: r.status, error: r.error || null, ms: Math.round(r.ms) });
}

async function loop(k) {
  let n = 0;
  while (!stopping) {
    const path = o.paths[(k + n++) % o.paths.length];
    record(path, await once(path, o.timeoutMs));
  }
}

async function slowLoop() {
  // Long requests overlapping the switch and the drain: they must complete, not be cut off.
  while (!stopping) {
    stats.slow.started++;
    const r = await once(o.slowPath, 120000);
    record(o.slowPath, r);
    if (r.status && o.accept.has(r.status)) stats.slow.ok++;
    for (let i = 0; i < o.slowEvery * 10 && !stopping; i++) await sleep(100);
  }
}

const deadline = o.duration > 0 ? setTimeout(stop, o.duration * 1000) : null;
await Promise.all([...Array.from({ length: o.concurrency }, (_, k) => loop(k)), ...(o.slowPath ? [slowLoop()] : [])]);
if (deadline) clearTimeout(deadline);

const sorted = stats.latencies.sort((a, b) => a - b);
const pct = (p) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]) : null);
const summary = { ...stats, latencies: undefined, ended: new Date().toISOString(), p50Ms: pct(0.5), p99Ms: pct(0.99), failed: stats.failures.length, failures: stats.failures.slice(0, 50) };
const text = JSON.stringify(summary, null, 2);
if (o.out) fs.writeFileSync(o.out, text);
console.log(text);
process.exitCode = summary.failed === 0 && summary.requests > 0 ? 0 : 1;
