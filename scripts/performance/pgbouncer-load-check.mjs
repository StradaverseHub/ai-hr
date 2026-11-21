#!/usr/bin/env node
/**
 * A focused load check for transaction pooling, on fictional rows in a scratch schema.
 *
 * Each logical client is one postgres.js connection doing what withTenant does: a transaction that sets
 * the tenant as a transaction-local GUC, reads under row-level security, and takes a transaction-scoped
 * advisory lock. It checks the isolation that matters on every transaction, and reports latency and the
 * real server connection count sampled from pg_stat_activity.
 *
 *   node scripts/performance/pgbouncer-load-check.mjs \
 *     --app-url postgres://ai_hr_app:...@127.0.0.1:6432/ai_hr_pgb \
 *     --owner-url postgres://postgres:...@127.0.0.1:5432/ai_hr_pgb \
 *     --clients 500 --transactions 20 --prepare false --label pooled
 *
 * Run it against a disposable target only: it creates and drops the schema pgb_load.
 */
import {performance} from 'node:perf_hooks';
import postgres from 'postgres';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const appUrl = argument('app-url');
const ownerUrl = argument('owner-url');
const clients = Number(argument('clients', '100'));
const transactions = Number(argument('transactions', '10'));
const prepare = argument('prepare', 'false') === 'true';
const tenantCount = Number(argument('tenants', '8'));
const label = argument('label', 'run');
// Clients spread their connections over rampMs and idle for about thinkMs between transactions.
const rampMs = Number(argument('ramp-ms', '0'));
const thinkMs = Number(argument('think-ms', '0'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SCHEMA = 'pgb_load';
const tenants = Array.from({length: tenantCount}, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(2));
}

const owner = postgres(ownerUrl, {max: 2, onnotice: () => {}});

async function prepareFixture() {
  await owner.unsafe(`create schema if not exists ${SCHEMA}`);
  await owner.unsafe(`create table if not exists ${SCHEMA}.rls_probe (tenant_id uuid not null, label text not null)`);
  await owner.unsafe(`alter table ${SCHEMA}.rls_probe enable row level security`);
  await owner.unsafe(`drop policy if exists tenant_isolation on ${SCHEMA}.rls_probe`);
  await owner.unsafe(`create policy tenant_isolation on ${SCHEMA}.rls_probe using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
  await owner.unsafe(`grant usage on schema ${SCHEMA} to ai_hr_app`);
  await owner.unsafe(`grant select on ${SCHEMA}.rls_probe to ai_hr_app`);
  await owner.unsafe(`truncate ${SCHEMA}.rls_probe`);
  for (const tenant of tenants) await owner.unsafe(`insert into ${SCHEMA}.rls_probe select $1::uuid, 'row-' || g from generate_series(1, 200) g`, [tenant]);
  await owner.unsafe(`analyze ${SCHEMA}.rls_probe`);
}

let peakServers = 0;
const database = new URL(ownerUrl).pathname.slice(1);
const ownerSampler = postgres(ownerUrl, {max: 1, onnotice: () => {}});
let sampling = true;
async function sample() {
  while (sampling) {
    const [row] = await ownerSampler`select count(*)::int as n from pg_stat_activity where datname = ${database} and usename = 'ai_hr_app'`;
    peakServers = Math.max(peakServers, row.n);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

const errors = new Map();
const latencies = [];
let leaks = 0;
let wrongTenant = 0;
let autocommitLeaks = 0;
let completed = 0;

function recordError(error) {
  const key = String(error?.code ?? 'no-code') + ': ' + String(error?.message ?? error).split('\n')[0].slice(0, 120);
  errors.set(key, (errors.get(key) ?? 0) + 1);
}

async function runClient(index) {
  if (rampMs) await sleep(Math.random() * rampMs);
  // No idle timeout: like the application, a client keeps its connection open between transactions.
  const sql = postgres(appUrl, {max: 1, prepare, connect_timeout: 120, onnotice: () => {}});
  try {
    for (let t = 0; t < transactions; t++) {
      if (t && thinkMs) await sleep(thinkMs * (0.5 + Math.random()));
      const tenant = tenants[(index + t) % tenants.length];
      const started = performance.now();
      try {
        await sql.begin(async tx => {
          await tx`select set_config('app.tenant_id', ${tenant}, true), set_config('app.user_id', ${'user-' + index}, true), set_config('app.roles', 'hr_admin', true)`;
          const visible = await tx`select distinct tenant_id::text as tenant from pgb_load.rls_probe`;
          if (visible.length !== 1 || visible[0].tenant !== tenant) wrongTenant++;
          await tx`select pg_advisory_xact_lock(hashtextextended(${'pgb-load:' + (index % 40)}, 0))`;
          const [guc] = await tx`select current_setting('app.tenant_id', true) as value`;
          if (guc.value !== tenant) leaks++;
          await tx`select count(*)::int as n from pgb_load.rls_probe where label like ${'row-1%'}`;
        });
        // Autocommit on the same client connection, after COMMIT: a transaction-local GUC must be gone,
        // or a pooled server connection handed to another client would still hold this tenant.
        const [after] = await sql`select coalesce(current_setting('app.tenant_id', true), '') as value`;
        if (after.value !== '') autocommitLeaks++;
        latencies.push(performance.now() - started);
        completed++;
      } catch (error) {
        recordError(error);
      }
    }
  } finally {
    await sql.end({timeout: 5}).catch(recordError);
  }
}

// postgres.js fetches array types when a connection opens, in a promise nothing handles (db/pooling.ts).
// Count that like any other failure rather than letting one timeout end the measurement.
process.on('unhandledRejection', recordError);

async function main() {
  await prepareFixture();
  const sampler = sample();
  const started = performance.now();
  await Promise.all(Array.from({length: clients}, (_, index) => runClient(index)));
  const wallMs = performance.now() - started;
  sampling = false;
  await sampler.catch(() => {});
  latencies.sort((a, b) => a - b);
  const result = {
    label, clients, transactions, prepare, tenants: tenantCount, rampMs, thinkMs,
    expected: clients * transactions, completed,
    failed: clients * transactions - completed,
    peakServerConnections: peakServers,
    wrongTenantReads: wrongTenant, gucLeaksInTransaction: leaks, gucLeaksAfterCommit: autocommitLeaks,
    latencyMs: {p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), p99: quantile(latencies, 0.99), max: latencies.length ? Number(latencies.at(-1).toFixed(2)) : null},
    throughputPerSecond: Number((completed / (wallMs / 1000)).toFixed(1)),
    wallSeconds: Number((wallMs / 1000).toFixed(1)),
    errors: Object.fromEntries(errors),
  };
  console.log(JSON.stringify(result));
  await owner.unsafe(`drop schema ${SCHEMA} cascade`);
  await ownerSampler.end({timeout: 5});
  await owner.end({timeout: 5});
  if (result.failed > 0 || wrongTenant > 0 || leaks > 0 || autocommitLeaks > 0) process.exitCode = 1;
}

main().catch(error => { recordError(error); console.error(JSON.stringify({label, fatal: Object.fromEntries(errors)})); process.exit(2); });
