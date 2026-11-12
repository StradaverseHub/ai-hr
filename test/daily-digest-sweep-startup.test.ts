/** The morning summary worker (scripts/daily-digest-sweep.ts, started by the nightly review sweep) respawns itself under
 * the server runtime and loads the digest's module graph only there; the review sweep itself never imports that graph. */
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';

describe('morning summary worker startup',()=>{
 it('respawns under the server runtime and loads its graph there before validating its missing maintenance connection',()=>{
  const source=readFileSync('scripts/daily-digest-sweep.ts','utf8');
  const runtime=[...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map(match=>match[1]);
  expect(runtime).toEqual(['node:child_process']);
  expect(source).toContain("import('../core/digest/run')");
  const result=spawnSync(process.execPath,['--import','tsx','scripts/daily-digest-sweep.ts'],{
   cwd:process.cwd(),encoding:'utf8',timeout:20_000,
   env:{...process.env,NODE_OPTIONS:'',DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database',MIGRATION_DATABASE_URL:'',AUTH_PROVIDER:'internal'},
  });
  expect(result.error).toBeUndefined();expect(result.status).toBe(1);
  expect(result.stderr).toContain('daily-digest:sweep requires MIGRATION_DATABASE_URL');
  expect(result.stderr).not.toContain('server runtime unavailable');
  expect(result.stderr).not.toContain('Client Component');
 },25_000);
 it('is started by the review sweep, which does not import the digest graph itself',()=>{
  const source=readFileSync('scripts/review-sweep.ts','utf8');
  expect(source).toContain("new URL('./daily-digest-sweep.ts', import.meta.url)");
  expect(source).toContain("'--conditions=react-server'");
  expect(source).not.toMatch(/from '\.\.\/core\/digest\//);
 });
});
