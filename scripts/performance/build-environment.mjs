/** Build-only admission: the application and database retain their measured runtime budgets. */
import {admitBuildHeap} from '../../.github/ci/build-heap.mjs';
export function systemBuildEnvironment(env,meminfo){
 const admission=admitBuildHeap({...env,AIHR_CI_BUILD_HEAP_MB:env.AIHR_CI_BUILD_HEAP_MB??'8192'},meminfo);
 const buildEnv={...env,NODE_ENV:'production',NODE_OPTIONS:admission.nodeOptions,
  AIHR_CI_BUILD_HEAP_PROFILE:admission.profile,AIHR_CI_BUILD_HEAP_MEMTOTAL_KIB:String(admission.memTotalKiB)};
 // Production compilation must never read any fixture or installation database.
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])buildEnv[key]='postgres://nobody:nothing@127.0.0.1:1/no_database';
 return {buildEnv,admission};
}
