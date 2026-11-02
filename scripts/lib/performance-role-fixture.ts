/** Finite admission for job-owned performance databases; no IO or provisioning here. */
export function performanceRoleFixtureProfile(env:Readonly<Record<string,string|undefined>>){
 if(env.AIHR_PERFORMANCE_ROLE_FIXTURE===undefined)return undefined;
 if(env.AIHR_PERFORMANCE_ROLE_FIXTURE!=='true')throw Error('Performance fixture intent refused.');
 if(env.GITHUB_JOB==='system-http-browser-load')return {evidence:'system-performance-evidence',system:true} as const;
 if(env.GITHUB_JOB==='service-performance-profile')return {evidence:'service-performance-evidence',system:false} as const;
 throw Error('Performance fixture job refused.');
}
export function performanceMigrationAdmin(target:string|undefined,testTarget:string|undefined){
 const expected='postgres://postgres@127.0.0.1:5433/ai_hr_system_perf';
 // Exact URL equality deliberately refuses credentials, queries, alternate hosts and databases.
 if(target!==expected||testTarget!==expected)throw Error('Performance migration target refused.');
 return 'postgres://postgres@127.0.0.1:5433/postgres';
}
