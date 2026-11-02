import {expect,it} from 'vitest';
import {performanceRoleFixtureProfile,performanceMigrationAdmin} from '../scripts/lib/performance-role-fixture';
it('keeps existing focused admission separate and names only the two real performance jobs',()=>{
 expect(performanceRoleFixtureProfile({GITHUB_JOB:'selected-tests'})).toBeUndefined();
 expect(performanceRoleFixtureProfile({AIHR_PERFORMANCE_ROLE_FIXTURE:'true',GITHUB_JOB:'system-http-browser-load'})).toEqual({evidence:'system-performance-evidence',system:true});
 expect(performanceRoleFixtureProfile({AIHR_PERFORMANCE_ROLE_FIXTURE:'true',GITHUB_JOB:'service-performance-profile'})).toEqual({evidence:'service-performance-evidence',system:false});
 for(const job of ['selected-tests','build','deploy','',undefined])expect(()=>performanceRoleFixtureProfile({AIHR_PERFORMANCE_ROLE_FIXTURE:'true',GITHUB_JOB:job})).toThrow();
 for(const flag of ['false','', '1'])expect(()=>performanceRoleFixtureProfile({AIHR_PERFORMANCE_ROLE_FIXTURE:flag,GITHUB_JOB:'system-http-browser-load'})).toThrow();
});
it('accepts only the same exact password-free disposable system database pair',()=>{
 const expected='postgres://postgres@127.0.0.1:5433/ai_hr_system_perf';
 expect(performanceMigrationAdmin(expected,expected)).toBe('postgres://postgres@127.0.0.1:5433/postgres');
 for(const value of [undefined,'postgres://postgres@private.example:5433/ai_hr_system_perf',expected+'?sslmode=disable',expected+'#fragment',expected.replace('5433','5432'),expected.replace('postgres@','postgres:secret@'),expected.replace('system_perf','dev')]){
  expect(()=>performanceMigrationAdmin(value,expected)).toThrow();expect(()=>performanceMigrationAdmin(expected,value)).toThrow();
 }
});

import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {vi} from 'vitest';
import {assertDisposableDraftDiscardFixture} from './helpers/personnel-draft-discard-ci-role-fixture';
it('retains the complete host/source/evidence/URL guard for both performance jobs',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-performance-admission-'));
 try{
  const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const common={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW:'alpha-focused-checks',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',TEST_DB_NAMESPACE:'aifocus',AIHR_FOCUSED_SUITE_CAPACITY:'true',AIHR_PERFORMANCE_ROLE_FIXTURE:'true',AIHR_CI_HEAD:sha,AIHR_CI_CONTROL_HEAD:sha,GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-focused-checks.yml@refs/heads/codex/performance',RUNNER_TEMP:root};
  for(const [key,value]of Object.entries(common))vi.stubEnv(key,value);
  for(const [job,basename,database]of [['system-http-browser-load','system-performance-evidence','ai_hr_system_perf'],['service-performance-profile','service-performance-evidence','ai_hr_test']]){
   const evidence=join(root,basename);mkdirSync(evidence);vi.stubEnv('GITHUB_JOB',job);vi.stubEnv('AIHR_FOCUSED_EVIDENCE_DIR',evidence);
   const migration=`postgres://postgres@127.0.0.1:5433/${database}`;vi.stubEnv('TEST_MIGRATION_DATABASE_URL',migration);vi.stubEnv('TEST_DATABASE_URL',`postgres://ai_hr_app@127.0.0.1:5433/${database}`);
   expect(()=>assertDisposableDraftDiscardFixture('postgres://postgres@127.0.0.1:5433/postgres')).not.toThrow();
   for(const [key,value]of [['RUNNER_ENVIRONMENT','self-hosted'],['GITHUB_EVENT_NAME','push'],['GITHUB_REPOSITORY','other/repo'],['AIHR_CI_HEAD','0'.repeat(40)],['AIHR_FOCUSED_EVIDENCE_DIR',root],['TEST_MIGRATION_DATABASE_URL','postgres://postgres@private.example:5433/'+database]]){
    const old=process.env[key];vi.stubEnv(key,value);expect(()=>assertDisposableDraftDiscardFixture('postgres://postgres@127.0.0.1:5433/postgres')).toThrow();vi.stubEnv(key,old);
   }
  }
 }finally{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});}
});
