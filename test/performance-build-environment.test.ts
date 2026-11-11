import {expect,it} from 'vitest';
import {systemBuildEnvironment} from '../scripts/performance/build-environment.mjs';
const memory='MemTotal:       16384000 kB\n';
const runtime={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',NODE_OPTIONS:'--max-old-space-size=4096',DATABASE_URL:'postgres://fixture@localhost/owned_fixture'};
it('admits only the existing bounded build profile and leaves runtime memory and database configuration untouched',()=>{
 const before={...runtime},{buildEnv,admission}=systemBuildEnvironment(runtime,memory);
 expect(runtime).toEqual(before);expect(runtime.NODE_OPTIONS).toBe('--max-old-space-size=4096');
 expect(buildEnv.NODE_OPTIONS).toBe('--max-old-space-size=8192');
 expect(buildEnv.AIHR_CI_BUILD_HEAP_PROFILE).toBe('hosted-linux-16g-8192');
 expect(admission).toMatchObject({heapMb:8192,releaseAuthorized:false});
 for(const name of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])expect(buildEnv[name]).toBe('postgres://nobody:nothing@127.0.0.1:1/no_database');
});
it.each([{RUNNER_ENVIRONMENT:'self-hosted'},{RUNNER_OS:'macOS'},{GITHUB_ACTIONS:'false'},{CI:'false'},{AIHR_CI_BUILD_HEAP_MB:'16384'}])('refuses an unapproved build environment %o',change=>{
 expect(()=>systemBuildEnvironment({...runtime,...change},memory)).toThrow();
});
it.each(['MemTotal: 8388608 kB\n','MemTotal: 33554432 kB\n'])('refuses a smaller or paid larger runner class',meminfo=>{
 expect(()=>systemBuildEnvironment(runtime,meminfo)).toThrow();
});
