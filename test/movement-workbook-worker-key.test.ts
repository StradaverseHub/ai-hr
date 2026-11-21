/**
 * Movement "Check file" runs in the import worker (aihr-bank-import), not the web process. Production on
 * 13 Nov 2026 had the workbook key only in the web environment, so every Movement Excel check failed with
 * workbook_key_unavailable. The worker installer must carry the key over, and the worker must be able to
 * tell at startup whether it has one. Synthetic key material only.
 */
import {spawnSync} from 'node:child_process';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {movementWorkbookKeyReady} from '../lib/movement-workbook-metadata.server';

afterEach(()=>{vi.unstubAllEnvs();});

describe('movement workbook key in the import worker',()=>{
 it('reports ready only for a valid key and id',()=>{
  vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY','');vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','');
  expect(movementWorkbookKeyReady()).toBe(false);
  vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY',Buffer.alloc(32,3).toString('base64url'));
  expect(movementWorkbookKeyReady()).toBe(false);
  vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','public-fixture-only');
  expect(movementWorkbookKeyReady()).toBe(true);
  vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY',Buffer.alloc(31,3).toString('base64url'));
  expect(movementWorkbookKeyReady()).toBe(false);
 });

 it('lets the reviewed worker installer copy both workbook key settings into the worker environment',()=>{
  const code="import importlib.util,json,sys;s=importlib.util.spec_from_file_location('v2',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(sorted(m.ENV_KEYS)))";
  const result=spawnSync('python3',['-I','-B','-c',code,'deploy/systemd/bank_import_worker_installer_v2.py'],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
  const keys=JSON.parse(result.stdout) as string[];
  expect(keys).toContain('MOVEMENT_IMPORT_WORKBOOK_KEY');
  expect(keys).toContain('MOVEMENT_IMPORT_WORKBOOK_KEY_ID');
  expect(keys).toContain('DATABASE_URL');
 });
});
