/** Pure orchestration: no driver, helper import, connection, filesystem or process side effects.
 * The CLI supplies the actual environment and dynamically loads the strict disposable owner only
 * after focused intent. Tests inject these owners without importing provisioning code. */
export const ROLE_FIXTURE_INPUT='test/helpers/personnel-draft-discard-ci-role-fixture.ts';
export type FocusedIntentEnvironment=Readonly<Record<string,string|undefined>>;
export function hasFocusedMigrationIntent(env:FocusedIntentEnvironment):boolean{
 return env.GITHUB_WORKFLOW==='alpha-focused-checks'||env.AIHR_FOCUSED_SUITE_CAPACITY!==undefined
  ||env.TEST_DB_NAMESPACE==='aifocus'||env.TEST_DB_NAMESPACE==='_aifocus'||env.AIHR_FOCUSED_TESTS!==undefined;
}
export type FocusedRoleOwner={
 DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT:string;
 assertDisposableDraftDiscardFixture(admin:string):void;
 prepareDisposableDraftDiscardRoles(admin:string):Promise<unknown>;
};
export type MigrationDependencies={
 loadFocusedRoleOwner():Promise<FocusedRoleOwner>;
 fingerprint(path:string):string;
 recordPrerequisites(metadata:Readonly<Record<string,unknown>>):void;
 migrate(args:readonly string[]):number;
};
export function focusedMigrationAdmin(target:string|undefined,testTarget:string|undefined):string{
 let url:URL;try{if(!target)throw Error();url=new URL(target);}catch{throw Error('Focused migration target is not the canonical disposable development database.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='5433'
  ||url.username!=='postgres'||url.password!==''||url.pathname!=='/ai_hr_dev'||url.search!==''||url.hash!=='')
  throw Error('Focused migration target is not the canonical disposable development database.');
 let test:URL;try{if(!testTarget)throw Error();test=new URL(testTarget);}catch{throw Error('Focused test migration target is unavailable.');}
 if(!['postgres:','postgresql:'].includes(test.protocol)||test.username!=='postgres'||test.password!==''||test.search!==''||test.hash!==''
  ||!/^\/ai_hr_test(?:_tpl_aifocus|_w_aifocus[1-9][0-9]*)?$/.test(test.pathname))throw Error('Focused test migration target is not canonical.');
 url.pathname='/postgres';test.pathname='/postgres';if(url.href!==test.href)throw Error('Focused migration and test clusters differ.');
 return url.toString();
}
export async function runCandidateMigration(input:{focused:boolean;migrationTarget?:string;testMigrationTarget?:string;arguments?:readonly string[]},owners:MigrationDependencies):Promise<number>{
 const args=input.arguments??[];
 if(input.focused){
  if(args.length)throw Error('Focused migration does not accept alternate CLI arguments.');
  const admin=focusedMigrationAdmin(input.migrationTarget,input.testMigrationTarget);
  const owner=await owners.loadFocusedRoleOwner();
  // Reuse the FULL existing guard, never a new relaxed or read-only provisioning fallback.
  owner.assertDisposableDraftDiscardFixture(admin);
  if(owner.DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT!==ROLE_FIXTURE_INPUT)throw Error('Unexpected focused role fixture source.');
  const helperSha256=owners.fingerprint(ROLE_FIXTURE_INPUT);
  if(!/^[0-9a-f]{64}$/.test(helperSha256))throw Error('Focused role fixture fingerprint unavailable.');
  const fixture=await owner.prepareDisposableDraftDiscardRoles(admin);
  if(!fixture||typeof fixture!=='object'||!('mode' in fixture)||fixture.mode!=='focused_disposable')throw Error('Focused role fixture did not establish disposable prerequisites.');
  owners.recordPrerequisites({kind:'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES',phase:'before_initial_candidate_migration',helperSha256,fixture,
   scope:'job-owned disposable focused cluster only; no installation or native proof attestation'});
 }
 // Ordinary migrations keep their existing engine. There is no helper load/provision outside focus.
 return owners.migrate(args);
}
