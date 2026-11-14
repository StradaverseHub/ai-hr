/** Dead-peer detection options for worker-role connections (db/worker-connection.ts): the exact server parameters
 * and client keepalive, detection well inside the import worker's stall watchdog, and nothing for the web.
 * The real connections are checked against PostgreSQL in test/worker-connection-db.test.ts. */
import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {
 WORKER_CLIENT_KEEPALIVE_SECONDS,WORKER_SERVER_SESSION_PARAMETERS,openImportWorkerOwner,processConnectionOptions,workerServerDeadClientSeconds,
} from '../db/worker-connection';
import {IMPORT_WORKER_STALL_MIN_SECONDS} from '../lib/import-worker-watchdog';

describe('worker connection options',()=>{
 it('gives a worker the server keepalive, user timeout and connection check, and pins the client keepalive',()=>{
  expect(processConnectionOptions('worker')).toEqual({
   keep_alive:60,
   connection:{tcp_keepalives_idle:60,tcp_keepalives_interval:15,tcp_keepalives_count:8,tcp_user_timeout:180_000,client_connection_check_interval:10_000},
  });
  expect(WORKER_CLIENT_KEEPALIVE_SECONDS).toBe(60);
 });

 it('returns a fresh copy, so a caller cannot change the shared parameters',()=>{
  const first=processConnectionOptions('worker');
  first.connection!.tcp_keepalives_idle=7200;
  expect(processConnectionOptions('worker').connection!.tcp_keepalives_idle).toBe(60);
  expect(Object.isFrozen(WORKER_SERVER_SESSION_PARAMETERS)).toBe(true);
 });

 it('leaves the web on the driver defaults',()=>{
  expect(processConnectionOptions('web')).toEqual({});
 });

 it('ends a silently dead client within about 3 minutes, far inside the stall watchdog minimum',()=>{
  // 60 s idle + 8 probes x 15 s = 180 s; tcp_user_timeout 180 s; plus one 10 s connection check.
  expect(workerServerDeadClientSeconds()).toBe(190);
  expect(workerServerDeadClientSeconds()*4).toBeLessThan(IMPORT_WORKER_STALL_MIN_SECONDS);
  // The client's own detection (60 s idle, then the Linux default 9 probes x 75 s) also ends inside the minimum.
  expect(WORKER_CLIENT_KEEPALIVE_SECONDS+9*75).toBeLessThan(IMPORT_WORKER_STALL_MIN_SECONDS);
 });

 it('builds the owner connection with one connection and the worker settings, without connecting',()=>{
  const owner=openImportWorkerOwner('postgres://nobody:nothing@127.0.0.1:1/no_database');
  expect(owner.options.max).toBe(1);
  expect(owner.options.keep_alive).toBe(60);
  expect(owner.options.connection).toMatchObject(WORKER_SERVER_SESSION_PARAMETERS);
 });

 it('is the only way the import worker opens its owner connection',()=>{
  const runner=readFileSync('scripts/bank-import-runner.ts','utf8');
  expect(runner).toContain('const owner=openImportWorkerOwner(url);');
  expect(runner).not.toMatch(/\bpostgres\(/);
  const client=readFileSync('db/client.ts','utf8');
  expect(client).toContain('...processConnectionOptions(applicationBudget.role)');
 });
});
