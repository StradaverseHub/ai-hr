/** Pure input/identity validation for one fixed pre-migration qualification owner. */
export const FIXTURE_DIRECTORY='scripts/fixtures/restricted-port-operator-v4';
export const QUALIFIER='scripts/qualify-restricted-port-prerequisites.ts';
export function qualificationMode(value:unknown):boolean{
 if(value===undefined||value==='false')return false;
 if(value==='true')return true;
 throw Error('Invalid restricted-port qualification opt-in');
}
export function assertQualificationEnvironment(env:Readonly<Record<string,string|undefined>>,head:string,platform:string){
 if(!qualificationMode(env.AIHR_QUALIFY_RESTRICTED_PORT)||env.GITHUB_ACTIONS!=='true'||env.CI!=='true'
  ||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.RUNNER_OS!=='Linux'||platform!=='linux'
  ||env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'
  ||env.GITHUB_WORKFLOW!=='alpha-focused-checks'||env.GITHUB_JOB!=='selected-tests'
  ||env.TEST_DB_NAMESPACE!=='aifocus'||env.AIHR_FOCUSED_SUITE_CAPACITY!=='true'
  ||!/^\d+$/.test(env.GITHUB_RUN_ID??'')||!/^\d+$/.test(env.GITHUB_RUN_ATTEMPT??'')
  ||!env.GITHUB_WORKFLOW_REF?.startsWith('StradaverseHub/ai-hr/.github/workflows/alpha-focused-checks.yml@refs/heads/')
  ||!/^[a-f0-9]{40}$/.test(env.AIHR_CI_HEAD??'')||env.AIHR_CI_HEAD!==head
  ||!/^[a-f0-9]{40}$/.test(env.AIHR_CI_CONTROL_HEAD??'')
  ||env.AIHR_CI_PG_MEMORY_GIB!==undefined||env.AIHR_CI_PG_PROFILE!=='2'||env.AIHR_CI_PG_CONFIGURED_CAP_BYTES!=='2113929216'||env.AIHR_CI_PG_PEAK_BUDGET_BYTES!=='2147483648'||env.AIHR_CI_PG_JIT!=='on'||env.VITEST_MAX_WORKERS!=='2')throw Error('Restricted-port qualification is disposable focused CI only');
 const expected={DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'};
 for(const [key,value]of Object.entries(expected))if(env[key]!==value)throw Error('Noncanonical qualification target');
}
export type AppliedIdentity={hash:string;created_at:string};
export type LedgerRow=AppliedIdentity&{id:string};
/** Sequence allocation is not migration identity. Expected source identities have NO invented IDs.
 * Actual physical IDs must independently be positive, unique and strictly increasing. */
export function assertAppliedLedger(expected:readonly AppliedIdentity[],actual:readonly LedgerRow[]){
 const identity=(rows:readonly AppliedIdentity[])=>rows.map(r=>{
  const when=String(r.created_at);
  if(!/^[a-f0-9]{64}$/.test(r.hash)||!/^[1-9][0-9]*$/.test(when))throw Error('Invalid applied migration identity');
  return{hash:r.hash,created_at:when};
 });
 let last=BigInt(0);for(const r of actual){const id=String(r.id);if(!/^[1-9][0-9]*$/.test(id)||BigInt(id)<=last)throw Error('Invalid ordered migration surrogate ID');last=BigInt(id);}
 if(expected.length!==actual.length||JSON.stringify(identity(expected))!==JSON.stringify(identity(actual)))throw Error('Exact ordered applied migration identities differ');
}
export function assertPrefix(expected:readonly LedgerRow[],actual:readonly LedgerRow[]){
 if(expected.length!==581||actual.length!==581||String(expected.at(-1)?.created_at)!=='1793330000075')throw Error('Exact installed581 ordered ledger mismatch');
 assertAppliedLedger(expected,expected); // Authenticate observed physical ordering separately too.
 assertAppliedLedger(expected,actual);
}
