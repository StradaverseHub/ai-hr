import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';

describe('scheduled review CLI startup',()=>{
 it('loads the real plain-Node dependency graph before validating its missing maintenance connection',()=>{
  const result=spawnSync(process.execPath,['--import','tsx','scripts/review-sweep.ts'],{
   cwd:process.cwd(),encoding:'utf8',timeout:20_000,
   env:{...process.env,NODE_OPTIONS:'',DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database',MIGRATION_DATABASE_URL:'',AUTH_PROVIDER:'internal'},
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('review:sweep requires MIGRATION_DATABASE_URL');
  expect(result.stderr).not.toContain('Client Component');
  expect(result.stderr).not.toContain('createContext is not a function');
 },25_000);
 it('loads independent provisioning without entering the combined holiday/report CLI',()=>{
  const result=spawnSync(process.execPath,['--import','tsx','scripts/provision-only-runner.ts'],{
   cwd:process.cwd(),encoding:'utf8',timeout:20_000,
   env:{...process.env,NODE_OPTIONS:'',DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database',MIGRATION_DATABASE_URL:'',AUTH_PROVIDER:'internal'},
  });
  expect(result.error).toBeUndefined();expect(result.status).toBe(1);
  expect(result.stderr).toContain('Provisioning-only tick failed; check its protected maintenance logs.');
  expect(result.stderr).not.toContain('Replacement holiday tick');expect(result.stderr).not.toContain('Employee master report tick');
 },25_000);

});
